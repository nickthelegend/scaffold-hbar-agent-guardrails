import { getAddress, isAddress, type Address } from "viem";
import { NETWORKS, type HederaNetwork } from "./network";

const ACCOUNT_ID = /^0\.0\.\d+$/;

type MirrorAccount = { account: string; evm_address: string | null };

/** Resolves `0x…` or `0.0.x` to the EVM address contracts see for that account. */
export async function resolveRecipient(network: HederaNetwork, recipient: string): Promise<Address> {
  const value = recipient.trim();
  if (isAddress(value)) return getAddress(value);
  if (!ACCOUNT_ID.test(value))
    throw new Error(`"${recipient}" is neither an EVM address nor a 0.0.x account ID`);

  const response = await fetch(`${NETWORKS[network].mirrorNode}/api/v1/accounts/${value}`);
  if (!response.ok)
    throw new Error(`Account ${value} not found on ${network} (mirror node ${response.status})`);
  const account = (await response.json()) as MirrorAccount;
  if (!account.evm_address) throw new Error(`Account ${value} has no EVM address`);
  return getAddress(account.evm_address);
}

/** Looks up the 0.0.x ID for an EVM address (used to configure the agent's Hedera SDK client). */
export async function accountIdForAddress(network: HederaNetwork, address: Address): Promise<string> {
  const response = await fetch(`${NETWORKS[network].mirrorNode}/api/v1/accounts/${address}`);
  if (!response.ok) throw new Error(`No Hedera account for ${address} on ${network}; fund it first`);
  return ((await response.json()) as MirrorAccount).account;
}

/** Formats a topic number stored on-chain (shard and realm 0) as a Hedera topic ID. */
export const topicIdFromNumber = (topic: bigint): string | null => (topic > 0n ? `0.0.${topic}` : null);
