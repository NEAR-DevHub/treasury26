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
    const url = `${BACKEND_API_BASE}/user-treasuries`;

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
 * Get whitelisted tokens with balances and prices for an account
 * Fetches from backend which aggregates data from Ref Finance and FastNear
 * Returns transformed data with calculated USD values and weights
 */
export async function getTreasuryAssets(
  treasuryId: string
): Promise<TreasuryAssets> {
  if (!treasuryId) return { tokens: [], totalBalanceUSD: 0 };

  try {
    const url = `${BACKEND_API_BASE}/whitelist-tokens`;

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
