import { Policy } from "@/types/policy";
import axios from "axios";
import Big from "big.js";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;
export interface TreasuryMetadata {
  primaryColor?: string;
  flagLogo?: string;
  theme?: string;
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
  accountId: string
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

export interface TreasuryAsset {
  id: string;
  decimals: number;
  balance: Big;
  balanceUSD: number;
  price: number;
  symbol: string;
  name: string;
  icon: string;
  weight: number;
  network: string;
}

export interface TreasuryAssets {
  tokens: TreasuryAsset[];
  totalBalanceUSD: Big;
}

interface TreasuryAssetRaw {
  id: string;
  decimals: number;
  balance: string;
  price: string;
  symbol: string;
  name: string;
  icon: string;
  network: string;
}

/**
 * Get treasury assets (tokens with balances and prices)
 * Fetches from backend which aggregates data from Ref Finance and FastNear
 * Returns transformed data with calculated USD values and weights
 */
export async function getTreasuryAssets(
  treasuryId: string
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
        decimals: token.decimals,
        balance: Big(token.balance),
        balanceUSD,
        price,
        symbol: token.symbol,
        name: token.name,
        icon: token.icon,
        weight: 0,
        network: token.network,
      };
    });

    // Calculate total USD value
    const totalUSD = tokensWithUSD.reduce(
      (sum, token) => sum.add(token.balanceUSD),
      Big(0)
    );

    // Calculate weights
    const tokens: TreasuryAsset[] = tokensWithUSD.map((token) => ({
      ...token,
      weight: totalUSD.gt(0) ? Big(token.balanceUSD).div(totalUSD).mul(100).toNumber() : 0,
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
  "All": BalanceHistoryEntry[];
}

/**
 * Get balance history for a specific token
 * Fetches historical balance data across multiple time periods
 */
export async function getTokenBalanceHistory(
  accountId: string,
  tokenId: string
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

export interface TokenPrice {
  token_id: string;
  price: number;
  source: string;
}

/**
 * Get price for a single token (supports both NEAR and FT tokens)
 * Fetches from backend which aggregates data from multiple price sources
 */
export async function getTokenPrice(tokenId: string, network: string): Promise<TokenPrice | null> {
  if (!tokenId) return null;

  try {
    const url = `${BACKEND_API_BASE}/token/price`;

    const response = await axios.get<TokenPrice>(url, {
      params: { tokenId, network },
    });

    return response.data;
  } catch (error) {
    console.error(`Error getting price for token ${tokenId} / ${network}`, error);
    return null;
  }
}

/**
 * Get prices for multiple tokens in a single batch request
 * More efficient than making individual requests for each token
 */
export async function getBatchTokenPrices(
  tokenIds: string[]
): Promise<TokenPrice[]> {
  if (!tokenIds || tokenIds.length === 0) return [];

  try {
    const url = `${BACKEND_API_BASE}/token/price/batch`;

    const response = await axios.get<TokenPrice[]>(url, {
      params: { tokenIds: tokenIds.join(',') },
    });

    return response.data;
  } catch (error) {
    console.error("Error getting batch token prices", error);
    return [];
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
  network: string
): Promise<TokenBalance | null> {
  if (!accountId || !tokenAddress || !network) return null;

  try {
    const url = `${BACKEND_API_BASE}/user/balance`;

    const response = await axios.get<TokenBalance>(url, {
      params: { accountId, tokenId: tokenAddress, network },
    });

    return response.data;
  } catch (error) {
    console.error(`Error getting balance for ${accountId} / ${tokenAddress} / ${network}`, error);
    return null;
  }
}

/**
 * Get balances for multiple tokens in a single batch request
 * More efficient than making individual requests for each token
 */
export async function getBatchTokenBalances(
  accountId: string,
  tokenIds: string[]
): Promise<TokenBalance[]> {
  if (!accountId || !tokenIds || tokenIds.length === 0) return [];

  try {
    const url = `${BACKEND_API_BASE}/user/balance/batch`;

    const response = await axios.get<TokenBalance[]>(url, {
      params: { accountId, tokenIds: tokenIds.join(',') },
    });

    return response.data;
  } catch (error) {
    console.error("Error getting batch token balances", error);
    return [];
  }
}

/**
 * Get treasury policy including roles, permissions, and approval settings
 * Fetches from backend which queries the treasury contract
 */
export async function getTreasuryPolicy(
  treasuryId: string
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
  tokenId: string
): Promise<boolean> {
  if (!accountId || !tokenId) return false;

  try {
    const url = `${BACKEND_API_BASE}/token/storage-deposit/is-registered`;

    const response = await axios.get<boolean>(url, {
      params: { accountId, tokenId },
    });

    return response.data;
  } catch (error) {
    console.error(`Error getting storage deposit is registered for ${accountId} / ${tokenId}`, error);
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
  requests: StorageDepositRequest[]
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
