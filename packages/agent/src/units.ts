import { formatUnits, parseUnits } from "viem";

/**
 * Hedera has two HBAR denominations in play:
 *  - tinybars (8 decimals): what contracts see in `msg.value` / `address.balance` and what AgentVault stores.
 *  - weibars (18 decimals): what the JSON-RPC relay expects in a transaction's `value` field.
 */
export const TINYBAR_DECIMALS = 8;
export const WEIBAR_DECIMALS = 18;
export const USD_DECIMALS = 6;

export const hbarToTinybars = (hbar: string | number): bigint => parseUnits(String(hbar), TINYBAR_DECIMALS);

export const tinybarsToHbar = (tinybars: bigint): string => formatUnits(tinybars, TINYBAR_DECIMALS);

/** Value for a JSON-RPC transaction sending `hbar` HBAR. */
export const hbarToWeibars = (hbar: string | number): bigint => parseUnits(String(hbar), WEIBAR_DECIMALS);

/** `eth_getBalance` answers in weibars; contracts reason in tinybars. */
export const weibarsToTinybars = (weibars: bigint): bigint =>
  weibars / 10n ** BigInt(WEIBAR_DECIMALS - TINYBAR_DECIMALS);

export const usdToMicros = (usd: string | number): bigint => parseUnits(String(usd), USD_DECIMALS);

export const formatUsd = (micros: bigint): string => {
  const value = Number(formatUnits(micros, USD_DECIMALS));
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });
};
