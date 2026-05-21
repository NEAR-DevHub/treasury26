import { Policy } from "@/types/policy";
import axios from "axios";
import Big from "@/lib/big";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { Balance, BalanceRaw, transformBalance } from "./balance";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

export interface Timezone {
    utc: string;
    value: string;
    name: string;
}

/**
 * Get list of available timezones
 */
export async function getTimezones(): Promise<Timezone[]> {
    try {
        const response = await axios.get<Timezone[]>(
            `${BACKEND_API_BASE}/proxy/timezones`,
        );
        return response.data || [];
    } catch (error) {
        console.error("Error getting timezones:", error);
        return [];
    }
}
export interface TreasuryMetadata {
    primaryColor?: string;
    flagLogo?: string;
}

export interface TreasuryConfig {
    metadata?: TreasuryMetadata;
    name?: string;
    purpose?: string;
    isConfidential: boolean;
}

export interface Treasury {
    daoId: string;
    config: TreasuryConfig;
    isMember: boolean;
    isSaved: boolean;
    isHidden: boolean;
    isConfidential: boolean;
}

/**
 * Get list of treasuries for a user account
 * Fetches from backend which includes config data from on-chain
 */
export async function getUserTreasuries(
    accountId: string,
    options?: {
        includeHidden?: boolean;
    },
): Promise<Treasury[]> {
    if (!accountId) return [];

    try {
        const url = `${BACKEND_API_BASE}/user/treasuries`;

        const response = await axios.get<Treasury[]>(url, {
            params: {
                accountId,
                includeHidden: options?.includeHidden ?? false,
            },
        });
        return response.data;
    } catch (error) {
        console.error("Error getting user treasuries", error);
        return [];
    }
}

export type TokenResidency = "Near" | "Ft" | "Intents" | "Lockup" | "Staked";

export interface FtLockupSchedule {
    startTimestamp?: number;
    roundInterval?: number;
    roundsTotal?: number;
    roundsCompleted?: number;
    totalAmount?: string;
    unlockedAmount?: string;
    lockedAmount?: string;
}

export interface TreasuryAsset {
    id: string;
    contractId?: string;
    lockupInstanceId?: string;
    ftLockupSchedule?: FtLockupSchedule;
    residency: TokenResidency;
    network: string;
    chainName: string;
    chainIcons?: ChainIcons;
    symbol: string;
    balance: Balance;
    decimals: number;
    price: number;
    name: string;
    icon: string;
    balanceUSD: number;
    weight: number;
}

export interface TreasuryAssets {
    tokens: TreasuryAsset[];
    totalBalanceUSD: Big;
}

interface TreasuryAssetRaw {
    id: string;
    contractId?: string;
    lockupInstanceId?: string;
    ftLockupSchedule?: FtLockupSchedule;
    residency: TokenResidency;
    network: string;
    chainName: string;
    chainIcons?: ChainIcons;
    symbol: string;
    balance: BalanceRaw;
    decimals: number;
    price: string;
    name: string;
    icon: string;
}

/**
 * Get treasury assets (tokens with balances and prices)
 * Fetches from backend which aggregates data from Ref Finance and FastNear
 * Returns transformed data with calculated USD values and weights
 */
export async function getTreasuryAssets(
    treasuryId: string,
): Promise<TreasuryAssets> {
    if (!treasuryId) return { tokens: [], totalBalanceUSD: Big(0) };

    try {
        const url = `${BACKEND_API_BASE}/user/assets`;

        const response = await axios.get<TreasuryAssetRaw[]>(url, {
            params: { accountId: treasuryId },
            withCredentials: true,
        });

        // Transform raw tokens with USD values
        const tokensWithUSD = response.data.map((token) => {
            const { balance, total } = transformBalance(token.balance);
            const price = parseFloat(token.price);
            const totalDecimalAdjusted = total.div(Big(10).pow(token.decimals));
            const balanceUSD = totalDecimalAdjusted.mul(price).toNumber();

            return {
                id: token.id,
                contractId: token.contractId,
                lockupInstanceId: token.lockupInstanceId,
                ftLockupSchedule: token.ftLockupSchedule,
                residency: token.residency,
                network: token.network,
                symbol: token.symbol === "wNEAR" ? "NEAR" : token.symbol,
                decimals: token.decimals,
                balance,
                chainName: token.chainName,
                chainIcons: token.chainIcons,
                balanceUSD,
                price,
                name: token.name,
                icon: token.icon,
                weight: 0,
            };
        });

        // Calculate total USD value
        const totalUSD = tokensWithUSD.reduce(
            (sum, token) => sum.add(token.balanceUSD),
            Big(0),
        );

        // Calculate weights
        const tokens: TreasuryAsset[] = tokensWithUSD.map((token) => ({
            ...token,
            weight: totalUSD.gt(0)
                ? Big(token.balanceUSD).div(totalUSD).mul(100).toNumber()
                : 0,
        }));

        return {
            tokens,
            totalBalanceUSD: totalUSD,
        };
    } catch (error) {
        console.error("Error getting whitelist tokens", error);
        return { tokens: [], totalBalanceUSD: Big(0) };
    }
}

