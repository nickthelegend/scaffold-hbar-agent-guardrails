"use client";

import type { Address } from "viem";
import { useHbarUsdPrice } from "~~/hooks/guardrails";
import { formatDuration } from "~~/utils/guardrails/format";

/** Live Chainlink HBAR/USD answer, flagged when older than the vault's freshness limit. */
export const PriceTicker = ({ feed, maxAge }: { feed: Address | undefined; maxAge?: bigint }) => {
  const price = useHbarUsdPrice(feed);
  if (!price) return <span className="loading loading-dots loading-xs" aria-label="Loading price" />;

  const stale = maxAge !== undefined && BigInt(price.ageSeconds) > maxAge;
  return (
    <span className="inline-flex items-center gap-2 text-sm" title="Chainlink HBAR/USD data feed">
      <span className={`h-2 w-2 rounded-full ${stale ? "bg-error" : "bg-success"}`} aria-hidden />
      <span className="font-semibold tabular-nums">1 ℏ = ${price.price.toFixed(4)}</span>
      <span className="text-base-content/60">
        Chainlink · {formatDuration(price.ageSeconds)} ago{stale ? " · stale: payments need approval" : ""}
      </span>
    </span>
  );
};
