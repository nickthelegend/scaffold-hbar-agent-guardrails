import { formatUsd } from "~~/utils/guardrails/format";

/**
 * Shows how much an agent can move in 24h with nobody watching, against what the vault holds.
 * The bound comes straight from the contract (`worstCaseDailyExposureUsd`).
 */
export const ExposureMeter = ({ exposureUsd, vaultUsd }: { exposureUsd?: bigint; vaultUsd?: bigint }) => {
  if (exposureUsd === undefined) return null;
  const ratio = vaultUsd && vaultUsd > 0n ? Math.min(1, Number(exposureUsd) / Number(vaultUsd)) : 0;
  const tone = ratio < 0.25 ? "progress-success" : ratio < 0.75 ? "progress-warning" : "progress-error";

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-base-content/70">
        <span>Worst case per day if you never look</span>
        <span className="font-semibold tabular-nums">{formatUsd(exposureUsd)}</span>
      </div>
      <progress className={`progress ${tone} w-full`} value={ratio * 100} max={100} />
      {vaultUsd !== undefined && (
        <p className="text-xs text-base-content/60 m-0">
          {Math.round(ratio * 100)}% of the {formatUsd(vaultUsd)} in this vault. Shorten exposure with a longer veto
          window or a smaller timelock budget.
        </p>
      )}
    </div>
  );
};