export interface BalanceSnapshot {
    timestamp: string; // ISO 8601 format
    balance: string; // Decimal-adjusted balance
    priceUsd?: number; // USD price at timestamp (null if unavailable)
    valueUsd?: number; // balance * price_usd (null if unavailable)
}

export interface BalanceChartData {
    [tokenId: string]: BalanceSnapshot[];
}

export type ChartInterval = "hourly" | "daily" | "weekly" | "monthly";

export interface BalanceChartRequest {
    accountId: string;
    startTime: string; // ISO 8601 format
    endTime: string; // ISO 8601 format
    interval: ChartInterval;
    tokenIds?: string[]; // If omitted, returns all tokens
}

/**
 * Get balance history chart data with USD values
 * Fetches historical balance snapshots at specified intervals with price data
 * Supports filtering by specific tokens or all tokens
 */
export async function getBalanceChart(
    params: BalanceChartRequest,
): Promise<BalanceChartData | null> {
    if (!params.accountId) return null;

    try {
        const url = `${BACKEND_API_BASE}/balance-history/chart`;

        const queryParams = new URLSearchParams({
            accountId: params.accountId,
            startTime: params.startTime,
            endTime: params.endTime,
            interval: params.interval,
        });

        // Add token_ids as comma-separated values
        if (params.tokenIds && params.tokenIds.length > 0) {
            queryParams.append("tokenIds", params.tokenIds.join(","));
        }

        const response = await axios.get<BalanceChartData>(
            `${url}?${queryParams.toString()}`,
            { withCredentials: true },
        );

        return response.data;
    } catch (error) {
        console.error("Error getting balance chart data", error);
        return null;
    }
}

export interface TokenBalance {
    accountId: string;
    tokenId: string;
    balance: string;
    lockedBalance?: string;
    decimals: number;
}

export interface TokenMetadataInfo {
    tokenId: string;
    name: string;
    symbol: string;
    decimals: number;
    icon?: string;
    price?: number;
    priceUpdatedAt?: string;
    network?: string;
    chainName?: string;
    chainIcons?: {
        icon: string;
    };
}

export interface SwapInfo {
    sentTokenId: string | null;
    sentAmount: string | null;
    sentTokenMetadata?: TokenMetadataInfo;
    receivedTokenId: string;
    receivedAmount: string | null;
    receivedTokenMetadata: TokenMetadataInfo;
    solverTransactionHash: string;
    swapRole: "deposit" | "fulfillment";
}

export interface RecentActivity {
    id: number;
    blockTime: string;
    tokenId: string;
    tokenMetadata: TokenMetadataInfo;
    counterparty: string | null;
    signerId: string | null;
    receiverId: string | null;
    amount: string;
    transactionHashes: string[];
    receiptIds: string[];
    valueUsd?: number;
    swap?: SwapInfo;
    actionKind?: string | null;
    methodName?: string | null;
}

export interface RecentActivityResponse {
    data: RecentActivity[];
    total: number;
}

export interface RecentActivityParticipantsResponse {
    options: string[];
}

/**
 * Get recent activity (enriched balance changes) for an account
 * Returns transaction history with token metadata already included
 */
