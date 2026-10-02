import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { agentVaultAbi } from "./abi";
import { hederaChain, type HederaNetwork } from "./network";

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
  intentTopic: bigint;
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

export type PayResult = { id: bigint; lane: Lane; usdValue: bigint; txHash: Hex };

/** The vault operations an agent needs; implemented over JSON-RPC below and faked in tests. */
export interface VaultGateway {
  readonly address: Address;
  readonly agent: Address;
  snapshot(): Promise<PolicySnapshot>;
  isAllowedRecipient(to: Address): Promise<boolean>;
  quoteUsd(amountTinybars: bigint): Promise<{ ok: boolean; usd: bigint }>;
  pay(to: Address, amountTinybars: bigint, intentHash: Hex): Promise<PayResult>;
  getRequest(id: bigint): Promise<PaymentRequest>;
}

export class RpcVaultGateway implements VaultGateway {
  readonly agent: Address;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;

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

  private read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.publicClient.readContract({
      address: this.address,
      abi: agentVaultAbi,
      functionName,
      args,
    } as never) as Promise<T>;
  }

  async snapshot(): Promise<PolicySnapshot> {
    const [policyTuple, remaining, pending, worstCase, balance, paused, intentTopic] = await Promise.all([
      this.read<readonly [boolean, boolean, number, bigint, bigint, bigint]>("policies", [this.agent]),
      this.read<bigint>("remainingDailyUsd", [this.agent]),
      this.read<bigint>("pendingTimelockUsd", [this.agent]),
      this.read<bigint>("worstCaseDailyExposureUsd", [this.agent]),
      // eth_getBalance answers in weibars; the vault reasons in tinybars.
      this.publicClient.getBalance({ address: this.address }).then(weibars => weibars / 10n ** 10n),
      this.read<boolean>("paused"),
      this.read<bigint>("intentTopic"),
    ]);
    const [active, anyRecipient, vetoWindow, perTxLimitUsd, dailyLimitUsd, timelockCapUsd] = policyTuple;
    return {
      policy: { active, anyRecipient, vetoWindow, perTxLimitUsd, dailyLimitUsd, timelockCapUsd },
      remainingDailyUsd: remaining,
      pendingTimelockUsd: pending,
      worstCaseDailyExposureUsd: worstCase,
      vaultBalanceTinybars: balance,
      paused,
      intentTopic,
    };
  }

  isAllowedRecipient(to: Address): Promise<boolean> {
    return this.read<boolean>("isAllowedRecipient", [this.agent, to]);
  }

  async quoteUsd(amountTinybars: bigint): Promise<{ ok: boolean; usd: bigint }> {
    const [ok, usd] = await this.read<readonly [boolean, bigint]>("quoteUsd", [amountTinybars]);
    return { ok, usd };
  }

  async pay(to: Address, amountTinybars: bigint, intentHash: Hex): Promise<PayResult> {
    // Simulate first so policy reverts (paused, not an agent) surface as readable errors before paying gas.
    const { request } = await this.publicClient.simulateContract({
      address: this.address,
      abi: agentVaultAbi,
      functionName: "pay",
      args: [to, amountTinybars, intentHash],
      account: this.walletClient.account!,
    });
    const txHash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`pay() reverted in ${txHash}`);

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.address.toLowerCase()) continue;
      try {
        const event = decodeEventLog({ abi: agentVaultAbi, data: log.data, topics: log.topics });
        if (event.eventName === "PaymentRequested") {
          return { id: event.args.id, lane: LANES[event.args.lane], usdValue: event.args.usdValue, txHash };
        }
      } catch {
        // Not a vault event we know; keep scanning.
      }
    }
    throw new Error(`PaymentRequested event missing from ${txHash}`);
  }

  async getRequest(id: bigint): Promise<PaymentRequest> {
    const [agent, to, amount, usdValue, createdAt, executeAfter, status, lane, intentHash, schedule] =
      await this.read<
        readonly [Address, Address, bigint, bigint, number, number, number, number, Hex, Address]
      >("requests", [id]);
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
