/**
 * Owner-side bootstrap for a demo agent, in one command:
 *   creates a vault from the deployed factory, funds it, creates + funds an agent account and a demo merchant,
 *   sets a USD policy, allowlists the merchant, creates the HCS intent topic (only the agent may submit),
 *   and writes everything the agent needs to packages/agent/.env.
 *
 * Usage: OWNER_PRIVATE_KEY=0x... yarn agent:setup
 * Optional env: VAULT_FUND_HBAR (default 100), AGENT_FUND_HBAR (5), PER_TX_USD (1), DAILY_USD (5),
 *               TIMELOCK_CAP_USD (20), VETO_WINDOW_SECONDS (300), FACTORY_ADDRESS
 * Resuming after a partial run: pass VAULT_ADDRESS (reuses the vault, no new funding), AGENT_PRIVATE_KEY and
 * AGENT_FUND_HBAR=0 (if the agent is already funded), and DEMO_MERCHANT (if it already exists).
 */
import { Client, PrivateKey, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agentVaultAbi, agentVaultFactoryAbi } from "../abi";
import { accountIdForAddress } from "../mirror";
import { NETWORKS, hashscanTopic, hederaChain, type HederaNetwork } from "../network";
import { asHex, requireEnv } from "../runtime";
import { hbarToWeibars, usdToMicros } from "../units";

const OWNER_KEY_HINT =
  "Pass the ECDSA key of a funded testnet account inline: OWNER_PRIVATE_KEY=0x… yarn agent:setup (free testnet HBAR: https://portal.hedera.com/faucet). Never commit it.";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..");
const network = (process.env.HEDERA_NETWORK ?? "testnet") as HederaNetwork;
const chain = hederaChain(network, process.env.HEDERA_RPC_URL || undefined);
const env = (name: string, fallback: string) => process.env[name]?.trim() || fallback;

function factoryAddress(): Address {
  if (process.env.FACTORY_ADDRESS) return getAddress(process.env.FACTORY_ADDRESS);
  const file = join(packageRoot, "..", "foundry", "deployments", `${NETWORKS[network].chainId}.json`);
  if (!existsSync(file)) throw new Error(`No deployment at ${file}; deploy first or set FACTORY_ADDRESS`);
  const entries = Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, string>);
  const match = entries.find(([, name]) => name === "AgentVaultFactory");
  if (!match) throw new Error(`AgentVaultFactory missing from ${file}`);
  return getAddress(match[0]);
}

const owner = privateKeyToAccount(asHex(requireEnv("OWNER_PRIVATE_KEY", OWNER_KEY_HINT)));
const publicClient = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ chain, transport: http(), account: owner });

async function send(label: string, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`  ✓ ${label}  ${NETWORKS[network].hashscan}/transaction/${hash}`);
  return receipt;
}

console.log(`Owner ${owner.address} on ${network}`);

// 1. Vault (or reuse one from a previous, partial run)
let vault: Address;
if (process.env.VAULT_ADDRESS?.trim()) {
  vault = getAddress(process.env.VAULT_ADDRESS.trim());
  console.log(`  reusing vault ${vault}`);
} else {
  const factory = factoryAddress();
  const createReceipt = await send(
    `create vault funded with ${env("VAULT_FUND_HBAR", "100")} HBAR`,
    await wallet.writeContract({
      address: factory,
      abi: agentVaultFactoryAbi,
      functionName: "createVault",
      value: hbarToWeibars(env("VAULT_FUND_HBAR", "100")),
    }),
  );
  const created = createReceipt.logs
    .filter(log => log.address.toLowerCase() === factory.toLowerCase())
    .map(log => decodeEventLog({ abi: agentVaultFactoryAbi, data: log.data, topics: log.topics }))
    .find(event => event.eventName === "VaultCreated");
  if (!created) throw new Error("VaultCreated event not found");
  vault = created.args.vault;
  console.log(`  vault ${vault}`);
}

// 2. Agent and merchant accounts (a plain HBAR transfer to a new EVM address auto-creates the account)
const agentKey = asHex(process.env.AGENT_PRIVATE_KEY?.trim() || generatePrivateKey());
const agent = privateKeyToAccount(agentKey).address;
const existingMerchant = process.env.DEMO_MERCHANT?.trim();
const merchant = getAddress(existingMerchant || privateKeyToAccount(generatePrivateKey()).address);
if (Number(env("AGENT_FUND_HBAR", "5")) > 0) {
  await send(
    `fund agent ${agent} with ${env("AGENT_FUND_HBAR", "5")} HBAR for gas`,
    await wallet.sendTransaction({ to: agent, value: hbarToWeibars(env("AGENT_FUND_HBAR", "5")) }),
  );
}
if (!existingMerchant) {
  await send(
    `create demo merchant ${merchant}`,
    await wallet.sendTransaction({ to: merchant, value: hbarToWeibars("1") }),
  );
}

// 3. Policy
const policy = {
  active: true,
  anyRecipient: false,
  vetoWindow: Number(env("VETO_WINDOW_SECONDS", "300")),
  perTxLimitUsd: usdToMicros(env("PER_TX_USD", "1")),
  dailyLimitUsd: usdToMicros(env("DAILY_USD", "5")),
  timelockCapUsd: usdToMicros(env("TIMELOCK_CAP_USD", "20")),
};
const write = (functionName: "setPolicy" | "setRecipient" | "setIntentTopic", args: readonly unknown[]) =>
  wallet.writeContract({ address: vault, abi: agentVaultAbi, functionName, args } as never);
await send("set USD policy", await write("setPolicy", [agent, policy]));
await send("allowlist demo merchant", await write("setRecipient", [agent, merchant, true]));

// 4. HCS intent topic: only the agent's key may submit, so every message is attributable to it.
const ownerAccountId =
  process.env.OWNER_ACCOUNT_ID?.trim() || (await accountIdForAddress(network, owner.address));
const hedera = Client.forName(network).setOperator(
  ownerAccountId,
  PrivateKey.fromStringECDSA(asHex(requireEnv("OWNER_PRIVATE_KEY", OWNER_KEY_HINT)).slice(2)),
);
const topicReceipt = await (
  await new TopicCreateTransaction()
    .setTopicMemo(`AgentVault intents ${vault}`)
    .setSubmitKey(PrivateKey.fromStringECDSA(agentKey.slice(2)).publicKey)
    .execute(hedera)
).getReceipt(hedera);
hedera.close();
const topicId = topicReceipt.topicId!;
console.log(`  ✓ intent topic ${topicId}  ${hashscanTopic(network, topicId.toString())}`);
await send("link intent topic", await write("setIntentTopic", [BigInt(topicId.num.toString())]));

// 5. Agent env
const agentAccountId = await accountIdForAddress(network, agent);
const envFile = join(packageRoot, ".env");
writeFileSync(
  envFile,
  [
    `HEDERA_NETWORK=${network}`,
    `VAULT_ADDRESS=${vault}`,
    `AGENT_PRIVATE_KEY=${agentKey}`,
    `AGENT_ACCOUNT_ID=${agentAccountId}`,
    `DEMO_MERCHANT=${merchant}`,
    `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ?? ""}`,
    "",
  ].join("\n"),
);
console.log(`\nWrote ${envFile}. Next: yarn agent:demo --wait   (or yarn agent:chat)`);
console.log(`Open the owner dashboard at http://localhost:3000/vault/${vault}`);
