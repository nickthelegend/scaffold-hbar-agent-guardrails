import { createPublicClient, http, parseAbi } from "viem";
import { hedera, hederaTestnet } from "viem/chains";
import scaffoldConfig from "~~/scaffold.config";

export const HBAR_PRICE_CACHE_DURATION_MS = 60 * 1000;

/**
 * Chainlink HBAR/USD feeds on Hedera. The header price is read on-chain through the app's own RPC, the same source
 * the contracts use, instead of a third-party price API that browsers block with CORS.
 */
export const HBAR_USD_FEEDS: Record<number, `0x${string}`> = {
  [hederaTestnet.id]: "0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a",
  [hedera.id]: "0xAF685FB45C12b92b5054ccb9313e135525F9b5d5",
};

const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
]);

type HbarPriceCache = {
  price: number;
  timestamp: number;
};

let cache: HbarPriceCache | null = null;

export async function fetchHbarPrice(): Promise<number> {
  const now = Date.now();
  if (cache && now - cache.timestamp < HBAR_PRICE_CACHE_DURATION_MS) {
    return cache.price;
  }

  const chain = scaffoldConfig.targetNetworks[0];
  const feed = HBAR_USD_FEEDS[chain.id];
  if (!feed) return 0;

  try {
    const rpcOverrides: Record<number, string> | undefined = scaffoldConfig.rpcOverrides;
    const client = createPublicClient({ chain, transport: http(rpcOverrides?.[chain.id]) });
    const [[, answer], decimals] = await Promise.all([
      client.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" }),
      client.readContract({ address: feed, abi: feedAbi, functionName: "decimals" }),
    ]);
    const price = Number(answer) / 10 ** decimals;
    cache = { price, timestamp: now };
    return price;
  } catch (error) {
    console.warn("Failed to read the Chainlink HBAR/USD price:", error);
    return cache?.price ?? 0;
  }
}
