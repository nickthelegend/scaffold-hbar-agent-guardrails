import { keccak256, toBytes, type Address, type Hex } from "viem";

/** HCS caps a single (unchunked) message at 1024 bytes; larger ones are split and can't be re-hashed as one. */
export const MAX_INTENT_BYTES = 1024;

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
  const encode = (reason: string) =>
    JSON.stringify({
      v: 1,
      vault: intent.vault.toLowerCase(),
      agent: intent.agent.toLowerCase(),
      to: intent.to.toLowerCase(),
      amountTinybars: intent.amountTinybars.toString(),
      reason,
      createdAt: intent.createdAt,
    });

  // Trim the reason by code points (never splitting a character) until the UTF-8 encoding fits one message.
  let chars = Array.from(intent.reason);
  let message = encode(intent.reason);
  while (utf8Length(message) > MAX_INTENT_BYTES && chars.length > 0) {
    const excess = utf8Length(message) - MAX_INTENT_BYTES;
    chars = chars.slice(0, Math.max(0, chars.length - Math.max(1, Math.ceil(excess / 4))));
    message = encode(chars.join(""));
  }
  return message;
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

export const hashIntent = (message: string): Hex => keccak256(toBytes(message));

export type PublishedIntent = { topicId: string; sequenceNumber: number; transactionId: string };

export interface IntentPublisher {
  publish(topicId: string, message: string): Promise<PublishedIntent>;
}
