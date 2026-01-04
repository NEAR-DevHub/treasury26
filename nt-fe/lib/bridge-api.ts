const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

/**
 * Fetch deposit assets (aggregated tokens with networks)
 * Returns a clean list of assets with their available networks
 * @param {string} theme - Theme for icons ("light" or "dark")
 */
export async function fetchDepositAssets(theme: string = "light") {
  try {
    const response = await fetch(`${BACKEND_API_BASE}/intents/deposit-assets?theme=${theme}`);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data.assets || [];
  } catch (error) {
    console.error("Error fetching deposit assets:", error);
    throw error;
  }
}

/**
 * Fetch deposit address for a specific account and chain via backend
 * @param {string} accountId - NEAR account ID
 * @param {string} chainId - Chain identifier (e.g., "nep141:btc.omft.near")
 * @returns {Promise<Object>} Result object containing deposit address
 */
export const fetchDepositAddress = async (accountId: string, chainId: string) => {
  try {
    if (!accountId || !chainId) {
      throw new Error("Account ID and chain ID are required");
    }

    const response = await fetch(`${BACKEND_API_BASE}/intents/deposit-address`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        chain: chainId,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data || null;
  } catch (error) {
    console.error("Error fetching deposit address from backend:", error);
    throw error;
  }
};
