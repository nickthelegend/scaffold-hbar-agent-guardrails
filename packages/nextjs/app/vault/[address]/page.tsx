"use client";

import { use, useMemo } from "react";
import Link from "next/link";
import { type Address, getAddress, isAddress } from "viem";
import { useAccount, useBytecode } from "wagmi";
import { AgentCard } from "~~/components/guardrails/AgentCard";
import { PolicyForm } from "~~/components/guardrails/PolicyForm";
import { PriceTicker } from "~~/components/guardrails/PriceTicker";
import { RequestsTable } from "~~/components/guardrails/RequestsTable";
import { VaultControls } from "~~/components/guardrails/VaultControls";
import { HederaAddress } from "~~/components/scaffold-hbar";
import { useVaultActivity, useVaultBalance, useVaultRead } from "~~/hooks/guardrails";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { allowlistFromEvents } from "~~/utils/guardrails/activity";
import { formatHbar, formatUsd } from "~~/utils/guardrails/format";

export default function VaultPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  if (!isAddress(address)) {
    return (
      <div className="max-w-3xl mx-auto p-10 text-center">
        <p className="text-lg">“{address}” is not a vault address.</p>
        <Link href="/" className="btn btn-primary btn-sm mt-4">
          Back to your vaults
        </Link>
      </div>
    );
  }
  return <Vault vault={getAddress(address)} />;
}

const Vault = ({ vault }: { vault: Address }) => {
  const { address: connected } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  const explorer = targetNetwork.blockExplorers?.default.url;

  // Hashio answers owner() on an EOA with "0x" rather than an error, so check for contract code first and render
  // nothing that can move funds (like "Fund vault") until the address is known to be an AgentVault.
  const { data: code, isLoading: codeLoading } = useBytecode({ address: vault, chainId: targetNetwork.id });
  const { data: owner, isError: ownerError } = useVaultRead(vault, "owner");
  const { data: paused } = useVaultRead(vault, "paused");
  const { data: agents } = useVaultRead(vault, "agents");
  const { data: feed } = useVaultRead(vault, "hbarUsdFeed");
  const { data: maxPriceAge } = useVaultRead(vault, "maxPriceAge");
  const { data: intentTopic } = useVaultRead(vault, "intentTopic");
  const { tinybars } = useVaultBalance(vault);
  const { data: balanceQuote } = useVaultRead(vault, "quoteUsd", [tinybars ?? 0n]);
  const activity = useVaultActivity(vault, intentTopic);
  const allowlists = useMemo(() => allowlistFromEvents(activity.events), [activity.events]);

  const isOwner = Boolean(owner && connected && owner.toLowerCase() === connected.toLowerCase());
  const vaultUsd = balanceQuote?.[0] ? balanceQuote[1] : undefined;
  const pending = activity.requests.filter(r => r.state === "timelocked" || r.state === "awaitingApproval").length;

  const hasCode = Boolean(code && code !== "0x");
  if ((!codeLoading && !hasCode) || ownerError) {
    return (
      <div className="max-w-3xl mx-auto p-10 text-center space-y-4">
        <p className="text-lg m-0">
          No AgentVault at {vault} on {targetNetwork.name}.
        </p>
        <Link href="/" className="btn btn-primary btn-sm">
          Back to your vaults
        </Link>
      </div>
    );
  }
  if (!hasCode || !owner) {
    return (
      <div className="w-full max-w-6xl mx-auto px-4 py-8">
        <div className="h-48 rounded-box bg-base-200 animate-pulse" aria-label="Loading vault" />
      </div>
    );
  }

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-8 space-y-8">
      <section className="rounded-box bg-base-100 border border-base-300 p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wider text-base-content/60 m-0">AgentVault</p>
            <HederaAddress address={vault} chain={targetNetwork} />
            <p className="text-sm text-base-content/60 m-0 flex items-center gap-2">
              Owner {owner ? <HederaAddress address={owner} chain={targetNetwork} /> : "…"}
              {isOwner && <span className="badge badge-primary badge-sm">you</span>}
            </p>
          </div>
          <div className="text-right space-y-1">
            <p className="text-3xl font-bold tabular-nums m-0">{formatHbar(tinybars, 2)}</p>
            <p className="text-sm text-base-content/60 m-0 tabular-nums">≈ {formatUsd(vaultUsd)}</p>
            {paused && <span className="badge badge-error">Paused: all agent spending blocked</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PriceTicker feed={feed} maxAge={maxPriceAge} />
          {activity.topicId ? (
            <a className="link text-sm" href={`${explorer}/topic/${activity.topicId}`} target="_blank" rel="noreferrer">
              Intent log: HCS topic {activity.topicId}
            </a>
          ) : intentTopic === 0n ? (
            <span className="text-sm text-base-content/60">No HCS intent topic set</span>
          ) : (
            <span className="h-4 w-40 rounded bg-base-200 animate-pulse" aria-label="Loading intent topic" />
          )}
        </div>
        <VaultControls vault={vault} owner={owner} isOwner={isOwner} paused={paused} />
      </section>

      <section className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-bold m-0">Payment requests</h2>
          {pending > 0 && <span className="badge badge-warning">{pending} need attention</span>}
        </div>
        {activity.error && (
          <div className="alert alert-warning text-sm">Mirror node unavailable: {String(activity.error)}</div>
        )}
        <RequestsTable
          vault={vault}
          requests={activity.requests}
          intents={activity.intents}
          topicId={activity.topicId}
          isOwner={isOwner}
          isLoading={activity.isLoading}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-bold m-0">Agents</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {(agents ?? []).map(agent => (
            <AgentCard
              key={agent}
              vault={vault}
              agent={agent}
              recipients={allowlists.get(agent.toLowerCase() as Address) ?? []}
              isOwner={isOwner}
              vaultUsd={vaultUsd}
            />
          ))}
          {isOwner && (
            <div className="card bg-base-100 border border-dashed border-base-300">
              <div className="card-body p-5">
                <h3 className="font-semibold m-0">Authorise an agent</h3>
                <p className="text-sm text-base-content/60 m-0">
                  Limits are in USD and converted at the live Chainlink HBAR/USD price on every payment.
                </p>
                <PolicyForm vault={vault} />
              </div>
            </div>
          )}
          {agents === undefined && <div className="h-40 rounded-box bg-base-200 animate-pulse" />}
          {!isOwner && agents !== undefined && agents.length === 0 && (
            <p className="text-sm text-base-content/60">No agents authorised yet.</p>
          )}
        </div>
      </section>
    </div>
  );
};
