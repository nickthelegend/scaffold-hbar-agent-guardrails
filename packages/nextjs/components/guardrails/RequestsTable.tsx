"use client";

import type { Address, Hex } from "viem";
import { LaneBadge, StateLabel } from "~~/components/guardrails/Badges";
import { useNow, useVaultRead, useVaultWrite } from "~~/hooks/guardrails";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
import type { IntentRecord, PaymentRequest } from "~~/utils/guardrails/activity";
import { entityIdFromAddress, formatDuration, formatHbar, formatUsd, shortHex } from "~~/utils/guardrails/format";

export const RequestsTable = ({
  vault,
  requests,
  intents,
  topicId,
  isOwner,
  isLoading,
}: {
  vault: Address;
  requests: PaymentRequest[];
  intents?: Map<Hex, IntentRecord>;
  topicId?: string;
  isOwner: boolean;
  isLoading: boolean;
}) => {
  if (isLoading) return <div className="h-32 rounded-box bg-base-200 animate-pulse" />;
  if (requests.length === 0) {
    return (
      <div className="rounded-box border border-dashed border-base-300 p-8 text-center text-sm text-base-content/60">
        No payment requests yet. Run <code className="font-mono">yarn agent:demo</code> to watch an agent hit all three
        lanes.
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {requests.map(request => (
        <RequestRow
          key={request.id.toString()}
          vault={vault}
          request={request}
          intent={intents?.get(request.intentHash)}
          topicId={topicId}
          isOwner={isOwner}
        />
      ))}
    </ul>
  );
};

const SETTLEMENT_LABEL: Record<PaymentRequest["state"], string> = {
  executed: "payment tx",
  vetoed: "veto tx",
  rejected: "rejection tx",
  failed: "failed execution tx",
  timelocked: "tx",
  awaitingApproval: "tx",
};

const RequestRow = ({
  vault,
  request,
  intent,
  topicId,
  isOwner,
}: {
  vault: Address;
  request: PaymentRequest;
  intent?: IntentRecord;
  topicId?: string;
  isOwner: boolean;
}) => {
  const { targetNetwork } = useTargetNetwork();
  const explorer = targetNetwork.blockExplorers?.default.url;
  const now = Math.floor(useNow() / 1000);
  const { write, isPending } = useVaultWrite(vault);
  const { data: approvalTtl } = useVaultRead(vault, "APPROVAL_TTL");

  const secondsLeft = request.executeAfter ? request.executeAfter - now : undefined;
  const windowOpen = request.state === "timelocked" && secondsLeft !== undefined && secondsLeft > 0;
  const overdue = request.state === "timelocked" && secondsLeft !== undefined && secondsLeft <= 0;
  const approvalExpired =
    request.state === "awaitingApproval" &&
    approvalTtl !== undefined &&
    now > request.requestedAt + Number(approvalTtl);

  return (
    <li className="rounded-box border border-base-300 bg-base-100 p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-mono text-xs text-base-content/60">#{request.id.toString()}</span>
        <LaneBadge lane={request.lane} />
        <span className="font-semibold tabular-nums">{formatHbar(request.amount)}</span>
        <span className="text-sm text-base-content/70 tabular-nums">
          {request.lane === "approval" && request.usdValue === 0n ? "no usable price" : formatUsd(request.usdValue)}
        </span>
        <span className="text-sm">
          → <span className="font-mono">{shortHex(request.to)}</span>
        </span>
        <span className="ml-auto">
          <StateLabel state={request.state} />
        </span>
      </div>

      <div className="mt-2 text-sm">
        {intent ? (
          <p className="m-0">
            <span className="text-base-content/60">Agent&apos;s reason: </span>“{intent.reason}”{" "}
            <a
              className="badge badge-ghost badge-sm gap-1 no-underline"
              href={`${explorer}/topic/${topicId}`}
              target="_blank"
              rel="noreferrer"
              title="keccak256 of this HCS message equals the intentHash stored on-chain"
            >
              ✓ verified on HCS #{intent.sequenceNumber}
            </a>
          </p>
        ) : (
          <p className="m-0 text-base-content/60">
            {topicId
              ? "No matching intent on the HCS topic: the agent paid without explaining itself."
              : "No intent topic configured."}
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
        <a className="link" href={`${explorer}/transaction/${request.requestTx}`} target="_blank" rel="noreferrer">
          request tx
        </a>
        {request.settledTx && request.settledTx !== request.requestTx && (
          <a className="link" href={`${explorer}/transaction/${request.settledTx}`} target="_blank" rel="noreferrer">
            {SETTLEMENT_LABEL[request.state]}
          </a>
        )}
        {request.schedule && (
          <a
            className="link"
            href={`${explorer}/schedule/${entityIdFromAddress(request.schedule)}`}
            target="_blank"
            rel="noreferrer"
          >
            Hedera schedule {entityIdFromAddress(request.schedule)}
          </a>
        )}
        {windowOpen && (
          <span className="font-semibold text-warning tabular-nums">
            auto-executes in {formatDuration(secondsLeft!)}
            {request.schedule ? " via Hedera Schedule Service" : " (no schedule: anyone can execute after)"}
          </span>
        )}

        <span className="ml-auto flex gap-2">
          {isOwner && windowOpen && (
            <button className="btn btn-error btn-xs" disabled={isPending} onClick={() => write("veto", [request.id])}>
              Veto
            </button>
          )}
          {overdue && (
            <button
              className="btn btn-outline btn-xs"
              disabled={isPending}
              title="The veto window has passed; executing is permissionless"
              onClick={() => write("executeTimelocked", [request.id])}
            >
              Execute now
            </button>
          )}
          {isOwner && request.state === "awaitingApproval" && !approvalExpired && (
            <>
              <button
                className="btn btn-success btn-xs"
                disabled={isPending}
                onClick={() => write("approve", [request.id])}
              >
                Approve
              </button>
              <button
                className="btn btn-ghost btn-xs"
                disabled={isPending}
                onClick={() => write("reject", [request.id])}
              >
                Reject
              </button>
            </>
          )}
          {approvalExpired && <span className="text-base-content/60">approval window expired</span>}
        </span>
      </div>
    </li>
  );
};
