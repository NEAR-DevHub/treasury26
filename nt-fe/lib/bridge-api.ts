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
      `${BACKEND_API_BASE}/intents/token-metadata?defuseAssetId=${tokenIdsString}`
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
      `${BACKEND_API_BASE}/intents/blockchain-metadata?network=${networkString}&theme=${theme}`
    );
    const data = await response.json();
    
    return data || [];
  } catch (error) {
    return [];
  }
};

/**
 * Fetch all bridgeable tokens and aggregate by asset with networks
 * Enriches tokens with metadata for icons and network information
 */
export async function getAggregatedBridgeAssets(theme = "light") {
  try {
    const supported = await fetchSupportedTokens();
    // Filter for nep141 tokens only, matching the old code
    const allTokens = (supported?.tokens || []).filter(
      (t: any) => t.standard === "nep141"
    );
    
    // Deduplicate by intents_token_id to avoid double-counting balances
    const tokenMap: Record<string, any> = {};
    allTokens.forEach((t: any) => {
      if (t.intents_token_id && !tokenMap[t.intents_token_id]) {
        tokenMap[t.intents_token_id] = t;
      }
    });
    const tokens = Object.values(tokenMap);

    const defuseIds = tokens.map((t: any) => t.intents_token_id).filter(Boolean);
    
    const metadataList = defuseIds.length
      ? await fetchTokenMetadataByDefuseAssetId(defuseIds)
      : [];

    // Build metadata map
    const metadataMap: Record<string, any> = {};
    (metadataList || []).forEach((m: any) => {
      const key = m.defuseAssetId || m.defuse_asset_id || m.defuseAssetID;
      if (key) metadataMap[key] = m;
    });

    // Enrich tokens with metadata
    const enrichedTokens = allTokens
      .map((token: any) => {
        const tokenId = token.intents_token_id || token.defuse_asset_id;
        const metadata = metadataMap[tokenId];
        if (!metadata) {
          return null;
        }
        return {
          ...token,
          ...metadata,
        };
      })
      .filter((token: any) => token !== null && token.chainName);

    // Create a map for O(1) lookup of enriched tokens
    const enrichedTokenMap: Record<string, any> = {};
    enrichedTokens.forEach((token: any) => {
      enrichedTokenMap[token.intents_token_id] = token;
    });

    // Fetch network icons
    const uniqueChainNames = new Set<string>();
    enrichedTokens.forEach((token: any) => {
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

    tokens.forEach((t: any) => {
      const meta = metadataMap[t.intents_token_id];
      if (!meta) return;

      const canonicalSymbol = (meta.symbol || t.asset_name || "").toUpperCase();

      if (!assetMap[canonicalSymbol]) {
        assetMap[canonicalSymbol] = {
          id: canonicalSymbol.toLowerCase(),
          asset_name: meta.symbol || t.asset_name,
          name: meta.name || t.name,
          symbol: meta.symbol || t.asset_name,
          icon: meta.icon || null,
          networks: [],
        };
      }

      // Derive chainId from defuse_asset_identifier (matching old code exactly)
      // For "nep141:btc.omft.near" this gives "nep141:btc.omft.near" (first 2 parts)
      const parts = (t.defuse_asset_identifier || "").split(":");
      const chainId = parts.length >= 2 ? parts.slice(0, 2).join(":") : parts[0];
      
      // Get chainName from enriched token using map for O(1) lookup
      const enrichedToken = enrichedTokenMap[t.intents_token_id];
      const chainName = enrichedToken?.chainName || "";
      const netInfo = networkIconMap[chainName] || {
        name: chainName || chainId,
        icon: null,
      };

      // Use intents_token_id as the unique network identifier
      const networkId = t.intents_token_id;
      const existingNetworkIndex = assetMap[canonicalSymbol].networks.findIndex(
        (n: any) => n.id === chainId
      );

      if (existingNetworkIndex < 0) {
        assetMap[canonicalSymbol].networks.push({
          id: chainId, // Use chainId (shortened) as the network id
          name: netInfo.name,
          icon: netInfo.icon,
          chainId, // Same as id
          decimals: meta.decimals || 18,
        });
      }
    });

    const assets = Object.values(assetMap);
    return assets;
  } catch (e) {
    console.error("❌ Error in getAggregatedBridgeAssets:", e);
    return [];
  }
}

