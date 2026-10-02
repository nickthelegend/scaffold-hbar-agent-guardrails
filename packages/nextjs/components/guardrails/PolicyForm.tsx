"use client";

import { useState } from "react";
import { type Address, isAddress, parseUnits } from "viem";
import { useVaultWrite } from "~~/hooks/guardrails";
import { notification } from "~~/utils/scaffold-hbar";

export type PolicyDefaults = {
  perTxUsd: string;
  dailyUsd: string;
  timelockCapUsd: string;
  vetoMinutes: string;
  anyRecipient: boolean;
};

const DEFAULTS: PolicyDefaults = {
  perTxUsd: "1",
  dailyUsd: "5",
  timelockCapUsd: "20",
  vetoMinutes: "5",
  anyRecipient: false,
};

const usd = (value: string) => parseUnits(value || "0", 6);

/** Creates or updates an agent's policy. Amounts are entered in USD; the contract converts via Chainlink. */
export const PolicyForm = ({
  vault,
  agent,
  initial,
  onDone,
}: {
  vault: Address;
  agent?: Address;
  initial?: PolicyDefaults;
  onDone?: () => void;
}) => {
  const [agentAddress, setAgentAddress] = useState<string>(agent ?? "");
  const [form, setForm] = useState<PolicyDefaults>(initial ?? DEFAULTS);
  const { write, isPending } = useVaultWrite(vault);
  const set = (key: keyof PolicyDefaults) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm(current => ({
      ...current,
      [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value,
    }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isAddress(agentAddress)) return notification.error("Enter the agent's EVM address (0x…)");
    if (usd(form.perTxUsd) > usd(form.dailyUsd))
      return notification.error("Per-payment limit must not exceed the daily limit");
    const vetoSeconds = Math.round(Number(form.vetoMinutes) * 60);
    if (!Number.isFinite(vetoSeconds) || vetoSeconds < 0)
      return notification.error("Veto window must be 0 or more minutes");

    const hash = await write("setPolicy", [
      agentAddress,
      {
        active: true,
        anyRecipient: form.anyRecipient,
        vetoWindow: vetoSeconds,
        perTxLimitUsd: usd(form.perTxUsd),
        dailyLimitUsd: usd(form.dailyUsd),
        timelockCapUsd: usd(form.timelockCapUsd),
      },
    ]);
    if (hash) onDone?.();
  };

  const field = (label: string, key: keyof PolicyDefaults, hint: string, suffix = "USD") => (
    <label className="form-control">
      <span className="label-text text-xs font-semibold">{label}</span>
      <div className="join w-full">
        <input
          className="input input-sm input-bordered join-item w-full tabular-nums"
          inputMode="decimal"
          value={String(form[key])}
          onChange={set(key)}
          required
        />
        <span className="join-item btn btn-sm btn-disabled no-animation">{suffix}</span>
      </div>
      <span className="text-[11px] text-base-content/60 mt-1">{hint}</span>
    </label>
  );

  return (
    <form onSubmit={submit} className="space-y-3">
      {!agent && (
        <label className="form-control">
          <span className="label-text text-xs font-semibold">Agent address</span>
          <input
            className="input input-sm input-bordered w-full font-mono"
            placeholder="0x… (the key your agent signs with)"
            value={agentAddress}
            onChange={event => setAgentAddress(event.target.value.trim())}
            required
          />
        </label>
      )}
      <div className="grid sm:grid-cols-2 gap-3">
        {field("Instant limit per payment", "perTxUsd", "Paid immediately at or below this")}
        {field("Instant budget per day", "dailyUsd", "Resets at 00:00 UTC")}
        {field("Timelock budget", "timelockCapUsd", "Max USD waiting in timelock at once")}
        {field("Veto window", "vetoMinutes", "0 disables the timelock lane", "min")}
      </div>
      <label className="label cursor-pointer justify-start gap-3">
        <input
          type="checkbox"
          className="toggle toggle-sm"
          checked={form.anyRecipient}
          onChange={set("anyRecipient")}
        />
        <span className="label-text text-sm">
          Allow any recipient <span className="text-base-content/60">(otherwise only allowlisted addresses)</span>
        </span>
      </label>
      <button className="btn btn-primary btn-sm" disabled={isPending}>
        {isPending ? (
          <span className="loading loading-spinner loading-xs" />
        ) : agent ? (
          "Update policy"
        ) : (
          "Authorise agent"
        )}
      </button>
    </form>
  );
};
