import { useQuery } from "@tanstack/react-query";
import {
  getUserTreasuries,
  getTreasuryConfig,
  getTreasuryAssets,
  getTokenBalanceHistory,
  getTokenPrice,
  getBatchTokenPrices,
  getTokenBalance,
  getBatchTokenBalances,
  getTreasuryPolicy,
  getStorageDepositIsRegistered,
  getBatchStorageDepositIsRegistered,
  getTokenMetadata,
  getLockupPool,
  getProfile,
  getBatchProfiles,
  StorageDepositRequest,
  getBatchPayment
} from "@/lib/api";

/**
 * Query hook to get user's treasuries with config data
 * Requires Near instance for blockchain queries
 */
export function useUserTreasuries(accountId: string | null | undefined) {
  return useQuery({
    queryKey: ["userTreasuries", accountId],
    queryFn: () => getUserTreasuries(accountId!),
    enabled: !!accountId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * Query hook to get a single treasury's config data
 * Fetches directly from the treasury contract via backend
 */
export function useTreasuryConfig(treasuryId: string | null | undefined) {
  return useQuery({
    queryKey: ["treasuryConfig", treasuryId],
    queryFn: () => getTreasuryConfig(treasuryId!),
    enabled: !!treasuryId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * Query hook to get whitelisted tokens with balances and prices
 * Fetches from backend which aggregates data from Ref Finance and FastNear
 */
export function useTreasuryAssets(
  treasuryId: string | null | undefined,
  options?: {
    onlyPositiveBalance?: boolean;
  },
) {
  return useQuery({
    queryKey: ["treasuryAssets", treasuryId, options?.onlyPositiveBalance],
    queryFn: () => getTreasuryAssets(treasuryId!),
    enabled: !!treasuryId,
    staleTime: 1000 * 60 * 5, // 5 minutes
    select: (data) => {
      if (options?.onlyPositiveBalance) {
        const filteredTokens = data.tokens.filter(
          (asset) => Number(asset.balance) > 0,
        );
        return {
          ...data,
          tokens: filteredTokens,
        };
      }
      return data;
    },
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
export function useTokenPrice(
  tokenId: string | null | undefined,
  network: string | null | undefined,
) {
  return useQuery({
    queryKey: ["tokenPrice", tokenId, network],
    queryFn: () => getTokenPrice(tokenId!, network!),
    enabled: !!tokenId && !!network,
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
  tokenId: string | null | undefined,
  network: string | null | undefined,
) {
  return useQuery({
    queryKey: ["tokenBalance", accountId, tokenId],
    queryFn: () => getTokenBalance(accountId!, tokenId!, network!),
    enabled: !!accountId && !!tokenId && !!network,
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
  tokenIds: string[],
) {
  return useQuery({
    queryKey: ["batchTokenBalances", accountId, tokenIds],
    queryFn: () => getBatchTokenBalances(accountId!, tokenIds),
    enabled: !!accountId && tokenIds.length > 0,
    staleTime: 1000 * 30, // 30 seconds
    refetchInterval: 1000 * 30, // Refetch every 30 seconds
  });
}

/**
 * Query hook to get treasury policy including roles, permissions, and approval settings
 * Fetches from backend which queries the treasury contract and caches the result
 */
export function useTreasuryPolicy(treasuryId: string | null | undefined) {
  return useQuery({
    queryKey: ["treasuryPolicy", treasuryId],
    queryFn: () => getTreasuryPolicy(treasuryId!),
    enabled: !!treasuryId,
    staleTime: 1000 * 60 * 10, // 10 minutes (policies don't change frequently)
  });
}

/**
 * Query hook to get storage deposit for an account on a specific token contract
 * Returns the storage deposit amount required for the account to hold the token
 * Useful for determining if storage deposit is needed before token transfers
 */
export function useStorageDepositIsRegistered(
  accountId: string | null | undefined,
  tokenId: string | null | undefined,
) {
  return useQuery({
    queryKey: ["storageDepositIsRegistered", accountId, tokenId],
    queryFn: () => getStorageDepositIsRegistered(accountId!, tokenId!),
    enabled: !!accountId && !!tokenId,
    staleTime: 1000 * 60 * 5, // 5 minutes (storage deposits don't change frequently)
  });
}

/**
 * Query hook to get storage deposit registration status for multiple account-token pairs in a single batch request
 * More efficient than making individual requests for each pair
 * Re-uses individual cache entries on the backend rather than caching the full batch query
 */
export function useBatchStorageDepositIsRegistered(
  requests: StorageDepositRequest[],
) {
  return useQuery({
    queryKey: ["batchStorageDepositIsRegistered", requests],
    queryFn: () => getBatchStorageDepositIsRegistered(requests),
    enabled: requests.length > 0,
    staleTime: 1000 * 60 * 5, // 5 minutes (storage deposits don't change frequently)
  });
}

/**
 * Query hook to get token metadata (name, symbol, decimals, icon, price, blockchain, chain_name)
 * Fetches from backend which enriches data from bridge and external price APIs
 * Supports both NEAR and cross-chain tokens
 */
export function useToken(
  tokenId: string | null | undefined,
  network: string | null | undefined,
) {
  return useQuery({
    queryKey: ["tokenMetadata", tokenId, network],
    queryFn: () => getTokenMetadata(tokenId!, network!),
    enabled: !!tokenId && !!network,
    staleTime: 1000 * 60 * 5, // 5 minutes (token metadata and price)
    refetchInterval: 1000 * 60 * 5, // Refetch every 5 minutes
  });
}

/**
 * Query hook to get staking pool account ID for a lockup contract
 * Fetches from backend which queries the lockup contract on the blockchain
 * Returns the pool account ID if the lockup contract has a staking pool registered
 */
export function useLockupPool(accountId: string | null | undefined) {
  return useQuery({
    queryKey: ["lockupPool", accountId],
    queryFn: () => getLockupPool(accountId!),
    enabled: !!accountId,
    staleTime: 1000 * 60 * 10, // 10 minutes (lockup pool associations don't change frequently)
  });
}

/**
 * Query hook to get profile data from NEAR Social for a single account
 * Fetches profile information including name, image, description, etc.
 * Data is cached on the backend from social.near contract
 */
export function useProfile(accountId: string | null | undefined) {
  return useQuery({
    queryKey: ["profile", accountId],
    queryFn: () => getProfile(accountId!),
    enabled: !!accountId,
    staleTime: 1000 * 60 * 10, // 10 minutes (profile data doesn't change frequently)
  });
}

/**
 * Query hook to get profile data from NEAR Social for multiple accounts in a single batch request
 * More efficient than making individual requests for each account
 * Returns a record/object mapping account IDs to their profile data
 */
export function useBatchProfiles(accountIds: string[]) {
  return useQuery({
    queryKey: ["batchProfiles", accountIds],
    queryFn: () => getBatchProfiles(accountIds),
    enabled: accountIds.length > 0,
    staleTime: 1000 * 60 * 10, // 10 minutes (profile data doesn't change frequently)
  });
}

/**
 * Query hook to get batch payment details by batch ID
 * Fetches from backend which queries the batch payment contract and caches the result
 * Returns batch payment info including token, submitter, status, and list of payments
 */
export function useBatchPayment(batchId: string | null | undefined) {
  return useQuery({
    queryKey: ["batchPayment", batchId],
    queryFn: () => getBatchPayment(batchId!),
    enabled: !!batchId,
    staleTime: 1000 * 60 * 5, // 5 minutes (batch payment data doesn't change frequently once created)
  });
}