export async function getRecentActivity(
    accountId: string,
    limit: number = 10,
    offset: number = 0,
    minUsdValue?: number,
    transactionType?: string,
    tokenSymbol?: string,
    tokenSymbolNot?: string,
    txHash?: string,
    fromAccount?: string[],
    fromAccountNot?: string[],
    toAccount?: string[],
    toAccountNot?: string[],
    startDate?: string,
    endDate?: string,
): Promise<RecentActivityResponse | null> {
    if (!accountId) return null;

    try {
        const url = `${BACKEND_API_BASE}/recent-activity`;
        const params: Record<string, string | number> = {
            accountId: accountId,
            limit,
            offset,
        };
        if (minUsdValue !== undefined) {
            params.minUsdValue = minUsdValue;
        }
        if (transactionType !== undefined && transactionType !== "all") {
            params.transactionType = transactionType;
        }
        if (tokenSymbol) {
            params.tokenSymbol = tokenSymbol;
        }
        if (tokenSymbolNot) {
            params.tokenSymbolNot = tokenSymbolNot;
        }
        if (txHash) {
            params.txHash = txHash;
        }
        if (fromAccount && fromAccount.length > 0) {
            params.from = fromAccount.join(",");
        }
        if (fromAccountNot && fromAccountNot.length > 0) {
            params.fromNot = fromAccountNot.join(",");
        }
        if (toAccount && toAccount.length > 0) {
            params.to = toAccount.join(",");
        }
        if (toAccountNot && toAccountNot.length > 0) {
            params.toNot = toAccountNot.join(",");
        }
        if (startDate) {
            params.startDate = startDate;
        }
        if (endDate) {
            params.endDate = endDate;
        }
        const response = await axios.get<RecentActivityResponse>(url, {
            params,
            withCredentials: true,
        });
        return response.data;
    } catch (error) {
        console.error("Error getting recent activity", error);
        return null;
    }
}

export async function getRecentActivitySenders(
    accountId: string,
    transactionType?: string,
): Promise<string[]> {
    if (!accountId) return [];

    try {
        const url = `${BACKEND_API_BASE}/recent-activity/senders`;
        const response = await axios.get<RecentActivityParticipantsResponse>(
            url,
            {
                params: {
                    accountId,
                    ...(transactionType && transactionType !== "all"
                        ? { transactionType }
                        : {}),
                },
                withCredentials: true,
            },
        );
        return response.data.options ?? [];
    } catch (error) {
        console.error("Error getting recent activity senders", error);
        return [];
    }
}

export async function getRecentActivityRecipients(
    accountId: string,
    transactionType?: string,
): Promise<string[]> {
    if (!accountId) return [];

    try {
        const url = `${BACKEND_API_BASE}/recent-activity/recipients`;
        const response = await axios.get<RecentActivityParticipantsResponse>(
            url,
            {
                params: {
                    accountId,
                    ...(transactionType && transactionType !== "all"
                        ? { transactionType }
                        : {}),
                },
                withCredentials: true,
            },
        );
        return response.data.options ?? [];
    } catch (error) {
        console.error("Error getting recent activity recipients", error);
        return [];
    }
}

/**
 * Get treasury config for a specific treasury
 * Fetches from backend which queries the treasury contract for config data
 */
export async function getTreasuryConfig(
    treasuryId: string,
    atBefore: string | null = null,
): Promise<TreasuryConfig | null> {
    if (!treasuryId) return null;

    try {
        const url = `${BACKEND_API_BASE}/treasury/config`;

        const response = await axios.get<TreasuryConfig>(url, {
            params: { treasuryId, atBefore },
        });

        return response.data;
    } catch (error) {
        console.error(`Error getting treasury config for ${treasuryId}`, error);
        return null;
    }
}

/**
 * Get treasury policy including roles, permissions, and approval settings
 * Fetches from backend which queries the treasury contract
 */
export async function getTreasuryPolicy(
    treasuryId: string,
    atBefore: string | null = null,
): Promise<Policy | null> {
    if (!treasuryId) return null;

    try {
        const url = `${BACKEND_API_BASE}/treasury/policy`;
        const response = await axios.get<Policy>(url, {
            params: { treasuryId, atBefore },
        });

        return response.data;
    } catch (error) {
        console.error(`Error getting treasury policy for ${treasuryId}`, error);
        return null;
    }
}

export interface StorageDeposit {
    total?: string;
    available?: string;
}

export interface StorageDepositRegistration {
    accountId: string;
    tokenId: string;
    isRegistered: boolean;
}

/**
 * Get storage deposit for an account on a specific token contract
 * Returns the storage deposit amount required for the account to hold the token
 */
