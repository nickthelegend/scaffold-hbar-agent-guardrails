"use client";

import { useState } from "react";
import { type Address, formatUnits, isAddress } from "viem";
import { ExposureMeter } from "~~/components/guardrails/ExposureMeter";
import { PolicyForm } from "~~/components/guardrails/PolicyForm";
import { HederaAddress } from "~~/components/scaffold-hbar";
import { useVaultRead, useVaultWrite } from "~~/hooks/guardrails";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { formatDuration, formatUsd } from "~~/utils/guardrails/format";

const toInput = (micros: bigint) => formatUnits(micros, 6);

export const AgentCard = ({
  vault,
  agent,
  recipients,
  isOwner,
  vaultUsd,
}: {
  vault: Address;
  agent: Address;
  recipients: Address[];
  isOwner: boolean;
  vaultUsd?: bigint;
}) => {
  const { targetNetwork } = useTargetNetwork();
  const { data: policy } = useVaultRead(vault, "policies", [agent]);
  const { data: remaining } = useVaultRead(vault, "remainingDailyUsd", [agent]);
  const { data: pending } = useVaultRead(vault, "pendingTimelockUsd", [agent]);
  const { data: exposure } = useVaultRead(vault, "worstCaseDailyExposureUsd", [agent]);
  const { write, isPending } = useVaultWrite(vault);
  const [editing, setEditing] = useState(false);
  const [recipient, setRecipient] = useState("");

  if (!policy) return <div className="card bg-base-100 shadow-sm h-48 animate-pulse" />;
  const [active, anyRecipient, vetoWindow, perTx, daily, timelockCap] = policy;

  return (
    <div className={`card bg-base-100 shadow-sm border ${active ? "border-base-300" : "border-dashed opacity-70"}`}>
      <div className="card-body p-5 gap-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-wider text-base-content/60 m-0">Agent</p>
            <HederaAddress address={agent} chain={targetNetwork} />
          </div>
          <span className={`badge ${active ? "badge-success" : "badge-ghost"}`}>{active ? "Active" : "Revoked"}</span>
        </div>

        {active && (
          <>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="Instant per payment" value={formatUsd(perTx)} />
              <Stat label="Left today" value={`${formatUsd(remaining)} / ${formatUsd(daily)}`} />
              <Stat label="Timelocked now" value={`${formatUsd(pending)} / ${formatUsd(timelockCap)}`} />
              <Stat label="Veto window" value={vetoWindow ? formatDuration(vetoWindow) : "off"} />
            </div>
            <ExposureMeter exposureUsd={exposure} vaultUsd={vaultUsd} />
          </>
        )}

        <div>
          <p className="text-xs uppercase tracking-wider text-base-content/60 mb-2">
            {anyRecipient ? "Any recipient allowed" : `Allowlisted recipients (${recipients.length})`}
          </p>
          {!anyRecipient && (
            <ul className="space-y-1">
              {recipients.length === 0 && (
                <li className="text-sm text-base-content/60">None yet: every payment needs your approval.</li>
              )}
              {recipients.map(address => (
                <li key={address} className="flex items-center justify-between gap-2">
                  <HederaAddress address={address} chain={targetNetwork} />
                  {isOwner && (
                    <button
                      className="btn btn-ghost btn-xs"
                      disabled={isPending}
                      onClick={() => write("setRecipient", [agent, address, false])}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {isOwner && !anyRecipient && (
            <form
              className="join w-full mt-2"
              onSubmit={async event => {
                event.preventDefault();
                if (!isAddress(recipient)) return;
                if (await write("setRecipient", [agent, recipient, true])) setRecipient("");
              }}
            >
              <input
                className="input input-sm input-bordered join-item w-full font-mono"
                placeholder="0x… vendor address"
                value={recipient}
                onChange={event => setRecipient(event.target.value.trim())}
              />
              <button className="btn btn-sm join-item" disabled={!isAddress(recipient) || isPending}>
                Allow
              </button>
            </form>
          )}
        </div>

        {isOwner && (
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-sm btn-outline" onClick={() => setEditing(value => !value)}>
              {editing ? "Close" : active ? "Edit policy" : "Re-authorise"}
            </button>
            {active && (
              <button
                className="btn btn-sm btn-ghost text-error"
                disabled={isPending}
                onClick={() => write("revokeAgent", [agent])}
              >
                Revoke
              </button>
            )}
          </div>
        )}
        {editing && (
          <PolicyForm
            vault={vault}
            agent={agent}
            initial={{
              perTxUsd: toInput(perTx),
              dailyUsd: toInput(daily),
              timelockCapUsd: toInput(timelockCap),
              vetoMinutes: String(vetoWindow / 60),
              anyRecipient,
            }}
            onDone={() => setEditing(false)}
          />
        )}
      </div>
    </div>
  );
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div>
    <p className="text-[11px] uppercase tracking-wider text-base-content/60 m-0">{label}</p>
    <p className="font-semibold tabular-nums m-0">{value}</p>
  </div>
);
