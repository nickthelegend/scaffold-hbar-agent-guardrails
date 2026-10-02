import { agentVaultAbi } from "@sh/agent/abi";
import { hashIntent } from "@sh/agent/intent";
import { NETWORKS } from "@sh/agent/network";
import { LANES, type Lane } from "@sh/agent/vault";
import { type Address, type Hex, decodeEventLog } from "viem";
import { hedera } from "viem/chains";

export type { Lane };
export type RequestState = "executed" | "timelocked" | "awaitingApproval" | "vetoed" | "rejected" | "failed";

/** Pages of 100 entries fetched per refresh; logs are re-sorted chronologically after fetching. */
const MAX_PAGES = 50;

const mirrorNodeUrl = (chainId: number) => NETWORKS[chainId === hedera.id ? "mainnet" : "testnet"].mirrorNode;

export type MirrorLog = {
  data: Hex;
  topics: Hex[];
  transaction_hash: Hex;
  /** Consensus timestamp, "seconds.nanoseconds". */
  timestamp: string;
  /** Position of the log within its transaction. */
  index: number;
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
  executeAfter?: number;
  settledTx?: Hex;
  schedule?: Address;
};

export type IntentRecord = {
  message: string;
  reason: string;
  sequenceNumber: number;
  consensusTimestamp: string;
};

/** Total order of logs: consensus timestamp (to the nanosecond), then position within the transaction. */
const logOrder = (log: MirrorLog) => {
  const [seconds, nanos = "0"] = log.timestamp.split(".");
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanos.padEnd(9, "0"));
};

/** Decodes AgentVault logs in chronological order, skipping anything that is not a vault event. */
export function decodeVaultLogs(logs: MirrorLog[]): VaultEvent[] {
  const ordered = [...logs].sort((a, b) => {
    const delta = logOrder(a) - logOrder(b);
    return delta !== 0n ? (delta < 0n ? -1 : 1) : a.index - b.index;
  });
  const events: VaultEvent[] = [];
  for (const log of ordered) {
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

/** Folds the chronological event stream into one row per payment request, newest first. */
export function buildRequests(events: VaultEvent[]): PaymentRequest[] {
  const byId = new Map<bigint, PaymentRequest>();

  for (const event of events) {
    const id = event.args.id as bigint | undefined;
    if (id === undefined) continue;

    if (event.eventName === "PaymentRequested") {
      const lane = LANES[Number(event.args.lane)];
      const executeAfter = Number(event.args.executeAfter ?? 0);
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
        executeAfter: executeAfter || undefined,
      });
      continue;
    }

    const request = byId.get(id);
    if (!request) continue;
    if (event.eventName === "ExecutionScheduled") {
      request.schedule = event.args.schedule as Address;
    } else if (event.eventName in SETTLEMENT) {
      request.state = SETTLEMENT[event.eventName];
      request.settledTx = event.txHash;
    }
  }
  return [...byId.values()].sort((a, b) => (a.id > b.id ? -1 : 1));
}

/** Current allowlist per agent, replayed from chronological `RecipientSet` events (latest write wins). */
export function allowlistFromEvents(events: VaultEvent[]): Map<Address, Address[]> {
  const latest = new Map<string, { agent: Address; recipient: Address; allowed: boolean }>();
  for (const event of events) {
    if (event.eventName !== "RecipientSet") continue;
    const agent = event.args.agent as Address;
    const recipient = event.args.recipient as Address;
    latest.set(`${agent}:${recipient}`.toLowerCase(), { agent, recipient, allowed: Boolean(event.args.allowed) });
  }
  const byAgent = new Map<Address, Address[]>();
  for (const { agent, recipient, allowed } of latest.values()) {
    if (!allowed) continue;
    const key = agent.toLowerCase() as Address;
    byAgent.set(key, [...(byAgent.get(key) ?? []), recipient]);
  }
  return byAgent;
}

type TopicMessage = { message: string; sequence_number: number; consensus_timestamp: string };

/** Indexes the intent topic by keccak256(message), the hash the vault stores with each request. */
export function indexIntents(messages: TopicMessage[]): Map<Hex, IntentRecord> {
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

/** Pages through a mirror-node collection newest first, up to MAX_PAGES, so recent entries are never dropped. */
async function fetchAllPages<T>(baseUrl: string, path: string, key: string): Promise<T[]> {
  const items: T[] = [];
  let next: string | null = path;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const response = await fetch(`${baseUrl}${next}`);
    if (!response.ok) throw new Error(`Mirror node returned ${response.status}`);
    const body = (await response.json()) as Record<string, unknown> & { links?: { next: string | null } };
    items.push(...((body[key] as T[]) ?? []));
    next = body.links?.next ?? null;
  }
  return items;
}

export async function fetchVaultActivity(chainId: number, vault: Address) {
  const logs = await fetchAllPages<MirrorLog>(
    mirrorNodeUrl(chainId),
    `/api/v1/contracts/${vault}/results/logs?order=desc&limit=100`,
    "logs",
  );
  const events = decodeVaultLogs(logs);
  return { events, requests: buildRequests(events) };
}

export async function fetchIntents(chainId: number, topicId: string): Promise<Map<Hex, IntentRecord>> {
  const messages = await fetchAllPages<TopicMessage>(
    mirrorNodeUrl(chainId),
    `/api/v1/topics/${topicId}/messages?order=desc&limit=100`,
    "messages",
  );
  return indexIntents(messages);
}
