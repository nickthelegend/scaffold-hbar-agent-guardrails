import { AbstractPolicy, type PostParamsNormalizationParams } from "@hashgraph/hedera-agent-kit";
import { Client } from "@hiero-ledger/sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ClaudeHederaToolkit } from "../src/claude-toolkit";
import { hashIntent } from "../src/intent";
import {
  createAgentGuardrailsPlugin,
  GET_POLICY_TOOL,
  GET_REQUEST_TOOL,
  PAY_TOOL,
  type GuardrailsDeps,
} from "../src/plugin";
import { hbarToTinybars } from "../src/units";
import { FakePublisher, FakeVault, MERCHANT } from "./fakes";

const client = Client.forTestnet();
afterAll(() => client.close());

let vault: FakeVault;
let publisher: FakePublisher;

const toolkit = (deps: Partial<GuardrailsDeps> = {}, hooks: AbstractPolicy[] = []) =>
  new ClaudeHederaToolkit({
    client,
    configuration: {
      plugins: [
        createAgentGuardrailsPlugin({
          vault,
          network: "testnet",
          intents: publisher,
          now: () => 1_790_000_000_000,
          ...deps,
        }),
      ],
      context: { hooks },
    },
  });

beforeEach(() => {
  vault = new FakeVault();
  publisher = new FakePublisher();
});

describe("guardrails_pay", () => {
  it("publishes the intent to the vault's topic and pays with the matching hash", async () => {
    const result = await toolkit().run(PAY_TOOL, { to: MERCHANT, amountHbar: "2", reason: "coffee beans" });

    expect(result.raw.status).toBe("SUCCESS");
    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0].topicId).toBe("0.0.4242");
    expect(vault.payments[0].intentHash).toBe(hashIntent(publisher.published[0].message));
    expect(vault.payments[0].amountTinybars).toBe(hbarToTinybars("2"));
    expect(result.humanMessage).toContain("INSTANT");
  });

  it("explains timelocked and approval lanes to the model", async () => {
    vault.laneFor = amount => (amount > hbarToTinybars("10") ? "approval" : "timelock");
    const timelock = await toolkit().run(PAY_TOOL, { to: MERCHANT, amountHbar: "5", reason: "bulk order" });
    const approval = await toolkit().run(PAY_TOOL, { to: MERCHANT, amountHbar: "50", reason: "new address" });

    expect(timelock.humanMessage).toMatch(/TIMELOCK.*veto/);
    expect(approval.humanMessage).toMatch(/APPROVAL.*No funds moved/);
  });

  it("still pays when the vault has no intent topic, without publishing", async () => {
    vault.intentTopic = 0n;
    const result = await toolkit().run(PAY_TOOL, { to: MERCHANT, amountHbar: "1", reason: "stamps" });

    expect(result.raw.status).toBe("SUCCESS");
    expect(publisher.published).toHaveLength(0);
    expect(result.raw.intentTopic).toBeNull();
  });

  it("resolves Hedera account IDs to EVM addresses", async () => {
    await toolkit({ resolveRecipient: async () => MERCHANT }).run(PAY_TOOL, {
      to: "0.0.1234",
      amountHbar: "1",
      reason: "stamps",
    });
    expect(vault.payments[0].to).toBe(MERCHANT);
  });

  it("returns an error envelope instead of paying for a non-positive amount", async () => {
    const result = await toolkit().run(PAY_TOOL, { to: MERCHANT, amountHbar: "0", reason: "nothing" });

    expect(result.raw.status).toBe("ERROR");
    expect(vault.payments).toHaveLength(0);
  });

  it("composes with Agent Kit policies: an off-chain policy can block before anything is published or paid", async () => {
    class MaxTenHbarPolicy extends AbstractPolicy {
      name = "max-10-hbar";
      description = "Refuse payments above 10 HBAR before they reach the chain";
      relevantTools = [PAY_TOOL];
      protected shouldBlockPostParamsNormalization(params: PostParamsNormalizationParams) {
        return params.normalisedParams.amountTinybars > hbarToTinybars("10");
      }
    }

    const result = await toolkit({}, [new MaxTenHbarPolicy()]).run(PAY_TOOL, {
      to: MERCHANT,
      amountHbar: "11",
      reason: "too much",
    });

    expect(result.raw.status).toBe("ERROR");
    expect(result.humanMessage).toContain("blocked by policy");
    expect(publisher.published).toHaveLength(0);
    expect(vault.payments).toHaveLength(0);
  });
});

describe("query tools", () => {
  it("summarises the policy in USD", async () => {
    const result = await toolkit().run(GET_POLICY_TOOL, {});
    expect(result.raw.perPaymentLimit).toBe("$1.00");
    expect(result.raw.remainingToday).toBe("$4.50");
    expect(result.humanMessage).toContain("timelocked for 300s");
  });

  it("reports request status and rejects unknown IDs", async () => {
    const kit = toolkit();
    await kit.run(PAY_TOOL, { to: MERCHANT, amountHbar: "1", reason: "stamps" });

    expect((await kit.run(GET_REQUEST_TOOL, { requestId: "1" })).humanMessage).toContain("timelocked");
    expect((await kit.run(GET_REQUEST_TOOL, { requestId: "9" })).raw.status).toBe("ERROR");
  });
});

describe("ClaudeHederaToolkit", () => {
  it("exposes every plugin tool to Claude with its JSON schema", () => {
    const tools = toolkit().getTools();
    expect(tools.map(tool => tool.name)).toEqual([GET_POLICY_TOOL, PAY_TOOL, GET_REQUEST_TOOL]);
    const pay = tools.find(tool => tool.name === PAY_TOOL)! as unknown as {
      input_schema: { properties: object };
    };
    expect(Object.keys(pay.input_schema.properties)).toEqual(["to", "amountHbar", "reason"]);
  });
});
