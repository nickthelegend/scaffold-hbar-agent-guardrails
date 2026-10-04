"use client";

import type { Address } from "viem";
import { formatUnits } from "viem";
import { useBalance } from "wagmi";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";

/**
 * The connected account's HBAR balance. Replaces the UI kit's `Balance`, whose USD toggle fetches a third-party
 * price API on every page load and fails with CORS in the browser.
 */
export const HbarBalance = ({ address }: { address: Address }) => {
  const { targetNetwork } = useTargetNetwork();
  const { data, isLoading } = useBalance({ address, chainId: targetNetwork.id });
  if (isLoading || !data) return <div className="h-3 w-16 rounded bg-base-300 animate-pulse" />;
  // The relay reports balances in weibars (18 decimals), like any EVM chain.
  const hbar = Number(formatUnits(data.value, data.decimals));
  return (
    <span className="text-[0.8em] tabular-nums">
      {hbar.toLocaleString("en-US", { maximumFractionDigits: 4 })} {targetNetwork.nativeCurrency.symbol}
    </span>
  );
};
