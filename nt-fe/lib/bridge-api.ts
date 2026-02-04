import axios from "axios";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

/**
 * Fetch bridge tokens (assets available for cross-chain transfers)
 * Returns a list of assets with their available networks for bridging
 * Used for both deposit and exchange functionality
 * @param {string} theme - Theme for icons ("light" or "dark")
 */
export async function fetchBridgeTokens(theme: string = "light") {
    try {
        const response = await axios.get(
            `${BACKEND_API_BASE}/intents/bridge-tokens?theme=${theme}`,
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
export const fetchDepositAddress = async (
    accountId: string,
    chainId: string,
) => {
    try {
        if (!accountId || !chainId) {
            throw new Error("Account ID and chain ID are required");
        }

        const response = await axios.post(
            `${BACKEND_API_BASE}/intents/deposit-address`,
            {
                accountId: accountId,
                chain: chainId,
            },
        );

        return response.data || null;
    } catch (error) {
        console.error("Error fetching deposit address from backend:", error);
        throw error;
    }
};
