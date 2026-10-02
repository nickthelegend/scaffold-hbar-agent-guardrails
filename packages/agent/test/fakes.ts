import type { Address, Hex } from "viem";
import type { IntentPublisher, PublishedIntent } from "../src/intent";
import type { Lane, PayResult, PaymentRequest, PolicySnapshot, VaultGateway } from "../src/vault";

export const VAULT = "0x000000000000000000000000000000000000beef" as Address;
export const AGENT = "0x00000000000000000000000000000000000a9e17" as Address;
export const MERCHANT = "0x0000000000000000000000000000000000c0ffee" as Address;

/** In-memory VaultGateway: routes like the contract does, for a fixed $0.10/HBAR price. */
export class FakeVault implements VaultGateway {
  readonly address = VAULT;
  readonly agent = AGENT;
  payments: { to: Address; amountTinybars: bigint; intentHash: Hex }[] = [];
  intentTopic = 4242n;
  laneFor: (amountTinybars: bigint) => Lane = () => "instant";

  async snapshot(): Promise<PolicySnapshot> {
    return {
      policy: {
        active: true,
        anyRecipient: false,
        vetoWindow: 300,
        perTxLimitUsd: 1_000_000n,
        dailyLimitUsd: 5_000_000n,
        timelockCapUsd: 20_000_000n,
      },
      remainingDailyUsd: 4_500_000n,
      pendingTimelockUsd: 0n,
      worstCaseDailyExposureUsd: 5_765_000_000n,
      vaultBalanceTinybars: 100n * 10n ** 8n,
      paused: false,
      intentTopic: this.intentTopic,
    };
  }

  async isAllowedRecipient(to: Address) {
    return to === MERCHANT;
  }

  async quoteUsd(amountTinybars: bigint) {
    return { ok: true, usd: amountTinybars / 1000n };
  }

  async pay(to: Address, amountTinybars: bigint, intentHash: Hex): Promise<PayResult> {
    this.payments.push({ to, amountTinybars, intentHash });
    return {
      id: BigInt(this.payments.length),
      lane: this.laneFor(amountTinybars),
      usdValue: amountTinybars / 1000n,
      txHash: `0x${"ab".repeat(32)}`,
    };
  }

  async getRequest(id: bigint): Promise<PaymentRequest> {
    const payment = this.payments[Number(id) - 1];
    return {
      id,
      agent: AGENT,
      to: payment?.to ?? MERCHANT,
      amountTinybars: payment?.amountTinybars ?? 0n,
      usdValue: 0n,
      createdAt: 0,
      executeAfter: 1_790_000_300,
      status: payment ? "timelocked" : "none",
      lane: "timelock",
      intentHash: payment?.intentHash ?? `0x${"00".repeat(32)}`,
      schedule: "0x0000000000000000000000000000000000000000",
    };
  }
}

export class FakePublisher implements IntentPublisher {
  published: { topicId: string; message: string }[] = [];

  async publish(topicId: string, message: string): Promise<PublishedIntent> {
    this.published.push({ topicId, message });
    return { topicId, sequenceNumber: this.published.length, transactionId: "0.0.1@1790000000.0" };
  }
}
