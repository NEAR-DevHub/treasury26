import axios from "axios";

const BACKEND_API_BASE = process.env.NEXT_PUBLIC_BACKEND_API_BASE || "";

interface Logger {
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, error?: unknown) => void;
}

const logger: Logger = {
  info: (message, data) => console.log(message, data),
  warn: (message, data) => console.warn(message, data),
  error: (message, error) => console.error(message, error),
};

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
    logger.info("Fetching user treasuries", { accountId, url });

    const response = await axios.get<Treasury[]>(url, {
      params: { accountId },
    });

    logger.info("Successfully fetched user treasuries", {
      count: response.data.length,
    });

    return response.data;
  } catch (error) {
    logger.error("Error getting user treasuries", error);
    return [];
  }
}