export async function getStorageDepositIsRegistered(
    accountId: string,
    tokenId: string,
): Promise<boolean> {
    if (!accountId || !tokenId) return false;

    try {
        const url = `${BACKEND_API_BASE}/token/storage-deposit/is-registered`;

        const response = await axios.get<boolean>(url, {
            params: { accountId, tokenId },
        });

        return response.data;
    } catch (error) {
        console.error(
            `Error getting storage deposit is registered for ${accountId} / ${tokenId}`,
            error,
        );
        return false;
    }
}

export interface StorageDepositRequest {
    accountId: string;
    tokenId: string;
}

/**
 * Get storage deposit registration status for multiple account-token pairs in a single batch request
 * More efficient than making individual requests for each pair
 * Re-uses individual cache entries on the backend rather than caching the full batch query
 */
export async function getBatchStorageDepositIsRegistered(
    requests: StorageDepositRequest[],
): Promise<StorageDepositRegistration[]> {
    if (!requests || requests.length === 0) return [];

    try {
        const url = `${BACKEND_API_BASE}/token/storage-deposit/is-registered/batch`;

        const response = await axios.post<StorageDepositRegistration[]>(url, {
            requests,
        });

        return response.data;
    } catch (error) {
        console.error(
            "Error getting batch storage deposit registrations",
            error,
        );
        return [];
    }
}

export interface ChainIcons {
    icon: string;
}

export interface TokenMetadata {
    tokenId: string;
    name: string;
    symbol: string;
    decimals: number;
    icon?: string;
    price?: number;
    priceUpdatedAt?: string;
    blockchain?: string;
    network?: string;
    chainName?: string;
    chainIcons?: ChainIcons;
}

/**
 * Get metadata for a single token
 * Fetches token name, symbol, decimals, and icon from the blockchain
 */
export async function getTokenMetadata(
    tokenId: string,
): Promise<TokenMetadata | null> {
    if (!tokenId) return null;
    let token = tokenId;
    const noPrefixNoNear =
        !token.startsWith("nep141:") &&
        !token.startsWith("nep245:") &&
        token.toLowerCase() !== NEAR_NETWORK_ID;

    if (noPrefixNoNear && token.split(":").length === 2) {
        token = `nep245:${token}`;
    } else if (noPrefixNoNear) {
        token = `nep141:${token}`;
    }

    try {
        const url = `${BACKEND_API_BASE}/token/metadata`;

        const response = await axios.get<TokenMetadata>(url, {
            params: { tokenId: token },
        });

        return response.data;
    } catch (error) {
        console.error(`Error getting metadata for token ${tokenId}`, error);
        return null;
    }
}

/**
 * Get staking pool account ID for a lockup contract
 * Fetches from backend which queries the lockup contract on the blockchain
 * Returns the pool account ID if registered, null otherwise
 */
export async function getLockupPool(accountId: string): Promise<string | null> {
    if (!accountId) return null;

    try {
        const url = `${BACKEND_API_BASE}/lockup/pool`;

        const response = await axios.get<string | null>(url, {
            params: { accountId },
        });

        return response.data;
    } catch (error) {
        console.error(`Error getting lockup pool for ${accountId}`, error);
        return null;
    }
}

export interface VestingSchedule {
    startTimestamp: number;
    cliffTimestamp: number;
    endTimestamp: number;
}

export interface LockupContractInfo {
    ownerAccountId: string;
    vestingSchedule: VestingSchedule | null;
    lockupTimestamp: number | null;
    lockupDuration: number;
    releaseDuration: number | null;
    stakingPoolAccountId: string | null;
}

/**
 * Get lockup contract information including vesting schedule
 * Fetches from backend which queries the lockup contract on the blockchain
 * Returns detailed lockup info including vesting dates if available
 */
export async function getLockupContract(
    accountId: string,
): Promise<LockupContractInfo | null> {
    if (!accountId) return null;

    try {
        const url = `${BACKEND_API_BASE}/user/lockup`;

        const response = await axios.get<LockupContractInfo | null>(url, {
            params: { accountId },
        });

        return response.data;
    } catch (error) {
        console.error(`Error getting lockup contract for ${accountId}`, error);
        return null;
    }
}

export interface StakingValidatorDetails {
    poolId: string;
    apy?: number;
    feePercent?: number;
}

/**
 * Get staking validator metadata (APY + fee) for a pool.
 * Data is fetched/cached by backend from PikeSpeak.
 */
