import { describe, expect, it } from "vitest";
import { encodeIntent, hashIntent, MAX_INTENT_BYTES, type Intent } from "../src/intent";
import { formatUsd, hbarToTinybars, hbarToWeibars, tinybarsToHbar, usdToMicros } from "../src/units";
import { AGENT, MERCHANT, VAULT } from "./fakes";

const intent: Intent = {
  vault: VAULT,
  agent: AGENT,
  to: MERCHANT,
  amountTinybars: 250_000_000n,
  reason: "Restock coffee beans",
  createdAt: 1_790_000_000,
};

describe("intent encoding", () => {
  it("is canonical: lowercase addresses and integer strings in a fixed order", () => {
    expect(encodeIntent(intent)).toBe(
      `{"v":1,"vault":"${VAULT}","agent":"${AGENT}","to":"${MERCHANT}","amountTinybars":"250000000",` +
        `"reason":"Restock coffee beans","createdAt":1790000000}`,
    );
  });

  it("hashes identically regardless of address casing", () => {
    const upper = { ...intent, to: MERCHANT.toUpperCase().replace("0X", "0x") as Intent["to"] };
    expect(hashIntent(encodeIntent(upper))).toBe(hashIntent(encodeIntent(intent)));
  });

  it.each([
    ["ASCII", "x".repeat(5_000)],
    ["multi-byte", "支付".repeat(1_000)],
    ["emoji", "☕️🚀".repeat(500)],
    ["characters JSON escapes", '"\\\n'.repeat(1_000)],
  ])("fits %s reasons into a single 1 KiB HCS message", (_, reason) => {
    const message = encodeIntent({ ...intent, reason });
    expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(MAX_INTENT_BYTES);
    expect(JSON.parse(message).reason.length).toBeGreaterThan(0);
    expect(reason.startsWith(JSON.parse(message).reason)).toBe(true);
  });
});

describe("units", () => {
  it("converts between HBAR, tinybars and weibars", () => {
    expect(hbarToTinybars("1.5")).toBe(150_000_000n);
    expect(tinybarsToHbar(150_000_000n)).toBe("1.5");
    expect(hbarToWeibars("1")).toBe(10n ** 18n);
  });

  it("formats 6-decimal USD", () => {
    expect(usdToMicros("2.5")).toBe(2_500_000n);
    expect(formatUsd(2_500_000n)).toBe("$2.50");
  });
});
