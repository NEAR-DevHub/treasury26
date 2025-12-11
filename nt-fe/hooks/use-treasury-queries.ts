import { useQuery } from "@tanstack/react-query";
import { getUserTreasuries, getTreasuryAssets, getTokenBalanceHistory, getTokenPrice, getBatchTokenPrices, getTokenBalance, getBatchTokenBalances } from "@/lib/api";

/**
 * Query hook to get user's treasuries with config data
 * Requires Near instance for blockchain queries
 */
export function useUserTreasuries(
  accountId: string | null | undefined,
) {
  return useQuery({
    queryKey: ["userTreasuries", accountId],
    queryFn: () => getUserTreasuries(accountId!),
    enabled: !!accountId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * Query hook to get whitelisted tokens with balances and prices
 * Fetches from backend which aggregates data from Ref Finance and FastNear
 */
export function useWhitelistTokens(
  treasuryId: string | null | undefined,
) {
  return useQuery({
    queryKey: ["treasuryAssets", treasuryId],
    queryFn: () => getTreasuryAssets(treasuryId!),
    enabled: !!treasuryId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * Query hook to get token balance history across multiple time periods
 * Fetches historical balance data from the backend
 */
export function useTokenBalanceHistory(
  accountId: string | null | undefined,
  tokenId: string | null | undefined,
) {
  return useQuery({
    queryKey: ["tokenBalanceHistory", accountId, tokenId],
    queryFn: () => getTokenBalanceHistory(accountId!, tokenId!),
    enabled: !!accountId && !!tokenId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * Query hook to get price for a single token
 * Fetches from backend which aggregates data from multiple price sources
 * Supports both NEAR and FT tokens
 */
export function useTokenPrice(tokenId: string | null | undefined) {
  return useQuery({
    queryKey: ["tokenPrice", tokenId],
    queryFn: () => getTokenPrice(tokenId!),
    enabled: !!tokenId,
    staleTime: 1000 * 60, // 1 minute (prices change frequently)
    refetchInterval: 1000 * 60, // Refetch every minute
  });
}

/**
 * Query hook to get prices for multiple tokens in a single batch request
 * More efficient than making individual requests for each token
 */
export function useBatchTokenPrices(tokenIds: string[]) {
  return useQuery({
    queryKey: ["batchTokenPrices", tokenIds],
    queryFn: () => getBatchTokenPrices(tokenIds),
    enabled: tokenIds.length > 0,
    staleTime: 1000 * 60, // 1 minute
    refetchInterval: 1000 * 60, // Refetch every minute
  });
}

/**
 * Query hook to get balance for a single token
 * Fetches current balance from blockchain via backend
 * Supports both NEAR and FT tokens
 */
export function useTokenBalance(
  accountId: string | null | undefined,
  tokenId: string | null | undefined
) {
  return useQuery({
    queryKey: ["tokenBalance", accountId, tokenId],
    queryFn: () => getTokenBalance(accountId!, tokenId!),
    enabled: !!accountId && !!tokenId,
    staleTime: 1000 * 30, // 30 seconds (balances change frequently)
    refetchInterval: 1000 * 30, // Refetch every 30 seconds
  });
}

/**
 * Query hook to get balances for multiple tokens in a single batch request
 * More efficient than making individual requests for each token
 */
export function useBatchTokenBalances(
  accountId: string | null | undefined,
  tokenIds: string[]
) {
  return useQuery({
    queryKey: ["batchTokenBalances", accountId, tokenIds],
    queryFn: () => getBatchTokenBalances(accountId!, tokenIds),
    enabled: !!accountId && tokenIds.length > 0,
    staleTime: 1000 * 30, // 30 seconds
    refetchInterval: 1000 * 30, // Refetch every 30 seconds
  });
}