export async function getStakingValidatorDetails(
    poolId: string,
): Promise<StakingValidatorDetails | null> {
    if (!poolId) return null;

    try {
        const url = `${BACKEND_API_BASE}/user/staking-validator`;
        const response = await axios.get<StakingValidatorDetails>(url, {
            params: { poolId },
        });
        return response.data;
    } catch (error) {
        console.error(
            `Error getting staking validator details for ${poolId}`,
            error,
        );
        return null;
    }
}

export interface ProfileData {
    name?: string;
    addressBookName?: string;
    image?: string;
    backgroundImage?: string;
    description?: string;
    linktree?: any;
    tags?: any;
    isInAddressBook?: boolean;
}

/**
 * Get profile data from NEAR Social for a single account
 * Fetches from backend which queries social.near contract
 */
export async function getProfile(
    accountId: string,
    daoId?: string,
): Promise<ProfileData | null> {
    if (!accountId) return null;

    try {
        const url = `${BACKEND_API_BASE}/user/profile`;

        const response = await axios.get<ProfileData>(url, {
            params: { accountId, ...(daoId ? { daoId } : {}) },
            withCredentials: true,
        });

        return response.data;
    } catch (error) {
        console.error(`Error getting profile for ${accountId}`, error);
        return null;
    }
}

export type PaymentStatus = "Pending" | { Paid: { block_height: number } };

export interface BatchPayment {
    recipient: string;
    amount: string;
    status: PaymentStatus;
}

export interface BatchPaymentResponse {
    tokenId: string;
    submitter: string;
    status: string;
    payments: BatchPayment[];
}

/**
 * Get batch payment details by batch ID
 * Fetches from backend which queries the batch payment contract
 */
export async function getBatchPayment(
    batchId: string,
): Promise<BatchPaymentResponse | null> {
    if (!batchId) return null;

    try {
        const url = `${BACKEND_API_BASE}/bulk-payment/get`;

        const response = await axios.get<BatchPaymentResponse>(url, {
            params: { batchId: batchId },
        });

        return response.data;
    } catch (error) {
        console.error(`Error getting batch payment for ${batchId}`, error);
        return null;
    }
}

export interface CheckHandleUnusedResponse {
    unused: boolean;
}

/**
 * Check if a treasury handle (account name) is available
 * Validates that the account doesn't already exist on the blockchain
 */
export async function checkHandleUnused(
    treasuryId: string,
): Promise<CheckHandleUnusedResponse | null> {
    if (!treasuryId) return null;

    try {
        const url = `${BACKEND_API_BASE}/treasury/check-handle-unused`;

        const response = await axios.get<CheckHandleUnusedResponse>(url, {
            params: { treasuryId },
        });

        return response.data;
    } catch (error) {
        console.error(
            `Error checking if handle is unused for ${treasuryId}`,
            error,
        );
        return null;
    }
}

export interface CheckAccountExistsResponse {
    exists: boolean;
}

/**
 * Check if any account ID exists on NEAR blockchain
 * Works with any account ID, not limited to sputnik-dao accounts
 */
export async function checkAccountExists(
    accountId: string,
): Promise<CheckAccountExistsResponse | null> {
    if (!accountId) return null;

    try {
        const url = `${BACKEND_API_BASE}/user/check-account-exists`;

        const response = await axios.get<CheckAccountExistsResponse>(url, {
            params: { accountId },
        });

        return response.data;
    } catch (error) {
        console.error(
            `Error checking if account exists for ${accountId}`,
            error,
        );
        return null;
    }
}

export interface CreateTreasuryRequest {
    name: string;
    accountId: string;
    paymentThreshold: number;
    governanceThreshold: number;
    governors: string[];
    financiers: string[];
    requestors: string[];
    isConfidential?: boolean;
}

export interface CreateTreasuryResponse {
    treasury: string;
}
export interface CreationProgressEvent {
    step: string;
    status: string;
    treasury?: string;
    message?: string;
}

export async function createTreasuryStream(
    request: CreateTreasuryRequest,
    onProgress: (event: CreationProgressEvent) => void,
): Promise<void> {
    const url = `${BACKEND_API_BASE}/treasury/create-stream`;

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(
            text || `Treasury creation failed (${response.status})`,
        );
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response stream");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data:")) {
                const json = trimmed.slice(5).trim();
                if (json) {
                    try {
                        const event: CreationProgressEvent = JSON.parse(json);
                        onProgress(event);
                    } catch {
                        // skip malformed events
                    }
                }
            }
        }
    }
}

export interface TreasuryCreationStatusResponse {
    creationAvailable: boolean;
}

