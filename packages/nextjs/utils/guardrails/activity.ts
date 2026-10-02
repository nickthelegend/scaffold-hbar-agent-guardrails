import { agentVaultAbi } from "@sh/agent/abi";
import { hashIntent } from "@sh/agent/intent";
import { type Address, type Hex, decodeEventLog } from "viem";
import { hedera } from "viem/chains";

export const LANES = ["instant", "timelock", "approval"] as const;
export type Lane = (typeof LANES)[number];
export type RequestState = "executed" | "timelocked" | "awaitingApproval" | "vetoed" | "rejected" | "failed";

export const mirrorNodeUrl = (chainId: number) =>
  chainId === hedera.id ? "https://mainnet-public.mirrornode.hedera.com" : "https://testnet.mirrornode.hedera.com";

export type MirrorLog = {
  data: Hex;
  topics: Hex[];
  transaction_hash: Hex;
  timestamp: string;
};

export type VaultEvent = {
  eventName: string;
  args: Record<string, unknown>;
  txHash: Hex;
  timestamp: number;
};

export type PaymentRequest = {
  id: bigint;
  agent: Address;
  to: Address;
  amount: bigint;
  usdValue: bigint;
  lane: Lane;
  intentHash: Hex;
  requestedAt: number;
  requestTx: Hex;
  state: RequestState;
  settledTx?: Hex;
  schedule?: Address;
  executeAfter?: number;
};

export type IntentRecord = {
  message: string;
  reason: string;
  sequenceNumber: number;
  consensusTimestamp: string;
};

/** Decodes AgentVault logs from the mirror node, skipping anything that is not a vault event. */
export function decodeVaultLogs(logs: MirrorLog[]): VaultEvent[] {
  const events: VaultEvent[] = [];
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: agentVaultAbi,
        data: log.data,
        topics: log.topics.filter(Boolean) as [Hex, ...Hex[]],
      });
      events.push({
        eventName: decoded.eventName,
        args: (decoded.args ?? {}) as Record<string, unknown>,
        txHash: log.transaction_hash,
        timestamp: Number(log.timestamp.split(".")[0]),
      });
    } catch {
      // Unknown topic (e.g. a log from a contract the vault called).
    }
  }
  return events;
}

const SETTLEMENT: Record<string, RequestState> = {
  PaymentExecuted: "executed",
  PaymentVetoed: "vetoed",
  PaymentRejected: "rejected",
  PaymentFailed: "failed",
};

/** Folds the event stream into one row per payment request, newest first. */
export function buildRequests(events: VaultEvent[]): PaymentRequest[] {
  const byId = new Map<bigint, PaymentRequest>();
  const chronological = [...events].sort((a, b) => a.timestamp - b.timestamp);

  for (const event of chronological) {
    const id = event.args.id as bigint | undefined;
    if (id === undefined) continue;

    if (event.eventName === "PaymentRequested") {
      const lane = LANES[Number(event.args.lane)];
      byId.set(id, {
        id,
        agent: event.args.agent as Address,
        to: event.args.to as Address,
        amount: event.args.amount as bigint,
        usdValue: event.args.usdValue as bigint,
        lane,
        intentHash: event.args.intentHash as Hex,
        requestedAt: event.timestamp,
        requestTx: event.txHash,
        state: lane === "timelock" ? "timelocked" : lane === "approval" ? "awaitingApproval" : "executed",
        settledTx: lane === "instant" ? event.txHash : undefined,
      });
      continue;
    }

    const request = byId.get(id);
    if (!request) continue;
    if (event.eventName === "ExecutionScheduled") {
      request.schedule = event.args.schedule as Address;
      request.executeAfter = Number(event.args.executeAfter);
    } else if (event.eventName in SETTLEMENT) {
      request.state = SETTLEMENT[event.eventName];
      request.settledTx = event.txHash;
    }
  }
  return [...byId.values()].sort((a, b) => (a.id > b.id ? -1 : 1));
}

/** Indexes the intent topic by keccak256(message), the hash the vault stores with each request. */
export function indexIntents(
  messages: { message: string; sequence_number: number; consensus_timestamp: string }[],
): Map<Hex, IntentRecord> {
  const index = new Map<Hex, IntentRecord>();
  for (const entry of messages) {
    const message = Buffer.from(entry.message, "base64").toString("utf8");
    let reason = "";
    try {
      reason = String(JSON.parse(message).reason ?? "");
    } catch {
      continue; // Not an intent message.
    }
    index.set(hashIntent(message), {
      message,
      reason,
      sequenceNumber: entry.sequence_number,
      consensusTimestamp: entry.consensus_timestamp,
    });
  }
  return index;
}

export async function fetchVaultEvents(chainId: number, vault: Address): Promise<VaultEvent[]> {
  const response = await fetch(`${mirrorNodeUrl(chainId)}/api/v1/contracts/${vault}/results/logs?order=desc&limit=100`);
  if (!response.ok) throw new Error(`Mirror node returned ${response.status}`);
  const body = (await response.json()) as { logs: MirrorLog[] };
  return decodeVaultLogs(body.logs ?? []);
}

export async function fetchIntents(chainId: number, topicId: string): Promise<Map<Hex, IntentRecord>> {
  const response = await fetch(`${mirrorNodeUrl(chainId)}/api/v1/topics/${topicId}/messages?order=desc&limit=100`);
  if (!response.ok) throw new Error(`Mirror node returned ${response.status}`);
  const body = (await response.json()) as {
    messages: { message: string; sequence_number: number; consensus_timestamp: string }[];
  };
  return indexIntents(body.messages ?? []);
}

/** Current allowlist per agent, replayed from `RecipientSet` events (latest write wins). */
export function allowlistFromEvents(events: VaultEvent[]): Map<Address, Address[]> {
  const latest = new Map<string, { agent: Address; recipient: Address; allowed: boolean; at: number }>();
  for (const event of events) {
    if (event.eventName !== "RecipientSet") continue;
    const agent = event.args.agent as Address;
    const recipient = event.args.recipient as Address;
    const key = `${agent}:${recipient}`.toLowerCase();
    const previous = latest.get(key);
    if (!previous || previous.at <= event.timestamp) {
      latest.set(key, { agent, recipient, allowed: Boolean(event.args.allowed), at: event.timestamp });
    }
  }
  const byAgent = new Map<Address, Address[]>();
  for (const { agent, recipient, allowed } of latest.values()) {
    if (!allowed) continue;
    const key = agent.toLowerCase() as Address;
    byAgent.set(key, [...(byAgent.get(key) ?? []), recipient]);
  }
  return byAgent;
}
