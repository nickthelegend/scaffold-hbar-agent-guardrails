import { AgentMode } from "@hashgraph/hedera-agent-kit";
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { config as loadEnv } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ClaudeHederaToolkit } from "./claude-toolkit";
import { HcsIntentPublisher } from "./hcs";
import { accountIdForAddress } from "./mirror";
import type { HederaNetwork } from "./network";
import { createAgentGuardrailsPlugin } from "./plugin";
import { RpcVaultGateway } from "./vault";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: join(packageRoot, ".env") });

/** A missing setting. The CLIs print its message as one actionable line instead of a stack trace. */
export class ConfigError extends Error {}

// This module is only loaded by the CLIs (it is not exported from the package), so it owns their error output.
process.on("uncaughtException", error => {
  console.error(error instanceof ConfigError ? `\n${error.message}\n` : error);
  process.exit(1);
});

export function requireEnv(
  name: string,
  hint = "Copy packages/agent/.env.example to packages/agent/.env, or run `yarn agent:setup` to write it.",
): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigError(`Missing ${name}. ${hint}`);
  return value;
}

export const asHex = (key: string): Hex => (key.startsWith("0x") ? key : `0x${key}`) as Hex;

export type AgentRuntime = {
  network: HederaNetwork;
  agentAddress: Address;
  vaultAddress: Address;
  toolkit: ClaudeHederaToolkit;
  client: Client;
};

/** Wires the agent's key, its vault and the guardrails plugin from packages/agent/.env. */
export async function createAgentRuntime(): Promise<AgentRuntime> {
  const network = (process.env.HEDERA_NETWORK ?? "testnet") as HederaNetwork;
  const privateKey = asHex(requireEnv("AGENT_PRIVATE_KEY"));
  const vaultAddress = getAddress(requireEnv("VAULT_ADDRESS"));
  const account = privateKeyToAccount(privateKey);
  const accountId =
    process.env.AGENT_ACCOUNT_ID?.trim() || (await accountIdForAddress(network, account.address));

  const client = Client.forName(network).setOperator(
    accountId,
    PrivateKey.fromStringECDSA(privateKey.slice(2)),
  );
  const vault = new RpcVaultGateway(vaultAddress, account, network, process.env.HEDERA_RPC_URL || undefined);

  const toolkit = new ClaudeHederaToolkit({
    client,
    configuration: {
      plugins: [createAgentGuardrailsPlugin({ vault, network, intents: new HcsIntentPublisher(client) })],
      context: { mode: AgentMode.AUTONOMOUS, accountId },
    },
  });

  return { network, agentAddress: account.address, vaultAddress, toolkit, client };
}
