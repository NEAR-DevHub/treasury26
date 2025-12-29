const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

/**
 * Fetch all supported tokens from the bridge via backend
 * @returns {Promise<Object>} Result object containing tokens array
 */
export const fetchSupportedTokens = async () => {
  try {
    const response = await fetch(`${BACKEND_API_BASE}/intents/supported-tokens`);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data || null;
  } catch (error) {
    throw error;
  }
};

/**
 * Fetch deposit address for a specific account and chain via backend
 * @param {string} accountId - NEAR account ID
 * @param {string} chainId - Chain identifier (e.g., "eth:1")
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
    throw error;
  }
};

// Fetch token metadata by defuse asset ID
// Returns token metadata including symbol, icon, decimals, price, blockchain
export const fetchTokenMetadataByDefuseAssetId = async (defuseAssetIds: string | string[]) => {
  try {
    if (!defuseAssetIds) {
      return [];
    }

    const tokenIdsString = Array.isArray(defuseAssetIds)
      ? defuseAssetIds.join(",")
      : defuseAssetIds;

    const response = await fetch(
      `${BACKEND_API_BASE}/proxy/token-by-defuse-asset-id?defuseAssetId=${tokenIdsString}`
    );
    const data = await response.json();
    
    return data || [];
  } catch (error) {
    return [];
  }
};

// Fetch blockchain metadata by network name
// Returns blockchain metadata including name and icon
export const fetchBlockchainByNetwork = async (networks: string | string[], theme = "light") => {
  try {
    if (!networks) {
      return [];
    }

    const networkString = Array.isArray(networks)
      ? networks.join(",")
      : networks;

    const response = await fetch(
      `${BACKEND_API_BASE}/proxy/blockchain-by-network?network=${networkString}&theme=${theme}`
    );
    const data = await response.json();
    
    return data || [];
  } catch (error) {
    return [];
  }
};

/**
 * Fetch all bridgeable tokens and aggregate by asset with networks
 * The backend already returns enriched tokens with metadata
 */
export async function getAggregatedBridgeAssets(theme = "light") {
  try {
    const supported = await fetchSupportedTokens();
    const allTokens = (supported?.tokens || []);

    // Fetch network icons
    const uniqueChainNames = new Set<string>();
    allTokens.forEach((token: any) => {
      if (token.chainName) {
        uniqueChainNames.add(token.chainName);
      }
    });

    const networkResults = await fetchBlockchainByNetwork(
      Array.from(uniqueChainNames),
      theme
    );

    const networkIconMap: Record<string, any> = {};
    (networkResults || []).forEach((network: any) => {
      if (network.network && network.icon) {
        networkIconMap[network.network] = {
          name: network.name || network.network,
          icon: network.icon,
        };
      }
    });

    // Group by canonical symbol
    const assetMap: Record<string, any> = {};

    allTokens.forEach((token: any) => {
      const canonicalSymbol = (token.symbol || token.asset_name || "").toUpperCase();

      if (!assetMap[canonicalSymbol]) {
        assetMap[canonicalSymbol] = {
          id: canonicalSymbol.toLowerCase(),
          asset_name: token.asset_name,
          name: token.name,
          symbol: token.symbol || token.asset_name,
          icon: token.icon || null,
          networks: [],
        };
      }

      // Derive chain id from defuse_asset_id
      const parts = (token.defuse_asset_id || "").split(":");
      const chainId = parts.length >= 2 ? parts.slice(0, 2).join(":") : parts[0];
      
      const chainName = token.chainName;
      const netInfo = networkIconMap[chainName] || {
        name: chainName || chainId,
        icon: null,
      };

      const networkId = token.intents_token_id || token.defuse_asset_id;
      const existingNetworkIndex = assetMap[canonicalSymbol].networks.findIndex(
        (n: any) => n.id === networkId
      );

      if (existingNetworkIndex < 0) {
        assetMap[canonicalSymbol].networks.push({
          id: networkId,
          name: netInfo.name,
          icon: netInfo.icon,
          chainId,
          decimals: token.decimals || 18,
        });
      }
    });

    const assets = Object.values(assetMap);
    return assets;
  } catch (e) {
    return [];
  }
}