/**
 * Check if treasury creation is available (sufficient signer balance and not disabled)
 */
export async function getTreasuryCreationStatus(): Promise<TreasuryCreationStatusResponse | null> {
    try {
        const response = await axios.get<TreasuryCreationStatusResponse>(
            `${BACKEND_API_BASE}/treasury/creation-status`,
        );
        return response.data;
    } catch (error) {
        console.error("Error fetching treasury creation status:", error);
        return null;
    }
}

export interface WhitelistRequestBody {
    contact: string;
    accountId?: string;
}

export async function submitWhitelistRequest(
    body: WhitelistRequestBody,
): Promise<void> {
    await axios.post(`${BACKEND_API_BASE}/treasury/whitelist-request`, body);
}

export interface NetworkInfo {
    chainId: string;
    chainName: string;
    contractAddress?: string;
    decimals: number;
    bridge: string;
}

export interface TokenSearchResult {
    defuseAssetId: string;
    symbol: string;
    name: string;
    decimals: number;
    icon: string;
    originChainName: string;
    unifiedAssetId: string;
    networkInfo?: NetworkInfo;
}

export interface SearchTokensParams {
    tokenIn?: string;
    tokenOut?: string;
    intentsTokenContractId?: string;
    destinationNetwork?: string;
}

export interface SearchTokensResponse {
    tokenIn?: TokenSearchResult;
    tokenOut?: TokenSearchResult;
}

/**
 * Search for intents tokens by symbol or name with network information
 * Matches tokens similar to frontend ProposalDetailsPage logic
 *
 * @param params - Search parameters
 * @param params.tokenIn - Token symbol or name to search for (input token)
 * @param params.tokenOut - Token symbol or name to search for (output token)
 * @param params.intentsTokenContractId - Contract ID to match for tokenIn network
 * @param params.destinationNetwork - Chain ID to match for tokenOut network
 * @returns Object with tokenIn and tokenOut search results
 */
export async function searchIntentsTokens(
    params: SearchTokensParams,
): Promise<SearchTokensResponse> {
    try {
        const queryParams = new URLSearchParams();

        if (params.tokenIn) {
            queryParams.append("tokenIn", params.tokenIn);
        }
        if (params.tokenOut) {
            queryParams.append("tokenOut", params.tokenOut);
        }
        if (params.intentsTokenContractId) {
            queryParams.append(
                "intentsTokenContractId",
                params.intentsTokenContractId,
            );
        }
        if (params.destinationNetwork) {
            queryParams.append("destinationNetwork", params.destinationNetwork);
        }

        const url = `${BACKEND_API_BASE}/intents/search-tokens?${queryParams.toString()}`;
        const response = await axios.get<SearchTokensResponse>(url);

        return response.data;
    } catch (error) {
        console.error("Error searching intents tokens", error);
        throw error;
    }
}

export interface BulkPaymentListStatus {
    listId: string;
    status: string;
    totalPayments: number;
    processedPayments: number;
    pendingPayments: number;
}

export interface BulkPaymentListStatusResponse {
    success: boolean;
    list?: BulkPaymentListStatus;
    error?: string;
}

export interface BulkPaymentTransaction {
    recipient: string;
    amount: string;
    blockHeight: number;
}

export interface BulkPaymentTransactionsResponse {
    success: boolean;
    transactions?: BulkPaymentTransaction[];
    error?: string;
}

export interface BulkPaymentTransactionHashResponse {
    success: boolean;
    transactionHash?: string;
    blockHeight?: number;
    error?: string;
}

export interface OpenTreasuryResponse {
    accountId: string;
    isNewRegistration: boolean;
    exportCredits: number;
    batchPaymentCredits: number;
}

/**
 * Get bulk payment list status
 * Returns the status of a payment list including counts of processed/pending payments
 */
export async function getBulkPaymentListStatus(
    listId: string,
): Promise<BulkPaymentListStatusResponse | null> {
    if (!listId) return null;

    try {
        const url = `${BACKEND_API_BASE}/bulk-payment/list/${listId}`;
        const response = await axios.get<BulkPaymentListStatusResponse>(url);
        return response.data;
    } catch (error) {
        console.error(
            `Error getting bulk payment list status for ${listId}`,
            error,
        );
        return null;
    }
}

/**
 * Get all payment transactions for a bulk payment list
 * Returns the list of completed payment transactions with block heights
 */
