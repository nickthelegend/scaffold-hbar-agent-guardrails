import { defineChain } from "viem";

export type HederaNetwork = "testnet" | "mainnet";

type NetworkInfo = {
  chainId: number;
  rpcUrl: string;
  mirrorNode: string;
  hashscan: string;
};

export const NETWORKS: Record<HederaNetwork, NetworkInfo> = {
  testnet: {
    chainId: 296,
    rpcUrl: "https://testnet.hashio.io/api",
    mirrorNode: "https://testnet.mirrornode.hedera.com",
    hashscan: "https://hashscan.io/testnet",
  },
  mainnet: {
    chainId: 295,
    rpcUrl: "https://mainnet.hashio.io/api",
    mirrorNode: "https://mainnet-public.mirrornode.hedera.com",
    hashscan: "https://hashscan.io/mainnet",
  },
};

export const hederaChain = (network: HederaNetwork, rpcUrl = NETWORKS[network].rpcUrl) =>
  defineChain({
    id: NETWORKS[network].chainId,
    name: `Hedera ${network}`,
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "HashScan", url: NETWORKS[network].hashscan } },
  });

export const hashscanTx = (network: HederaNetwork, txHash: string) =>
  `${NETWORKS[network].hashscan}/transaction/${txHash}`;

export const hashscanTopic = (network: HederaNetwork, topicId: string) =>
  `${NETWORKS[network].hashscan}/topic/${topicId}`;
