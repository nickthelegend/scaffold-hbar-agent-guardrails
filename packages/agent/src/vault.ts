import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { agentVaultAbi } from "./abi";
import { hederaChain, type HederaNetwork } from "./network";
import { weibarsToTinybars } from "./units";

/** Mirrors `AgentVault.Lane`. */
export const LANES = ["instant", "timelock", "approval"] as const;
export type Lane = (typeof LANES)[number];

/** Mirrors `AgentVault.Status`. */
export const STATUSES = [
  "none",
  "executed",
  "timelocked",
  "awaitingApproval",
  "vetoed",
  "rejected",
  "failed",
] as const;
export type Status = (typeof STATUSES)[number];

export type Policy = {
  active: boolean;
  anyRecipient: boolean;
  vetoWindow: number;
  perTxLimitUsd: bigint;
  dailyLimitUsd: bigint;
  timelockCapUsd: bigint;
};

export type PolicySnapshot = {
  policy: Policy;
  remainingDailyUsd: bigint;
  pendingTimelockUsd: bigint;
  worstCaseDailyExposureUsd: bigint;
  vaultBalanceTinybars: bigint;
  paused: boolean;
};

export type PaymentRequest = {
  id: bigint;
  agent: Address;
  to: Address;
  amountTinybars: bigint;
  usdValue: bigint;
  createdAt: number;
  executeAfter: number;
  status: Status;
  lane: Lane;
  intentHash: Hex;
  schedule: Address;
};

export type PayResult = { id: bigint; lane: Lane; usdValue: bigint; executeAfter: number; txHash: Hex };

/** The vault operations an agent needs; implemented over JSON-RPC below and faked in tests. */
export interface VaultGateway {
  readonly address: Address;
  readonly agent: Address;
  snapshot(): Promise<PolicySnapshot>;
  /** HCS topic number for intents, 0n when the owner has not set one. */
  intentTopic(): Promise<bigint>;
  /** Simulates `pay` so policy reverts (paused vault, revoked agent) surface before anything is published. */
  preview(to: Address, amountTinybars: bigint, intentHash: Hex): Promise<Lane>;
  pay(to: Address, amountTinybars: bigint, intentHash: Hex): Promise<PayResult>;
  getRequest(id: bigint): Promise<PaymentRequest>;
}

export class RpcVaultGateway implements VaultGateway {
  readonly agent: Address;
  private readonly publicClient: PublicClient<Transport, Chain>;
  private readonly walletClient: WalletClient<Transport, Chain, Account>;

  constructor(
    readonly address: Address,
    private readonly account: Account,
    network: HederaNetwork,
    rpcUrl?: string,
  ) {
    const chain = hederaChain(network, rpcUrl);
    this.agent = account.address;
    this.publicClient = createPublicClient({ chain, transport: http() });
    this.walletClient = createWalletClient({ chain, transport: http(), account });
  }

  private get contract() {
    return { address: this.address, abi: agentVaultAbi } as const;
  }

  async snapshot(): Promise<PolicySnapshot> {
    const { contract, publicClient, agent } = this;
    const [policy, remaining, pending, worstCase, weibars, paused] = await Promise.all([
      publicClient.readContract({ ...contract, functionName: "policies", args: [agent] }),
      publicClient.readContract({ ...contract, functionName: "remainingDailyUsd", args: [agent] }),
      publicClient.readContract({ ...contract, functionName: "pendingTimelockUsd", args: [agent] }),
      publicClient.readContract({ ...contract, functionName: "worstCaseDailyExposureUsd", args: [agent] }),
      publicClient.getBalance({ address: this.address }),
      publicClient.readContract({ ...contract, functionName: "paused" }),
    ]);
    const [active, anyRecipient, vetoWindow, perTxLimitUsd, dailyLimitUsd, timelockCapUsd] = policy;
    return {
      policy: { active, anyRecipient, vetoWindow, perTxLimitUsd, dailyLimitUsd, timelockCapUsd },
      remainingDailyUsd: remaining,
      pendingTimelockUsd: pending,
      worstCaseDailyExposureUsd: worstCase,
      vaultBalanceTinybars: weibarsToTinybars(weibars),
      paused,
    };
  }

  intentTopic(): Promise<bigint> {
    return this.publicClient.readContract({ ...this.contract, functionName: "intentTopic" });
  }

  async preview(to: Address, amountTinybars: bigint, intentHash: Hex): Promise<Lane> {
    const { result } = await this.publicClient.simulateContract({
      ...this.contract,
      functionName: "pay",
      args: [to, amountTinybars, intentHash],
      account: this.account,
    });
    return LANES[result[1]];
  }

  async pay(to: Address, amountTinybars: bigint, intentHash: Hex): Promise<PayResult> {
    const { request } = await this.publicClient.simulateContract({
      ...this.contract,
      functionName: "pay",
      args: [to, amountTinybars, intentHash],
      account: this.account,
    });
    const txHash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`pay() reverted in ${txHash}`);

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.address.toLowerCase()) continue;
      try {
        const event = decodeEventLog({ abi: agentVaultAbi, data: log.data, topics: log.topics });
        if (event.eventName === "PaymentRequested") {
          return {
            id: event.args.id,
            lane: LANES[event.args.lane],
            usdValue: event.args.usdValue,
            executeAfter: Number(event.args.executeAfter),
            txHash,
          };
        }
      } catch {
        // Not a vault event we know; keep scanning.
      }
    }
    throw new Error(`PaymentRequested event missing from ${txHash}`);
  }

  async getRequest(id: bigint): Promise<PaymentRequest> {
    const [agent, to, amount, usdValue, createdAt, executeAfter, status, lane, intentHash, schedule] =
      await this.publicClient.readContract({ ...this.contract, functionName: "requests", args: [id] });
    return {
      id,
      agent,
      to,
      amountTinybars: amount,
      usdValue,
      createdAt: Number(createdAt),
      executeAfter: Number(executeAfter),
      status: STATUSES[status],
      lane: LANES[lane],
      intentHash,
      schedule,
    };
  }
}