export async function getBulkPaymentTransactions(
    listId: string,
): Promise<BulkPaymentTransactionsResponse | null> {
    if (!listId) return null;

    try {
        const url = `${BACKEND_API_BASE}/bulk-payment/list/${listId}/transactions`;
        const response = await axios.get<BulkPaymentTransactionsResponse>(url);
        return response.data;
    } catch (error) {
        console.error(
            `Error getting bulk payment transactions for ${listId}`,
            error,
        );
        return null;
    }
}

/**
 * Get the transaction hash for a specific payment recipient
 * Returns the blockchain transaction hash for a completed payment
 */
export async function getBulkPaymentTransactionHash(
    listId: string,
    recipient: string,
): Promise<BulkPaymentTransactionHashResponse | null> {
    if (!listId || !recipient) return null;

    try {
        const url = `${BACKEND_API_BASE}/bulk-payment/list/${listId}/transaction/${encodeURI(recipient)}`;
        const response =
            await axios.get<BulkPaymentTransactionHashResponse>(url);
        return response.data;
    } catch (error) {
        console.error(
            `Error getting transaction hash for ${recipient} in ${listId}`,
            error,
        );
        return null;
    }
}

/**
 * Register a treasury for monitoring
 * Called when user visits a treasury to auto-register it
 * - If not registered: creates new record with default credits (10 export, 120 batch payment)
 * - If already registered: returns existing record without changes
 */
export async function openTreasury(
    treasuryId: string,
): Promise<OpenTreasuryResponse | null> {
    if (!treasuryId) return null;

    try {
        const url = `${BACKEND_API_BASE}/monitored-accounts`;
        const response = await axios.post<OpenTreasuryResponse>(url, {
            accountId: treasuryId,
        });
        return response.data;
    } catch (error) {
        console.error(`Error registering treasury ${treasuryId}`, error);

        return null;
    }
}

/**
 * Mark a DAO as dirty, triggering immediate re-sync of membership data
 * Called after voting on policy-related proposals (add/remove member, change policy)
 * This ensures membership changes are reflected immediately without waiting for
 * the 5-minute background sync
 */
export async function markDaoDirty(daoId: string): Promise<void> {
    if (!daoId) return;

    try {
        const url = `${BACKEND_API_BASE}/dao/mark-dirty`;
        await axios.post(url, { daoId });
    } catch (error) {
        // Don't throw - this is a non-critical optimization
        console.warn(`Failed to mark DAO ${daoId} as dirty:`, error);
    }
}

/**
 * Save a treasury to user's list (used for guest treasuries)
 */
export async function saveUserTreasury(
    accountId: string,
    daoId: string,
): Promise<void> {
    if (!accountId || !daoId) return;

    try {
        const url = `${BACKEND_API_BASE}/user/treasuries/save`;
        await axios.post(url, { accountId, daoId }, { withCredentials: true });
    } catch (error) {
        console.error(
            `Failed to save treasury ${daoId} for ${accountId}`,
            error,
        );
        throw error;
    }
}

/**
 * Set treasury visibility in user's list
 */
export async function setUserTreasuryHidden(
    accountId: string,
    daoId: string,
    hidden: boolean = true,
): Promise<void> {
    if (!accountId || !daoId) return;

    try {
        const url = `${BACKEND_API_BASE}/user/treasuries/hide`;
        await axios.post(
            url,
            { accountId, daoId, hidden },
            { withCredentials: true },
        );
    } catch (error) {
        console.error(
            `Failed to set hidden=${hidden} for treasury ${daoId} and ${accountId}`,
            error,
        );
        throw error;
    }
}

/**
 * Remove treasury from user's saved list
 */
export async function removeUserTreasury(
    accountId: string,
    daoId: string,
): Promise<void> {
    if (!accountId || !daoId) return;

    try {
        const url = `${BACKEND_API_BASE}/user/treasuries/remove`;
        await axios.post(url, { accountId, daoId }, { withCredentials: true });
    } catch (error) {
        console.error(
            `Failed to remove saved treasury ${daoId} for ${accountId}`,
            error,
        );
        throw error;
    }
}

export interface IntentsQuoteRequest {
    daoId?: string;
    dry?: boolean;
    swapType?: string;
    slippageTolerance?: number;
    originAsset: string;
    depositType?: string;
    destinationAsset: string;
    amount: string;
    refundTo?: string;
    refundType?: string;
    recipient?: string;
    recipientType?: string;
    deadline: string;
    quoteWaitingTimeMs?: number;
    isPayment?: boolean;
}

