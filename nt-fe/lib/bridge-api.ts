import axios from "axios";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

/**
 * Fetch bridge tokens (assets available for cross-chain transfers)
 * Returns a list of assets with their available networks for bridging
 * Used for both deposit and exchange functionality
 */
export async function fetchBridgeTokens(options?: {
    includeNearNetwork?: boolean;
}) {
    const includeNearNetwork = options?.includeNearNetwork ?? false;
    try {
        const response = await axios.get(
            `${BACKEND_API_BASE}/intents/bridge-tokens`,
            {
                params: {
                    includeNearNetwork,
                },
            },
        );

        return response.data.assets || [];
    } catch (error) {
        console.error("Error fetching bridge tokens:", error);
        throw error;
    }
}

/**
 * Fetch deposit address for a specific account and chain via backend
 * @param {string} accountId - NEAR account ID
 * @param {string} chainId - Chain identifier (e.g., "nep141:btc.omft.near")
 * @returns {Promise<Object>} Result object containing deposit address
 */
export type DepositAddressResponse = {
    address: string;
    memo?: string | null;
    minAmount?: string | null;
    /** ISO-8601 expiry for one-time confidential deposit addresses (14 days). */
    expiresAt?: string | null;
    /**
     * Intents quote deposit address for confidential status lookups.
     * Differs from `address` when the bridge remaps onto a chain deposit address.
     */
    quoteDepositAddress?: string | null;
};

export type DepositAddressStatusResponse = {
    depositAddress: string;
    found: boolean;
    status?: string | null;
    createdAt?: string | null;
    expiresAt?: string | null;
    originAsset?: string | null;
    destinationAsset?: string | null;
    amountInFormatted?: string | null;
};

export const fetchDepositAddress = async (
    accountId: string,
    chainId: string,
    tokenId?: string,
    amount?: string,
): Promise<DepositAddressResponse | null> => {
    try {
        if (!accountId || !chainId) {
            throw new Error("Account ID and chain ID are required");
        }

        const response = await axios.post<DepositAddressResponse>(
            `${BACKEND_API_BASE}/intents/deposit-address`,
            {
                accountId: accountId,
                chain: chainId,
                tokenId: tokenId,
                amount: amount,
            },
            { withCredentials: true },
        );

        return response.data || null;
    } catch (error) {
        console.error("Error fetching deposit address from backend:", error);
        throw error;
    }
};

/**
 * Look up confidential one-time deposit status via 1Click history
 * (`depositAddress` filter). Pass the quote deposit address from generate.
 */
export const fetchDepositAddressStatus = async (
    accountId: string,
    depositAddress: string,
): Promise<DepositAddressStatusResponse> => {
    if (!accountId || !depositAddress) {
        throw new Error("Account ID and deposit address are required");
    }

    const response = await axios.get<DepositAddressStatusResponse>(
        `${BACKEND_API_BASE}/intents/deposit-address/status`,
        {
            params: {
                accountId,
                depositAddress,
            },
            withCredentials: true,
        },
    );

    return response.data;
};
