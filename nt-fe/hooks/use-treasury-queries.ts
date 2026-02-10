import { useQuery } from "@tanstack/react-query";
import {
    getUserTreasuries,
    getTreasuryConfig,
    getBalanceChart,
    BalanceChartRequest,
    getTokenBalance,
    getTreasuryPolicy,
    getStorageDepositIsRegistered,
    getBatchStorageDepositIsRegistered,
    getTokenMetadata,
    getLockupPool,
    getProfile,
    StorageDepositRequest,
    getBatchPayment,
    checkHandleUnused,
    checkAccountExists,
    searchIntentsTokens,
    SearchTokensParams,
    getRecentActivity,
    getExportHistory,
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
export function useTreasuryConfig(
    treasuryId: string | null | undefined,
    before: string | null | undefined = null,
) {
    return useQuery({
        queryKey: ["treasuryConfig", treasuryId, before],
        queryFn: () => getTreasuryConfig(treasuryId!, before),
        enabled: !!treasuryId,
        staleTime: 1000 * 60 * 5, // 5 minutes
    });
}

/**
 * Query hook to get balance chart data with USD values
 * Fetches historical balance snapshots at specified intervals
 * Supports filtering by specific tokens or all tokens
 */
export function useBalanceChart(params: BalanceChartRequest | null) {
    return useQuery({
        queryKey: [
            "balanceChart",
            params?.accountId,
            params?.startTime,
            params?.endTime,
            params?.interval,
            params?.tokenIds,
        ],
        queryFn: () => getBalanceChart(params!),
        enabled: !!params?.accountId,
        staleTime: 1000 * 60 * 5, // 5 minutes
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
 * Query hook to get treasury policy including roles, permissions, and approval settings
 * Fetches from backend which queries the treasury contract and caches the result
 */
export function useTreasuryPolicy(
    treasuryId: string | null | undefined,
    before: string | null | undefined = null,
) {
    return useQuery({
        queryKey: ["treasuryPolicy", treasuryId, before],
        queryFn: () => getTreasuryPolicy(treasuryId!, before),
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
export function useToken(tokenId: string | null | undefined) {
    return useQuery({
        queryKey: ["tokenMetadata", tokenId],
        queryFn: () => getTokenMetadata(tokenId!),
        enabled: !!tokenId,
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

/**
 * Query hook to check if a treasury handle (account name) is available
 * Validates that the account doesn't already exist on the blockchain
 * Returns is_valid: true if the handle is available, false if already taken
 */
export function useCheckHandleUnused(treasuryId: string | null | undefined) {
    return useQuery({
        queryKey: ["checkHandleUnused", treasuryId],
        queryFn: () => checkHandleUnused(treasuryId!),
        enabled: !!treasuryId && treasuryId.length > 0,
        staleTime: 1000 * 60, // 1 minute (handle availability can change)
        retry: false, // Don't retry on failure
    });
}

/**
 * Query hook to check if any account ID exists on NEAR blockchain
 * Works with any account ID, not limited to sputnik-dao accounts
 * Returns exists: true if the account exists, false otherwise
 */
export function useCheckAccountExists(accountId: string | null | undefined) {
    return useQuery({
        queryKey: ["checkAccountExists", accountId],
        queryFn: () => checkAccountExists(accountId!),
        enabled: !!accountId && accountId.length > 0,
        staleTime: 1000 * 60, // 1 minute (account existence can change)
        retry: false, // Don't retry on failure
    });
}

/**
 * Query hook to search for intents tokens by symbol or name with network information
 * Matches tokens and their network deployments for cross-chain swap proposals
 *
 * @param params - Search parameters
 * @param params.tokenIn - Token symbol or name for input token (e.g., "USDC")
 * @param params.tokenOut - Token symbol or name for output token (e.g., "NEAR")
 * @param params.intentsTokenContractId - Contract ID to match for tokenIn network deployment
 * @param params.destinationNetwork - Chain ID to match for tokenOut network (e.g., "near", "eth")
 * @returns Object with tokenIn and tokenOut metadata including defuse asset IDs and network info
 */
export function useSearchIntentsTokens(params: SearchTokensParams) {
    const hasParams = !!(params.tokenIn || params.tokenOut);

    return useQuery({
        queryKey: ["searchIntentsTokens", params],
        queryFn: () => searchIntentsTokens(params),
        enabled: hasParams,
        staleTime: 1000 * 60 * 10, // 10 minutes (token metadata doesn't change frequently)
    });
}

/**
 * Query hook to get recent activity for an account
 * Fetches enriched transaction history with token metadata included
 * Returns list of transactions with amounts, counterparties, and metadata
 */
export function useRecentActivity(
    accountId: string | null | undefined,
    limit: number = 10,
    offset: number = 0,
    minUsdValue?: number,
    transactionType?: string,
    tokenIds?: string[],
    startDate?: string,
    endDate?: string,
) {
    return useQuery({
        queryKey: ["recentActivity", accountId, limit, offset, minUsdValue, transactionType, tokenIds, startDate, endDate],
        queryFn: () => getRecentActivity(accountId!, limit, offset, minUsdValue, transactionType, tokenIds, startDate, endDate),
        enabled: !!accountId,
        staleTime: 1000 * 30, // 30 seconds (activity changes frequently)
    });
}

/**
 * Hook to fetch export history for an account
 * Only updates when explicitly refetched (after export)
 */
export function useExportHistory(
    accountId: string | null | undefined,
    limit: number = 10,
    offset: number = 0,
) {
    return useQuery({
        queryKey: ["exportHistory", accountId, limit, offset],
        queryFn: () => getExportHistory(accountId!, limit, offset),
        enabled: !!accountId,
        staleTime: Infinity, // Never auto-refresh, only manual refetch
    });
}
