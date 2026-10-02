import type { Lane, RequestState } from "~~/utils/guardrails/activity";

const LANE_STYLE: Record<Lane, { label: string; className: string; hint: string }> = {
  instant: { label: "Instant", className: "badge-success", hint: "Within policy, paid immediately" },
  timelock: { label: "Timelock", className: "badge-warning", hint: "Over instant limits, owner can veto" },
  approval: { label: "Approval", className: "badge-error", hint: "Needs the owner's explicit decision" },
};

export const LaneBadge = ({ lane }: { lane: Lane }) => {
  const style = LANE_STYLE[lane];
  return (
    <span className={`badge badge-sm font-semibold ${style.className}`} title={style.hint}>
      {style.label}
    </span>
  );
};

const STATE_STYLE: Record<RequestState, { label: string; className: string }> = {
  executed: { label: "Paid", className: "text-success" },
  timelocked: { label: "Waiting out veto window", className: "text-warning" },
  awaitingApproval: { label: "Awaiting your approval", className: "text-error" },
  vetoed: { label: "Vetoed", className: "text-base-content/60" },
  rejected: { label: "Rejected", className: "text-base-content/60" },
  failed: { label: "Failed (insufficient balance or recipient refused)", className: "text-error" },
};

export const StateLabel = ({ state }: { state: RequestState }) => (
  <span className={`text-sm font-medium ${STATE_STYLE[state].className}`}>{STATE_STYLE[state].label}</span>
);
