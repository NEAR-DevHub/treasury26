import type { BridgeAsset } from "@/hooks/use-bridge-tokens";
import { normalizeNearAssetId } from "@/lib/utils";

type TokenLike =
    | {
          address?: string | null;
          symbol?: string | null;
      }
    | null
    | undefined;

const normalizeKey = (value?: string | null): string | null => {
    if (!value) return null;
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
};

function networkMatchesAddress(
    networkId: string,
    tokenAddress: string,
): boolean {
    return (
        normalizeNearAssetId(networkId) === normalizeNearAssetId(tokenAddress)
    );
}

/**
 * Resolve the bridge asset for a selected token address.
 * Works for both intents ids (`nep141:...`) and NEAR FT variant ids.
 */
export function findBridgeAssetByTokenAddress(
    bridgeAssets: BridgeAsset[],
    tokenAddress?: string | null,
): BridgeAsset | null {
    const normalizedAddress = normalizeKey(tokenAddress);
    if (!normalizedAddress) return null;

    return (
        bridgeAssets.find((asset) =>
            asset.networks.some((network) =>
                networkMatchesAddress(network.id, normalizedAddress),
            ),
        ) ?? null
    );
}

export interface BridgeScope {
    /** Bridge asset id (coarse, e.g. "usdc"). Null when unresolved. */
    token: string | null;
    /** Per-chain bridge network id (e.g. "nep141:eth.omft.near"). */
    network: string | null;
}

/**
 * Resolve a token address (contract / intents id) to the warning scope ids the
 * admin form stores: the bridge asset id and the specific network id. Used so
 * create flows and proposal-approval checks can match token/network-scoped
 * warnings by id instead of display name.
 */
export function resolveBridgeScope(
    bridgeAssets: BridgeAsset[],
    tokenAddress?: string | null,
): BridgeScope {
    const normalizedAddress = normalizeKey(tokenAddress);
    if (!normalizedAddress) return { token: null, network: null };

    const asset = findBridgeAssetByTokenAddress(
        bridgeAssets,
        normalizedAddress,
    );
    if (!asset) return { token: null, network: null };

    const network =
        asset.networks.find((n) =>
            networkMatchesAddress(n.id, normalizedAddress),
        ) ?? null;

    return { token: asset.id, network: network?.id ?? null };
}

/**
 * Resolve bridge asset for a selected token.
 *
 * Match priority:
 * 1) token address vs bridge network ids (most specific)
 * 2) token address vs bridge asset id (native NEAR uses address "near")
 * 3) token symbol vs bridge asset id (legacy fallback)
 */
export function findBridgeAssetForToken(
    bridgeAssets: BridgeAsset[],
    token?: TokenLike,
): BridgeAsset | null {
    return findBridgeAssetForTokenMatch(bridgeAssets, token);
}

export function findBridgeAssetForTokenMatch(
    bridgeAssets: BridgeAsset[],
    token?: TokenLike,
): BridgeAsset | null {
    const normalizedAddress = normalizeKey(token?.address);
    const normalizedSymbol = normalizeKey(token?.symbol);
    if (!normalizedAddress && !normalizedSymbol) {
        return null;
    }

    let byAddressId: BridgeAsset | null = null;
    let bySymbolId: BridgeAsset | null = null;

    for (const asset of bridgeAssets) {
        if (
            normalizedAddress &&
            asset.networks.some((network) =>
                networkMatchesAddress(network.id, normalizedAddress),
            )
        ) {
            return asset;
        }

        const normalizedAssetId = normalizeKey(asset.id);
        if (!normalizedAssetId) continue;

        if (!byAddressId && normalizedAddress === normalizedAssetId) {
            byAddressId = asset;
        }
        if (!bySymbolId && normalizedSymbol === normalizedAssetId) {
            bySymbolId = asset;
        }
    }

    if (byAddressId) {
        return byAddressId;
    }
    if (bySymbolId) {
        return bySymbolId;
    }

    return null;
}
