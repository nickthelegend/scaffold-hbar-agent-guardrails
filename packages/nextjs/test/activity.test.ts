import { agentVaultAbi } from "@sh/agent/abi";
import { encodeIntent, hashIntent } from "@sh/agent/intent";
import { type Hex, encodeAbiParameters, encodeEventTopics, getAbiItem } from "viem";
import { describe, expect, it } from "vitest";
import {
  type MirrorLog,
  allowlistFromEvents,
  buildRequests,
  decodeVaultLogs,
  indexIntents,
} from "~~/utils/guardrails/activity";
import { entityIdFromAddress, formatDuration, formatHbar, formatUsd } from "~~/utils/guardrails/format";

const AGENT = "0x00000000000000000000000000000000000a9e17";
const SHOP = "0x0000000000000000000000000000000000c0ffee";
const SCHEDULE = "0x0000000000000000000000000000000000a1b2c3";
const INTENT = `0x${"11".repeat(32)}` as Hex;

/** Encodes a vault event exactly as the mirror node serves it. */
function log(eventName: string, args: Record<string, unknown>, timestamp: number, tx = "aa"): MirrorLog {
  const event = getAbiItem({ abi: agentVaultAbi, name: eventName as never }) as {
    inputs: { name: string; type: string; indexed?: boolean }[];
  };
  const topics = encodeEventTopics({ abi: agentVaultAbi, eventName: eventName as never, args: args as never });
  const dataInputs = event.inputs.filter(input => !input.indexed);
  return {
    topics: topics as Hex[],
    data: encodeAbiParameters(dataInputs, dataInputs.map(input => args[input.name]) as never),
    transaction_hash: `0x${tx.repeat(32)}` as Hex,
    timestamp: `${timestamp}.000000001`,
  };
}

const requested = (id: bigint, lane: number, timestamp: number) =>
  log(
    "PaymentRequested",
    { id, agent: AGENT, to: SHOP, amount: 500_000_000n, usdValue: 500_000n, lane, intentHash: INTENT },
    timestamp,
  );

describe("buildRequests", () => {
  it("derives each request's state from the event stream", () => {
    const events = decodeVaultLogs([
      requested(1n, 0, 100),
      requested(2n, 1, 110),
      log("ExecutionScheduled", { id: 2n, schedule: SCHEDULE, executeAfter: 410n }, 110),
      requested(3n, 1, 120),
      log("PaymentVetoed", { id: 3n }, 130),
      requested(4n, 2, 140),
      log("PaymentExecuted", { id: 2n, to: SHOP, amount: 500_000_000n }, 410, "bb"),
    ]);

    const requests = buildRequests(events);

    expect(requests.map(r => [r.id, r.state])).toEqual([
      [4n, "awaitingApproval"],
      [3n, "vetoed"],
      [2n, "executed"],
      [1n, "executed"],
    ]);
    const timelocked = requests.find(r => r.id === 2n)!;
    expect(timelocked.lane).toBe("timelock");
    expect(timelocked.executeAfter).toBe(410);
    expect(timelocked.schedule?.toLowerCase()).toBe(SCHEDULE);
    expect(timelocked.settledTx).toBe(`0x${"bb".repeat(32)}`);
  });

  it("ignores logs that are not vault events", () => {
    const foreign: MirrorLog = {
      topics: [`0x${"ff".repeat(32)}`],
      data: "0x",
      transaction_hash: "0x00",
      timestamp: "1.0",
    };
    expect(decodeVaultLogs([foreign])).toEqual([]);
  });
});

describe("allowlistFromEvents", () => {
  it("replays RecipientSet so the latest write wins", () => {
    const events = decodeVaultLogs([
      log("RecipientSet", { agent: AGENT, recipient: SHOP, allowed: true }, 100),
      log("RecipientSet", { agent: AGENT, recipient: SCHEDULE, allowed: true }, 101),
      log("RecipientSet", { agent: AGENT, recipient: SCHEDULE, allowed: false }, 102),
    ]);
    const allowlist = allowlistFromEvents(events).get(AGENT);
    expect(allowlist?.map(address => address.toLowerCase())).toEqual([SHOP]);
  });
});

describe("indexIntents", () => {
  it("keys HCS messages by the keccak256 the vault stores on-chain", () => {
    const message = encodeIntent({
      vault: SCHEDULE,
      agent: AGENT,
      to: SHOP,
      amountTinybars: 1n,
      reason: "coffee",
      createdAt: 1,
    });
    const index = indexIntents([
      { message: Buffer.from(message).toString("base64"), sequence_number: 7, consensus_timestamp: "1.0" },
      { message: Buffer.from("not json").toString("base64"), sequence_number: 8, consensus_timestamp: "2.0" },
    ]);
    expect(index.size).toBe(1);
    expect(index.get(hashIntent(message))).toMatchObject({ reason: "coffee", sequenceNumber: 7 });
  });
});

describe("formatting", () => {
  it("formats units used across the dashboard", () => {
    expect(formatUsd(1_500_000n)).toBe("$1.50");
    expect(formatHbar(250_000_000n)).toBe("2.5 ℏ");
    expect(formatDuration(3_725)).toBe("1h 2m");
    expect(formatDuration(65)).toBe("1m 05s");
    expect(entityIdFromAddress(SCHEDULE)).toBe("0.0.10597059");
  });
});
