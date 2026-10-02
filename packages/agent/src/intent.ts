import { keccak256, toBytes, type Address, type Hex } from "viem";

/** HCS caps a single (unchunked) message at 1024 bytes; keep the reasoning comfortably below that. */
export const MAX_REASON_LENGTH = 500;

export type Intent = {
  vault: Address;
  agent: Address;
  to: Address;
  amountTinybars: bigint;
  reason: string;
  createdAt: number;
};

/**
 * Canonical intent message: fixed key order and integer strings, so the exact bytes published to HCS hash
 * to the `intentHash` the vault stores on-chain. Anyone can re-hash a topic message and match it to a payment.
 */
export function encodeIntent(intent: Intent): string {
  return JSON.stringify({
    v: 1,
    vault: intent.vault.toLowerCase(),
    agent: intent.agent.toLowerCase(),
    to: intent.to.toLowerCase(),
    amountTinybars: intent.amountTinybars.toString(),
    reason: intent.reason.slice(0, MAX_REASON_LENGTH),
    createdAt: intent.createdAt,
  });
}

export const hashIntent = (message: string): Hex => keccak256(toBytes(message));

export type PublishedIntent = { topicId: string; sequenceNumber: number; transactionId: string };

export interface IntentPublisher {
  publish(topicId: string, message: string): Promise<PublishedIntent>;
}
