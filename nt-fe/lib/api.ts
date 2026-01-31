import { Policy } from "@/types/policy";
import axios from "axios";
import Big from "big.js";
import { Balance, BalanceRaw, LockupBalance, transformBalance } from "./balance";

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
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api/proxy/timezones`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      console.error("Failed to fetch timezones");
      return [];
    }

    const data = await response.json();
    return data || [];
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
}

export interface Treasury {
  daoId: string;
  config: TreasuryConfig;
}

/**
 * Get list of treasuries for a user account
 * Fetches from backend which includes config data from on-chain
 */
export async function getUserTreasuries(
  accountId: string,
): Promise<Treasury[]> {
  if (!accountId) return [];

  try {
    const url = `${BACKEND_API_BASE}/user/treasuries`;

    const response = await axios.get<Treasury[]>(url, {
      params: { accountId },
    });
    return response.data;
  } catch (error) {
    console.error("Error getting user treasuries", error);
    return [];
  }
}

export type TokenResidency = "Near" | "Ft" | "Intents" | "Lockup" | "Staked";

export interface TreasuryAsset {
  id: string;
  contractId?: string;
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
  balance: string;   // Decimal-adjusted balance
  price_usd?: number; // USD price at timestamp (null if unavailable)
  value_usd?: number; // balance * price_usd (null if unavailable)
}

export interface BalanceChartData {
  [tokenId: string]: BalanceSnapshot[];
}

export type ChartInterval = "hourly" | "daily" | "weekly" | "monthly";

export interface BalanceChartRequest {
  accountId: string;
  startTime: string; // ISO 8601 format
  endTime: string;   // ISO 8601 format
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
      account_id: params.accountId,
      start_time: params.startTime,
      end_time: params.endTime,
      interval: params.interval,
    });

    // Add token_ids as comma-separated values
    if (params.tokenIds && params.tokenIds.length > 0) {
      queryParams.append('token_ids', params.tokenIds.join(','));
    }

    const response = await axios.get<BalanceChartData>(`${url}?${queryParams.toString()}`);

    return response.data;
  } catch (error) {
    console.error("Error getting balance chart data", error);
    return null;
  }
}

export interface TokenBalance {
  account_id: string;
  token_id: string;
  balance: string;
  lockedBalance?: string;
  decimals: number;
}

export interface RecentActivity {
  id: number;
  block_time: string;
  token_id: string;
  token_metadata: {
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
      dark: string;
      light: string;
    };
  };
  counterparty: string | null;
  signer_id: string | null;
  receiver_id: string | null;
  amount: string;
  transaction_hashes: string[];
}

export interface RecentActivityResponse {
  data: RecentActivity[];
  total: number;
}

/**
 * Get recent activity (enriched balance changes) for an account
 * Returns transaction history with token metadata already included
 */
export async function getRecentActivity(
  accountId: string,
  limit: number = 50,
  offset: number = 0,
): Promise<RecentActivityResponse | null> {
  if (!accountId) return null;

  try {
    const url = `${BACKEND_API_BASE}/recent-activity`;
    const response = await axios.get<RecentActivityResponse>(url, {
      params: { account_id: accountId, limit, offset },
    });
    return response.data;
  } catch (error) {
    console.error("Error getting recent activity", error);
    return null;
  }
}

/**
 * Get balance for a single token (supports both NEAR and FT tokens)
 * Fetches current balance from blockchain via backend
 */
export async function getTokenBalance(
  accountId: string,
  tokenAddress: string,
  network: string,
): Promise<TokenBalance | null> {
  if (!accountId || !tokenAddress || !network) return null;

  try {
    const url = `${BACKEND_API_BASE}/user/balance`;

    const response = await axios.get<TokenBalance>(url, {
      params: { accountId, tokenId: tokenAddress, network },
    });

    return response.data;
  } catch (error) {
    console.error(
      `Error getting balance for ${accountId} / ${tokenAddress} / ${network}`,
      error,
    );
    return null;
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
  account_id: string;
  token_id: string;
  is_registered: boolean;
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
    console.error("Error getting batch storage deposit registrations", error);
    return [];
  }
}

export interface ChainIcons {
  dark: string;
  light: string;
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
  if (!token.startsWith("nep141:") && !token.startsWith("nep245:") && token.toLowerCase() !== "near") {
    token = `nep141:${token}`;
  }

  try {
    const url = `${BACKEND_API_BASE}/token/metadata`;

    const response = await axios.get<TokenMetadata>(url, {
      params: { tokenId: token },
    });

    return response.data;
  } catch (error) {
    console.error(
      `Error getting metadata for token ${tokenId}`,
      error,
    );
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
  accountId: string
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

export interface ProfileData {
  name?: string;
  image?: string;
  backgroundImage?: string;
  description?: string;
  linktree?: any;
  tags?: any;
}

/**
 * Get profile data from NEAR Social for a single account
 * Fetches from backend which queries social.near contract
 */
export async function getProfile(
  accountId: string,
): Promise<ProfileData | null> {
  if (!accountId) return null;

  try {
    const url = `${BACKEND_API_BASE}/user/profile`;

    const response = await axios.get<ProfileData>(url, {
      params: { accountId },
    });

    return response.data;
  } catch (error) {
    console.error(`Error getting profile for ${accountId}`, error);
    return null;
  }
}

/**
 * Get profile data from NEAR Social for multiple accounts in a single batch request
 * More efficient than making individual requests for each account
 */
export async function getBatchProfiles(
  accountIds: string[],
): Promise<Record<string, ProfileData>> {
  if (!accountIds || accountIds.length === 0) return {};

  try {
    const url = `${BACKEND_API_BASE}/user/profile/batch`;

    const response = await axios.get<Record<string, ProfileData>>(url, {
      params: { accountIds: accountIds.join(",") },
    });

    return response.data;
  } catch (error) {
    console.error("Error getting batch profiles", error);
    return {};
  }
}

export type PaymentStatus = { Paid: {}, Pending: {}, Failed: {} }

export interface BatchPayment {
  recipient: string;
  amount: string;
  status: PaymentStatus;
}

export interface BatchPaymentResponse {
  token_id: string;
  submitter: string;
  status: string;
  payments: BatchPayment[];
}

/**
 * Get batch payment details by batch ID
 * Fetches from backend which queries the batch payment contract
 */
export async function getBatchPayment(
  batchId: string
): Promise<BatchPaymentResponse | null> {
  if (!batchId) return null;

  try {
    const url = `${BACKEND_API_BASE}/bulkpayment/get`;

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
  treasuryId: string
): Promise<CheckHandleUnusedResponse | null> {
  if (!treasuryId) return null;

  try {
    const url = `${BACKEND_API_BASE}/treasury/check-handle-unused`;

    const response = await axios.get<CheckHandleUnusedResponse>(url, {
      params: { treasuryId },
    });

    return response.data;
  } catch (error) {
    console.error(`Error checking if handle is unused for ${treasuryId}`, error);
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
  accountId: string
): Promise<CheckAccountExistsResponse | null> {
  if (!accountId) return null;

  try {
    const url = `${BACKEND_API_BASE}/user/check-account-exists`;

    const response = await axios.get<CheckAccountExistsResponse>(url, {
      params: { accountId },
    });

    return response.data;
  } catch (error) {
    console.error(`Error checking if account exists for ${accountId}`, error);
    return null;
  }
}

export interface CreateTreasuryRequest {
  name: string;
  accountId: string;
  paymentThreshold: number;
  governors: string[];
  financiers: string[];
  requestors: string[];
}

export interface CreateTreasuryResponse {
  treasury: string;
}

/**
 * Create a new treasury
 * Sends a request to the backend to deploy a new treasury contract
 * Returns the created treasury account ID
 */
export async function createTreasury(
  request: CreateTreasuryRequest
): Promise<CreateTreasuryResponse> {
  try {
    const url = `${BACKEND_API_BASE}/treasury/create`;

    const response = await axios.post<CreateTreasuryResponse>(url, request);

    return response.data;
  } catch (error) {
    console.error("Error creating treasury", error);
    throw error;
  }
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
  params: SearchTokensParams
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
      queryParams.append("intentsTokenContractId", params.intentsTokenContractId);
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
  list_id: string;
  status: string;
  total_payments: number;
  processed_payments: number;
  pending_payments: number;
}

export interface BulkPaymentListStatusResponse {
  success: boolean;
  list?: BulkPaymentListStatus;
  error?: string;
}

export interface BulkPaymentTransaction {
  recipient: string;
  amount: string;
  block_height: number;
}

export interface BulkPaymentTransactionsResponse {
  success: boolean;
  transactions?: BulkPaymentTransaction[];
  error?: string;
}

export interface BulkPaymentTransactionHashResponse {
  success: boolean;
  transaction_hash?: string;
  block_height?: number;
  error?: string;
}

export interface OpenTreasuryResponse {
  account_id: string;
  is_new_registration: boolean;
  export_credits: number;
  batch_payment_credits: number;
}

/**
 * Get bulk payment list status
 * Returns the status of a payment list including counts of processed/pending payments
 */
export async function getBulkPaymentListStatus(
  listId: string
): Promise<BulkPaymentListStatusResponse | null> {
  if (!listId) return null;

  try {
    const url = `${BACKEND_API_BASE}/bulk-payment/list/${listId}`;
    const response = await axios.get<BulkPaymentListStatusResponse>(url);
    return response.data;
  } catch (error) {
    console.error(`Error getting bulk payment list status for ${listId}`, error);
    return null;
  }
}

/**
 * Get all payment transactions for a bulk payment list
 * Returns the list of completed payment transactions with block heights
 */
export async function getBulkPaymentTransactions(
  listId: string
): Promise<BulkPaymentTransactionsResponse | null> {
  if (!listId) return null;

  try {
    const url = `${BACKEND_API_BASE}/bulk-payment/list/${listId}/transactions`;
    const response = await axios.get<BulkPaymentTransactionsResponse>(url);
    return response.data;
  } catch (error) {
    console.error(`Error getting bulk payment transactions for ${listId}`, error);
    return null;
  }
}

/**
 * Get the transaction hash for a specific payment recipient
 * Returns the blockchain transaction hash for a completed payment
 */
export async function getBulkPaymentTransactionHash(
  listId: string,
  recipient: string
): Promise<BulkPaymentTransactionHashResponse | null> {
  if (!listId || !recipient) return null;

  try {
    const url = `${BACKEND_API_BASE}/bulk-payment/list/${listId}/transaction/${encodeURI(recipient)}`;
    const response = await axios.get<BulkPaymentTransactionHashResponse>(url);
    return response.data;
  } catch (error) {
    console.error(`Error getting transaction hash for ${recipient} in ${listId}`, error);
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
  treasuryId: string
): Promise<OpenTreasuryResponse | null> {
  if (!treasuryId) return null;

  try {
    const url = `${BACKEND_API_BASE}/monitored-accounts`;
    const response = await axios.post<OpenTreasuryResponse>(url, {
      account_id: treasuryId,
    });
    return response.data;
  } catch (error) {
    console.error(`Error registering treasury ${treasuryId}`, error);
    return null;
  }
}
