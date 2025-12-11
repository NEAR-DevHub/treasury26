import axios from "axios";

const BACKEND_API_BASE = process.env.NEXT_PUBLIC_BACKEND_API_BASE || "";
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

export interface WhitelistToken {
  id: string;
  decimals: number;
  balance: bigint;
  balanceUSD: number;
  price: number;
  symbol: string;
  name: string;
  icon: string;
  weight: number;
}

export interface TreasuryAssets {
  tokens: WhitelistToken[];
  totalBalanceUSD: number;
}

interface WhitelistTokenRaw {
  id: string;
  decimals: number;
  balance: string;
  price: string;
  symbol: string;
  name: string;
  icon: string;
}

/**
 * Get treasury assets (tokens with balances and prices)
 * Fetches from backend which aggregates data from Ref Finance and FastNear
 * Returns transformed data with calculated USD values and weights
 */
export async function getTreasuryAssets(
  treasuryId: string
): Promise<TreasuryAssets> {
  if (!treasuryId) return { tokens: [], totalBalanceUSD: 0 };

  try {
    const url = `${BACKEND_API_BASE}/user/assets`;

    const response = await axios.get<WhitelistTokenRaw[]>(url, {
      params: { accountId: treasuryId },
    });


    // Transform raw tokens with USD values
    const tokensWithUSD = response.data.map((token) => {
      const parsedBalance =
        BigInt(token.balance) / BigInt(10) ** BigInt(token.decimals);
      const balanceFull = Number(parsedBalance);
      const price = parseFloat(token.price);
      const balanceUSD = balanceFull * price;

      return {
        id: token.id,
        decimals: token.decimals,
        balance: BigInt(token.balance),
        balanceUSD,
        price,
        symbol: token.symbol,
        name: token.name,
        icon: token.icon,
        weight: 0,
      };
    });

    // Calculate total USD value
    const totalUSD = tokensWithUSD.reduce(
      (sum, token) => sum + token.balanceUSD,
      0
    );

    // Calculate weights
    const tokens = tokensWithUSD.map((token) => ({
      ...token,
      weight: totalUSD > 0 ? (token.balanceUSD / totalUSD) * 100 : 0,
    }));

    return {
      tokens,
      totalBalanceUSD: totalUSD,
    };
  } catch (error) {
    console.error("Error getting whitelist tokens", error);
    return { tokens: [], totalBalanceUSD: 0 };
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
export async function getTokenPrice(tokenId: string): Promise<TokenPrice | null> {
  if (!tokenId) return null;

  try {
    const url = `${BACKEND_API_BASE}/token/price`;

    const response = await axios.get<TokenPrice>(url, {
      params: { tokenId },
    });

    return response.data;
  } catch (error) {
    console.error(`Error getting price for token ${tokenId}`, error);
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
  tokenId: string
): Promise<TokenBalance | null> {
  if (!accountId || !tokenId) return null;

  try {
    const url = `${BACKEND_API_BASE}/user/balance`;

    const response = await axios.get<TokenBalance>(url, {
      params: { accountId, tokenId },
    });

    return response.data;
  } catch (error) {
    console.error(`Error getting balance for ${accountId} / ${tokenId}`, error);
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
