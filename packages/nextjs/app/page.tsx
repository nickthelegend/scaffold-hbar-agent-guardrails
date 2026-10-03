"use client";

import { useState } from "react";
import Link from "next/link";
import type { NextPage } from "next";
import { type Address, decodeEventLog, parseEther, zeroAddress } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { PriceTicker } from "~~/components/guardrails/PriceTicker";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-hbar";
import { useVaultBalance } from "~~/hooks/guardrails";
import { useDeployedContractInfo, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-hbar";
import { formatHbar, shortHex } from "~~/utils/guardrails/format";

const LANES = [
  {
    name: "Instant",
    tone: "border-success",
    rule: "Known vendor · fresh price · within per-payment and daily USD limits",
    outcome: "Paid in the same transaction.",
  },
  {
    name: "Timelock",
    tone: "border-warning",
    rule: "Known vendor · over the instant limits · within the timelock budget",
    outcome: "The vault schedules its own execution with the Hedera Schedule Service. You can veto until it fires.",
  },
  {
    name: "Approval",
    tone: "border-error",
    rule: "Unknown recipient · stale or missing oracle price · over every budget",
    outcome: "Nothing moves until you approve. A prompt-injected agent ends up here.",
  },
];

const STACK = [
  { name: "Chainlink Data Feeds", role: "HBAR/USD price that turns USD limits into tinybars, with a staleness check" },
  { name: "Hedera Schedule Service", role: "The contract schedules its own timelocked payments; no keeper or cron" },
  { name: "Hedera Consensus Service", role: "Agent publishes its reasoning; the contract stores the hash" },
  { name: "Hedera Agent Kit", role: "Drop-in plugin, so any Agent Kit agent spends through the vault" },
];

const Home: NextPage = () => {
  const { address } = useAccount();
  const { data: factory } = useDeployedContractInfo({ contractName: "AgentVaultFactory" });
  const factoryDeployed = Boolean(factory && (factory.address as string) !== zeroAddress);
  const { data: feed } = useScaffoldReadContract({ contractName: "AgentVaultFactory", functionName: "hbarUsdFeed" });
  const { data: maxPriceAge } = useScaffoldReadContract({
    contractName: "AgentVaultFactory",
    functionName: "defaultMaxPriceAge",
  });

  return (
    <div className="flex flex-col grow">
      <section className="hedera-gradient dark:bg-none dark:bg-hedera-charcoal text-white">
        <div className="max-w-5xl mx-auto px-5 py-16 space-y-6">
          <p className="uppercase tracking-[0.2em] text-xs text-white/70 m-0">
            Agent Guardrails · Scaffold-HBAR template
          </p>
          <h1 className="text-4xl md:text-5xl font-bold leading-tight m-0 max-w-3xl">
            Give your AI agent a wallet it can&apos;t drain.
          </h1>
          <p className="text-lg text-white/80 max-w-2xl m-0">
            Agents spend from an on-chain vault under USD limits that the contract enforces, not the prompt. Even a
            jailbroken agent with a stolen key can only move what your policy allows.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            {address ? (
              <a href="#vaults" className="btn btn-primary">
                Your vaults
              </a>
            ) : (
              <RainbowKitCustomConnectButton />
            )}
            <span className="rounded-full bg-white/10 px-3 py-1">
              <PriceTicker feed={feed} maxAge={maxPriceAge} />
            </span>
          </div>
        </div>
      </section>

      <section className="max-w-5xl mx-auto px-5 py-12 space-y-6 w-full">
        <h2 className="text-2xl font-bold m-0">Every payment lands in one of three lanes</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {LANES.map(lane => (
            <div key={lane.name} className={`rounded-box bg-base-100 border-t-4 ${lane.tone} shadow-sm p-5 space-y-2`}>
              <h3 className="font-bold text-lg m-0">{lane.name}</h3>
              <p className="text-sm text-base-content/70 m-0">{lane.rule}</p>
              <p className="text-sm m-0">{lane.outcome}</p>
            </div>
          ))}
        </div>
        <p className="text-sm text-base-content/70 m-0">
          Because the timelock budget refreshes once per veto window, the most an unattended agent can move in any 24
          hours is bounded and shown up front: <code>2 × dailyLimit + timelockBudget × (⌊24h ÷ vetoWindow⌋ + 1)</code>.
        </p>
      </section>

      <section id="vaults" className="bg-base-200 w-full">
        <div className="max-w-5xl mx-auto px-5 py-12 space-y-6">
          <h2 className="text-2xl font-bold m-0">Your vaults</h2>
          {!factoryDeployed ? (
            <div className="alert alert-warning text-sm">
              AgentVaultFactory is not deployed on this network yet. Run{" "}
              <code>yarn foundry:deploy --network hedera_testnet</code>.
            </div>
          ) : address ? (
            <VaultList owner={address} />
          ) : (
            <p className="text-base-content/70 m-0">Connect a wallet to create or open your vaults.</p>
          )}
        </div>
      </section>

      <section className="max-w-5xl mx-auto px-5 py-12 space-y-6 w-full">
        <h2 className="text-2xl font-bold m-0">What makes it Hedera-native</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {STACK.map(item => (
            <div key={item.name} className="rounded-box border border-base-300 p-4">
              <p className="font-semibold m-0">{item.name}</p>
              <p className="text-sm text-base-content/70 m-0">{item.role}</p>
            </div>
          ))}
        </div>
        <div className="mockup-code text-sm">
          <pre data-prefix="$">
            <code>OWNER_PRIVATE_KEY=0x… yarn agent:setup</code>
          </pre>
          <pre data-prefix="$">
            <code>yarn agent:demo --wait</code>
          </pre>
          <pre data-prefix="$">
            <code>yarn agent:chat # Claude, trying its best to spend your money</code>
          </pre>
        </div>
      </section>
    </div>
  );
};

const VaultList = ({ owner }: { owner: string }) => {
  const { data: vaults, refetch } = useScaffoldReadContract({
    contractName: "AgentVaultFactory",
    functionName: "vaultsOf",
    args: [owner],
  });
  const { writeContractAsync, isMining } = useScaffoldWriteContract({ contractName: "AgentVaultFactory" });
  const publicClient = usePublicClient();
  const { data: factory } = useDeployedContractInfo({ contractName: "AgentVaultFactory" });
  const [fund, setFund] = useState("20");
  const [created, setCreated] = useState<string>();

  const create = async () => {
    let hash: `0x${string}` | undefined;
    try {
      hash = await writeContractAsync({ functionName: "createVault", value: parseEther(fund || "0") });
    } catch {
      return; // Rejected or failed; the transactor already showed the reason.
    }
    if (!hash || !publicClient || !factory) return;
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    for (const log of receipt.logs) {
      try {
        const event = decodeEventLog({ abi: factory.abi, data: log.data, topics: log.topics });
        if (event.eventName === "VaultCreated") setCreated(event.args.vault);
      } catch {
        // Not a factory event.
      }
    }
    await refetch();
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {(vaults ?? []).map(vault => (
        <VaultTile key={vault} vault={vault} highlight={vault === created} />
      ))}
      <div className="rounded-box border border-dashed border-base-300 bg-base-100 p-5 space-y-3">
        <p className="font-semibold m-0">New vault</p>
        <p className="text-sm text-base-content/70 m-0">You become its owner. Fund it now or later.</p>
        <div className="join w-full">
          <input
            className="input input-sm input-bordered join-item w-full tabular-nums"
            inputMode="decimal"
            value={fund}
            onChange={event => setFund(event.target.value)}
            aria-label="Initial funding in HBAR"
          />
          <button className="btn btn-sm btn-primary join-item" disabled={isMining} onClick={create}>
            {isMining ? <span className="loading loading-spinner loading-xs" /> : "Create with ℏ"}
          </button>
        </div>
      </div>
    </div>
  );
};

const VaultTile = ({ vault, highlight }: { vault: string; highlight: boolean }) => {
  const { tinybars } = useVaultBalance(vault as Address);
  return (
    <Link
      href={`/vault/${vault}`}
      className={`rounded-box bg-base-100 border p-5 flex items-center justify-between hover:border-primary transition-colors ${
        highlight ? "border-primary" : "border-base-300"
      }`}
    >
      <span className="font-mono text-sm">{shortHex(vault, 6)}</span>
      <span className="font-semibold tabular-nums">{formatHbar(tinybars, 2)}</span>
    </Link>
  );
};

export default Home;
