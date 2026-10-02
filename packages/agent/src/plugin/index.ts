import {
  BaseQueryTool,
  BaseTool,
  TOOL_TYPE,
  type Context,
  type Plugin,
  type ToolType,
} from "@hashgraph/hedera-agent-kit";
import type { Address } from "viem";
import { z } from "zod";
import { encodeIntent, hashIntent, type IntentPublisher, type PublishedIntent } from "../intent";
import { resolveRecipient, topicIdFromNumber } from "../mirror";
import { hashscanTopic, hashscanTx, type HederaNetwork } from "../network";
import { formatUsd, hbarToTinybars, tinybarsToHbar } from "../units";
import type { Lane, VaultGateway } from "../vault";

export const GET_POLICY_TOOL = "guardrails_get_policy";
export const PAY_TOOL = "guardrails_pay";
export const GET_REQUEST_TOOL = "guardrails_get_request";

export type GuardrailsDeps = {
  vault: VaultGateway;
  network: HederaNetwork;
  /** Publishes the reasoning behind each payment to the vault's HCS intent topic; omit to skip logging. */
  intents?: IntentPublisher;
  resolveRecipient?: (recipient: string) => Promise<Address>;
  now?: () => number;
};

const LANE_EXPLANATION: Record<Lane, string> = {
  instant: "It was within policy and has been paid.",
  timelock:
    "It exceeded the instant limits, so it is timelocked: the vault scheduled its own execution and the owner can veto it until then.",
  approval:
    "It needs the owner's explicit approval (unknown recipient, stale price, or over every budget). No funds moved.",
};

class GetPolicyTool extends BaseQueryTool {
  method = GET_POLICY_TOOL;
  name = "Get spending policy";
  description =
    "Returns the agent's on-chain spending policy in USD: per-payment and daily limits, what is left today, " +
    "the timelock budget and veto window, and the vault balance. Call this before planning purchases.";
  parameters = z.object({});

  constructor(private readonly deps: GuardrailsDeps) {
    super();
  }

  async normalizeParams() {
    return {};
  }

  async coreAction() {
    const s = await this.deps.vault.snapshot();
    const raw = {
      vault: this.deps.vault.address,
      agent: this.deps.vault.agent,
      active: s.policy.active,
      paused: s.paused,
      anyRecipient: s.policy.anyRecipient,
      perPaymentLimit: formatUsd(s.policy.perTxLimitUsd),
      dailyLimit: formatUsd(s.policy.dailyLimitUsd),
      remainingToday: formatUsd(s.remainingDailyUsd),
      timelockBudget: formatUsd(s.policy.timelockCapUsd),
      timelockedNow: formatUsd(s.pendingTimelockUsd),
      vetoWindowSeconds: s.policy.vetoWindow,
      vaultBalanceHbar: tinybarsToHbar(s.vaultBalanceTinybars),
    };
    const humanMessage = s.policy.active
      ? `Instant payments up to ${raw.perPaymentLimit} each, ${raw.remainingToday} of ${raw.dailyLimit} left today. ` +
        `Larger payments to approved recipients are timelocked for ${raw.vetoWindowSeconds}s ` +
        `(${raw.timelockedNow} of ${raw.timelockBudget} in use). Vault holds ${raw.vaultBalanceHbar} HBAR.` +
        (s.paused ? " The vault is PAUSED by its owner." : "")
      : "This agent is not authorised on the vault (no active policy).";
    return { raw, humanMessage };
  }

  async shouldSecondaryAction() {
    return false;
  }
}

const payParameters = z.object({
  to: z.string().describe("Recipient as an EVM address (0x...) or Hedera account ID (0.0.x)"),
  amountHbar: z.string().describe("Amount in HBAR, e.g. '12.5'"),
  reason: z
    .string()
    .min(1)
    .describe("Why this payment is needed. Published to the owner's audit topic and hashed on-chain."),
});

type PayParams = z.infer<typeof payParameters>;
type NormalisedPay = { to: Address; amountTinybars: bigint; reason: string };

class PayTool extends BaseTool<PayParams, NormalisedPay> {
  method = PAY_TOOL;
  name = "Pay from vault";
  description =
    "Requests an HBAR payment from the owner's AgentVault. The vault enforces the policy on-chain and answers " +
    "with a lane: 'instant' (paid now), 'timelock' (paid later unless the owner vetoes) or 'approval' (waits for " +
    "the owner). Always give a truthful reason; it is logged permanently.";
  parameters = payParameters;
  toolType: ToolType = TOOL_TYPE.TRANSACTION;