export interface IntentsQuote {
    amountIn: string;
    amountInFormatted: string;
    amountInUsd: string;
    minAmountIn: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd: string;
    minAmountOut: string;
    timeEstimate: number;
    depositAddress: string;
    deadline: string;
    timeWhenInactive: string;
}

export interface IntentsQuoteResponse {
    quote: IntentsQuote;
    quoteRequest: IntentsQuoteRequest;
    signature: string;
    timestamp: string;
    correlationId: string;
}

/**
 * Get quote from 1click intents API
 * @param request - Quote request parameters
 * @param dry - If true, returns a dry quote without creating a proposal. If false, creates an actual intent proposal
 */
export async function getIntentsQuote(
    request: IntentsQuoteRequest,
    dry: boolean = true,
): Promise<IntentsQuoteResponse | null> {
    try {
        const url = `${BACKEND_API_BASE}/intents/quote`;
        const response = await axios.post<IntentsQuoteResponse>(
            url,
            {
                ...request,
                dry,
            },
            { withCredentials: true },
        );
        return response.data;
    } catch (error: any) {
        console.error(
            `Error getting intents ${dry ? "dry quote" : "proposal"}:`,
            error,
        );
        const message =
            error.response?.data || error?.message || "Failed to get quote";
        throw new Error(message);
    }
}

// ======================================================================
// Confidential Intents API
// ======================================================================

export interface GenerateIntentPayload {
    message: string; // JSON string of the intent
    nonce: string; // base64-encoded versioned nonce
    recipient: string; // "intents.near"
}

export interface GenerateIntentResponse {
    intent: {
        standard: string; // "nep413"
        payload: GenerateIntentPayload;
    };
    correlationId: string;
    /** NEP-413 payload hash (hex) — use directly in payload_v2.Eddsa */
    payloadHash: string;
}

export async function generateIntent(request: {
    type: string;
    standard: string;
    signerId: string;
    quoteMetadata: Record<string, unknown>;
    notes?: string;
}): Promise<GenerateIntentResponse> {
    const url = `${BACKEND_API_BASE}/confidential-intents/generate-intent`;
    const response = await axios.post<GenerateIntentResponse>(url, request, {
        withCredentials: true,
    });
    return response.data;
}

/**
 * Receipt Search Result
 */
export interface ReceiptSearchResult {
    receiptId: string;
    originatedFromTransactionHash: string;
}

/**
 * Search for a receipt by keyword (receipt ID) and return the originating transaction hash
 * Uses long-term caching since receipt->transaction mappings are immutable
 */
export async function searchReceipt(
    keyword: string,
): Promise<ReceiptSearchResult[]> {
    if (!keyword) return [];

    try {
        const url = `${BACKEND_API_BASE}/receipt/search`;
        const response = await axios.get<ReceiptSearchResult[]>(url, {
            params: { keyword },
        });
        return response.data;
    } catch (error) {
        console.error(`Error searching receipt for ${keyword}`, error);
        return [];
    }
}

export interface RelayDelegateActionResponse {
    success: boolean;
    error?: string;
}

export async function relayDelegateAction(
    treasuryId: string,
    signedDelegateAction: string,
    storageBytes: Big,
    proposalType?: string,
): Promise<RelayDelegateActionResponse> {
    const url = `${BACKEND_API_BASE}/relay/delegate-action`;
    const response = await axios.post<RelayDelegateActionResponse>(
        url,
        {
            signedDelegateAction: signedDelegateAction,
            storageBytes: storageBytes.toFixed(0),
            treasuryId,
            ...(proposalType ? { proposalType } : {}),
        },
        { withCredentials: true },
    );
    return response.data;
}

export interface ExportHistoryItem {
    id: number;
    accountId: string;
    generatedBy: string;
    email: string | null;
    status: string;
    fileUrl: string;
    errorMessage: string | null;
    createdAt: string;
}

export interface ExportHistoryResponse {
    data: ExportHistoryItem[];
    total: number;
}

/**
 * Get export history for an account
 */
export async function getExportHistory(
    accountId: string,
): Promise<ExportHistoryResponse> {
    const response = await axios.get<ExportHistoryResponse>(
        `${BACKEND_API_BASE}/export-history`,
        {
            params: {
                accountId,
            },
            withCredentials: true,
        },
    );
    return response.data;
}
