import { Policy } from "@/types/policy";
import axios from "axios";
import Big from "big.js";

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

export type TokenResidency = "Near" | "Ft" | "Intents";

export interface TreasuryAsset {
  id: string;
  contractId?: string;
  residency: TokenResidency;
  network: string;
  symbol: string;
  balance: Big;
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
  symbol: string;
  balance: string;
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
      const balance = Big(token.balance).div(Big(10).pow(token.decimals));
      const price = parseFloat(token.price);
      const balanceUSD = balance.mul(price).toNumber();

      return {
        id: token.id,
        contractId: token.contractId,
        residency: token.residency,
        network: token.network,
        symbol: token.symbol === "wNEAR" ? "NEAR" : token.symbol,
        decimals: token.decimals,
        balance: Big(token.balance),
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

export interface BalanceHistoryEntry {
  timestamp: number;
  date: string;
  balance: string;
  decimals: number;
}

export interface TokenBalanceHistory {
  "1H": BalanceHistoryEntry[];
  "1D": BalanceHistoryEntry[];
  "1W": BalanceHistoryEntry[];
  "1M": BalanceHistoryEntry[];
  "1Y": BalanceHistoryEntry[];
  All: BalanceHistoryEntry[];
}

/**
 * Get balance history for a specific token
 * Fetches historical balance data across multiple time periods
 */
export async function getTokenBalanceHistory(
  accountId: string,
  tokenId: string,
): Promise<TokenBalanceHistory | null> {
  if (!accountId || !tokenId) return null;

  try {
    const url = `${BACKEND_API_BASE}/user/balance/history`;

    const response = await axios.get<TokenBalanceHistory>(url, {
      params: { accountId, tokenId },
    });

    return response.data;
  } catch (error) {
    console.error("Error getting token balance history", error);
    return null;
  }
}

export interface TokenBalance {
  account_id: string;
  token_id: string;
  balance: string;
  decimals: number;
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
 * Get balances for multiple tokens in a single batch request
 * More efficient than making individual requests for each token
 */
export async function getBatchTokenBalances(
  accountId: string,
  tokenIds: string[],
): Promise<TokenBalance[]> {
  if (!accountId || !tokenIds || tokenIds.length === 0) return [];

  try {
    const url = `${BACKEND_API_BASE}/user/balance/batch`;

    const response = await axios.get<TokenBalance[]>(url, {
      params: { accountId, tokenIds: tokenIds.join(",") },
    });

    return response.data;
  } catch (error) {
    console.error("Error getting batch token balances", error);
    return [];
  }
}

/**
 * Get treasury config for a specific treasury
 * Fetches from backend which queries the treasury contract for config data
 */
export async function getTreasuryConfig(
  treasuryId: string,
): Promise<Treasury | null> {
  if (!treasuryId) return null;

  try {
    const url = `${BACKEND_API_BASE}/treasury/config`;

    const response = await axios.get<Treasury>(url, {
      params: { treasuryId },
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
): Promise<Policy | null> {
  if (!treasuryId) return null;

  try {
    const url = `${BACKEND_API_BASE}/treasury/policy`;

    const response = await axios.get<Policy>(url, {
      params: { treasuryId },
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

export interface TokenMetadata {
  token_id: string;
  name: string;
  symbol: string;
  decimals: number;
  icon?: string;
  price?: number;
  price_updated_at?: string;
  blockchain?: string;
  chain_name?: string;
}

/**
 * Get metadata for a single token
 * Fetches token name, symbol, decimals, and icon from the blockchain
 */
export async function getTokenMetadata(
  tokenId: string,
  network: string,
): Promise<TokenMetadata | null> {
  if (!tokenId || !network) return null;

  let token = tokenId;
  if (!token.startsWith("nep141:") && token.toLowerCase() !== "near") {
    token = `nep141:${token}`;
  }

  try {
    const url = `${BACKEND_API_BASE}/token/metadata`;

    const response = await axios.get<TokenMetadata>(url, {
      params: { tokenId: token, network },
    });

    return response.data;
  } catch (error) {
    console.error(
      `Error getting metadata for token ${tokenId} / ${network}`,
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