  constructor(private readonly deps: GuardrailsDeps) {
    super();
  }

  async normalizeParams(params: PayParams): Promise<NormalisedPay> {
    const resolve = this.deps.resolveRecipient ?? (r => resolveRecipient(this.deps.network, r));
    const amountTinybars = hbarToTinybars(params.amountHbar);
    if (amountTinybars <= 0n) throw new Error("amountHbar must be positive");
    return { to: await resolve(params.to), amountTinybars, reason: params.reason.trim() };
  }

  /** Builds the intent; publishing and paying happen in secondaryAction so policies can inspect it first. */
  async coreAction(params: NormalisedPay) {
    const message = encodeIntent({
      vault: this.deps.vault.address,
      agent: this.deps.vault.agent,
      to: params.to,
      amountTinybars: params.amountTinybars,
      reason: params.reason,
      createdAt: Math.floor((this.deps.now?.() ?? Date.now()) / 1000),
    });
    return { params, message, intentHash: hashIntent(message) };
  }

  async secondaryAction(
    prepared: Awaited<ReturnType<PayTool["coreAction"]>>,
    _client: unknown,
    _context: Context,
  ) {
    const { params, message, intentHash } = prepared;
    const snapshot = await this.deps.vault.snapshot();
    const topicId = topicIdFromNumber(snapshot.intentTopic);

    let published: PublishedIntent | undefined;
    if (topicId && this.deps.intents) {
      published = await this.deps.intents.publish(topicId, message);
    }

    const result = await this.deps.vault.pay(params.to, params.amountTinybars, intentHash);
    const raw = {
      requestId: result.id.toString(),
      lane: result.lane,
      to: params.to,
      amountHbar: tinybarsToHbar(params.amountTinybars),
      usdValue: formatUsd(result.usdValue),
      txHash: result.txHash,
      transaction: hashscanTx(this.deps.network, result.txHash),
      intentHash,
      intentTopic: topicId ? hashscanTopic(this.deps.network, topicId) : null,
      intentSequenceNumber: published?.sequenceNumber ?? null,
    };
    return {
      raw,
      humanMessage:
        `Payment request #${raw.requestId} for ${raw.amountHbar} HBAR (${raw.usdValue}) to ${raw.to}: ` +
        `${result.lane.toUpperCase()}. ${LANE_EXPLANATION[result.lane]} Transaction: ${raw.transaction}`,
    };
  }
}

const getRequestParameters = z.object({
  requestId: z.string().describe("Payment request ID returned by guardrails_pay"),
});

class GetRequestTool extends BaseQueryTool {
  method = GET_REQUEST_TOOL;
  name = "Get payment request";
  description =
    "Returns the current status of a payment request (executed, timelocked, vetoed, awaiting approval…).";
  parameters = getRequestParameters;

  constructor(private readonly deps: GuardrailsDeps) {
    super();
  }

  async normalizeParams(params: z.infer<typeof getRequestParameters>) {
    return { id: BigInt(params.requestId) };
  }

  async coreAction({ id }: { id: bigint }) {
    const r = await this.deps.vault.getRequest(id);
    if (r.status === "none") throw new Error(`No payment request #${id}`);
    const raw = {
      requestId: id.toString(),
      status: r.status,
      lane: r.lane,
      to: r.to,
      amountHbar: tinybarsToHbar(r.amountTinybars),
      usdValue: formatUsd(r.usdValue),
      executeAfter: r.executeAfter ? new Date(r.executeAfter * 1000).toISOString() : null,
    };
    const when = r.status === "timelocked" && raw.executeAfter ? ` (executes after ${raw.executeAfter})` : "";
    return { raw, humanMessage: `Request #${raw.requestId} is ${r.status}${when}.` };
  }

  async shouldSecondaryAction() {
    return false;
  }
}

/** Hedera Agent Kit plugin exposing an AgentVault to any Agent Kit adapter (LangChain, AI SDK, MCP, Claude). */
export const createAgentGuardrailsPlugin = (deps: GuardrailsDeps): Plugin => ({
  name: "agent-guardrails",
  version: "0.1.0",
  description: "Spend from an AgentVault under on-chain, USD-denominated policies enforced by the contract.",
  tools: () => [new GetPolicyTool(deps), new PayTool(deps), new GetRequestTool(deps)],
});
