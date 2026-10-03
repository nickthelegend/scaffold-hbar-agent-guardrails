import { useEffect, useState } from "react";
import { agentVaultAbi } from "@sh/agent/abi";
import { topicIdFromNumber } from "@sh/agent/mirror";
import { weibarsToTinybars } from "@sh/agent/units";
import { useQuery } from "@tanstack/react-query";
import type { Abi, Address, ContractFunctionArgs, ContractFunctionName } from "viem";
import {
  type UseReadContractReturnType,
  useAccount,
  useBalance,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from "wagmi";
import { useTargetNetwork, useTransactor } from "~~/hooks/scaffold-hbar";
import { fetchIntents, fetchVaultActivity } from "~~/utils/guardrails/activity";

const POLL_MS = 8_000;

const chainlinkFeedAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const satisfies Abi;

type VaultReadName = ContractFunctionName<typeof agentVaultAbi, "view" | "pure">;

/** Typed read against a vault whose address is only known at runtime. */
export function useVaultRead<
  const TName extends VaultReadName,
  const TArgs extends ContractFunctionArgs<typeof agentVaultAbi, "view" | "pure", TName>,
>(vault: Address, functionName: TName, args?: TArgs) {
  const { targetNetwork } = useTargetNetwork();
  return useReadContract({
    address: vault,
    abi: agentVaultAbi,
    functionName,
    args,
    chainId: targetNetwork.id,
    query: { refetchInterval: POLL_MS },
  } as never) as UseReadContractReturnType<typeof agentVaultAbi, TName, TArgs>;
}

/** The vault's HBAR balance in tinybars (the relay reports weibars). */
export function useVaultBalance(vault: Address) {
  const { targetNetwork } = useTargetNetwork();
  const { data, ...rest } = useBalance({
    address: vault,
    chainId: targetNetwork.id,
    query: { refetchInterval: POLL_MS },
  });
  return { tinybars: data ? weibarsToTinybars(data.value) : undefined, ...rest };
}

type HbarUsdPrice = { price: number; updatedAt: number; ageSeconds: number };

export function useHbarUsdPrice(feed: Address | undefined) {
  const { targetNetwork } = useTargetNetwork();
  const now = useNow(30_000);
  const round = useReadContract({
    address: feed,
    abi: chainlinkFeedAbi,
    functionName: "latestRoundData",
    chainId: targetNetwork.id,
    query: { enabled: Boolean(feed), refetchInterval: 30_000 },
  });
  const decimals = useReadContract({
    address: feed,
    abi: chainlinkFeedAbi,
    functionName: "decimals",
    chainId: targetNetwork.id,
    query: { enabled: Boolean(feed) },
  });
  if (!round.data || decimals.data === undefined) return undefined;
  const updatedAt = Number(round.data[3]);
  return {
    price: Number(round.data[1]) / 10 ** decimals.data,
    updatedAt,
    ageSeconds: Math.max(0, Math.floor(now / 1000) - updatedAt),
  } satisfies HbarUsdPrice;
}

/** Payment requests (from vault events) joined with the agent's published intents (from HCS). */
export function useVaultActivity(vault: Address, intentTopic: bigint | undefined) {
  const { targetNetwork } = useTargetNetwork();
  const topicId = intentTopic !== undefined ? (topicIdFromNumber(intentTopic) ?? undefined) : undefined;

  const activity = useQuery({
    queryKey: ["vault-activity", targetNetwork.id, vault],
    queryFn: () => fetchVaultActivity(targetNetwork.id, vault),
    refetchInterval: POLL_MS,
  });
  const intents = useQuery({
    queryKey: ["vault-intents", targetNetwork.id, topicId],
    queryFn: () => fetchIntents(targetNetwork.id, topicId!),
    enabled: Boolean(topicId),
    refetchInterval: POLL_MS,
  });

  return {
    events: activity.data?.events ?? NO_EVENTS,
    requests: activity.data?.requests ?? NO_REQUESTS,
    intents: intents.data,
    topicId,
    isLoading: activity.isLoading,
    error: activity.error ?? intents.error,
  };
}

const NO_EVENTS: Awaited<ReturnType<typeof fetchVaultActivity>>["events"] = [];
const NO_REQUESTS: Awaited<ReturnType<typeof fetchVaultActivity>>["requests"] = [];

type VaultWriteName = ContractFunctionName<typeof agentVaultAbi, "nonpayable" | "payable">;

/**
 * The relay's eth_estimateGas undercounts calls that reach Hedera system contracts (e.g. `veto` deleting its
 * schedule used 111k gas against a 66k estimate), so vault writes send twice the estimate.
 */
export const GAS_ESTIMATE_MULTIPLIER = 2n;

/** Writes to a vault with the scaffold's transaction notifications. */
export function useVaultWrite(vault: Address) {
  const { writeContractAsync, isPending } = useWriteContract();
  const transactor = useTransactor();
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient({ chainId: targetNetwork.id });
  const { address: account } = useAccount();

  /** Resolves to the tx hash, or undefined if the user rejected or it failed (already shown as a notification). */
  const write = async <const TName extends VaultWriteName>(
    functionName: TName,
    args: ContractFunctionArgs<typeof agentVaultAbi, "nonpayable" | "payable", TName>,
  ) => {
    const call = { address: vault, abi: agentVaultAbi, functionName, args } as never;
    try {
      return await transactor(async () => {
        const estimate = await publicClient!.estimateContractGas({ ...(call as object), account } as never);
        return writeContractAsync({
          ...(call as object),
          chainId: targetNetwork.id,
          gas: estimate * GAS_ESTIMATE_MULTIPLIER,
        } as never);
      });
    } catch {
      return undefined;
    }
  };

  return { write, isPending };
}

/** Wall-clock time that re-renders every `intervalMs`, for countdowns and freshness labels. */
export function useNow(intervalMs = 1_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
