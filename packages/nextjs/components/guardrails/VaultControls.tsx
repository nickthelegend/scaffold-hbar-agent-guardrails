"use client";

import { useState } from "react";
import { type Address, parseEther, parseUnits } from "viem";
import { useSendTransaction } from "wagmi";
import { useVaultWrite } from "~~/hooks/guardrails";
import { useTargetNetwork, useTransactor } from "~~/hooks/scaffold-hbar";

/** Owner controls: fund (anyone can), withdraw, and the kill switch. */
export const VaultControls = ({
  vault,
  owner,
  isOwner,
  paused,
}: {
  vault: Address;
  owner?: Address;
  isOwner: boolean;
  paused?: boolean;
}) => {
  const [fundAmount, setFundAmount] = useState("10");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const { write, isPending } = useVaultWrite(vault);
  const { sendTransactionAsync, isPending: isFunding } = useSendTransaction();
  const transactor = useTransactor();
  const { targetNetwork } = useTargetNetwork();

  // The JSON-RPC relay takes value in weibars (18 decimals); the contract sees tinybars.
  const fund = async () => {
    try {
      await transactor(() =>
        sendTransactionAsync({ to: vault, value: parseEther(fundAmount), chainId: targetNetwork.id }),
      );
    } catch {
      // Rejected or failed; the transactor already showed the reason.
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <div className="space-y-2">
        <p className="text-xs uppercase tracking-wider text-base-content/60 m-0">Fund vault</p>
        <div className="join w-full">
          <input
            className="input input-sm input-bordered join-item w-full tabular-nums"
            inputMode="decimal"
            value={fundAmount}
            onChange={event => setFundAmount(event.target.value)}
          />
          <button
            className="btn btn-sm btn-primary join-item"
            disabled={isFunding || !(Number(fundAmount) > 0)}
            onClick={fund}
          >
            Send ℏ
          </button>
        </div>
      </div>

      {isOwner && owner && (
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-base-content/60 m-0">Withdraw to owner</p>
          <div className="join w-full">
            <input
              className="input input-sm input-bordered join-item w-full tabular-nums"
              inputMode="decimal"
              placeholder="HBAR"
              value={withdrawAmount}
              onChange={event => setWithdrawAmount(event.target.value)}
            />
            <button
              className="btn btn-sm join-item"
              disabled={isPending || !(Number(withdrawAmount) > 0)}
              onClick={() => write("withdraw", [owner, parseUnits(withdrawAmount, 8)])}
            >
              Withdraw
            </button>
          </div>
        </div>
      )}

      {isOwner && (
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-base-content/60 m-0">Kill switch</p>
          <button
            className={`btn btn-sm w-full ${paused ? "btn-success" : "btn-error"}`}
            disabled={isPending}
            onClick={() => write("setPaused", [!paused])}
          >
            {paused ? "Resume all agents" : "Pause all agents"}
          </button>
        </div>
      )}
    </div>
  );
};
