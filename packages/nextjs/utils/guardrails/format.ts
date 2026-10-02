import { formatUnits } from "viem";

/** On-chain USD amounts are 6-decimal fixed point. */
export const formatUsd = (micros: bigint | undefined, digits = 2) =>
  micros === undefined
    ? "—"
    : Number(formatUnits(micros, 6)).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: digits,
        maximumFractionDigits: Math.max(digits, 4),
      });

/** Vault amounts are tinybars (8 decimals). */
export const formatHbar = (tinybars: bigint | undefined, digits = 4) =>
  tinybars === undefined
    ? "—"
    : `${Number(formatUnits(tinybars, 8)).toLocaleString("en-US", { maximumFractionDigits: digits })} ℏ`;

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

export const shortHex = (value: string, chars = 4) => `${value.slice(0, 2 + chars)}…${value.slice(-chars)}`;

/** Hedera entities created by system contracts (e.g. schedules) have long-zero EVM addresses: 0x000…<num>. */
export const entityIdFromAddress = (address: string) => `0.0.${BigInt(address)}`;
