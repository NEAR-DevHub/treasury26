import type { Token } from "@/components/token-input";
import { NEAR_COM_NETWORK_ID, NEAR_NETWORK_ID } from "@/constants/network-ids";
import type { BridgeAsset } from "@/hooks/use-bridge-tokens";
import { getBlockchainType } from "@/lib/blockchain-utils";
import { normalizeNearAssetId } from "@/lib/utils";

/** Soft `?networks=eth,near` list (trimmed, non-empty). */
export function parseSoftNetworks(
    networksParam: string | null | undefined,
): string[] {
    return (networksParam ?? "")
        .split(",")
        .map((network) => network.trim())
        .filter(Boolean);
}

/** Map pay-share `near.com` to bridge `near` for token/network matching. */
export function normalizePreferredNetwork(network: string): string {
    const normalized = network.trim().toLowerCase();
    if (normalized === NEAR_COM_NETWORK_ID) {
        return NEAR_NETWORK_ID;
    }
    return normalized;
}

/**
 * Intents / defuse ids contain `:` (`nep141:…`, `eth:1:0x…`).
 * Soft chain names (`eth`, `near`) never include `:`.
 */
export function isIntentsNetworkId(value: string): boolean {
    return value.includes(":");
}

/** Bare NEAR FT contract in `?network=` (no `nep141:` / defuse prefix). */
export function isBareNearContractId(value: string): boolean {
    const v = value.trim();
    if (!v || v.includes(":")) return false;
    return /\.near$/i.test(v) || /^[a-f0-9]{64}$/i.test(v);
}

/** Aggregated asset id / symbol for native NEAR (`NEAR` / `near` / `wnear`). */
export function isNativeNearTokenParam(
    value: string | null | undefined,
): boolean {
    const v = value?.trim().toLowerCase();
    return v === NEAR_NETWORK_ID || v === "wnear";
}

/** True when `?token=` is the legacy JSON blob from assets-table links. */
export function isJsonTokenQueryParam(param: string): boolean {
    try {
        const decoded = decodeURIComponent(param).trim();
        return decoded.startsWith("{");
    } catch {
        return param.trim().startsWith("{");
    }
}

/** Native NEAR deep link: `token=NEAR&network=near`. */
export function isNativeNearPrefill(params: {
    tokenParam: string | null;
    networkParam: string | null;
}): boolean {
    if (!isNativeNearTokenParam(params.tokenParam)) return false;
    return params.networkParam?.trim().toLowerCase() === NEAR_NETWORK_ID;
}

/** Destination prefs from hybrid `network` / `networks` query params. */
export function resolvePreferredNetworks(params: {
    softNetworks: readonly string[];
    networkParam: string | null;
    isFtNetworkPrefill: boolean;
    isNativeNearPrefill: boolean;
}): string[] {
    if (params.softNetworks.length > 0) {
        return [...params.softNetworks];
    }
    if (params.isFtNetworkPrefill || params.isNativeNearPrefill) {
        return [NEAR_NETWORK_ID];
    }
    const singular = params.networkParam?.trim();
    return singular ? [singular] : [];
}

/** Soft-prefill NEAR destination for Ft / native NEAR deep links. */
export function nearChainDestination(): {
    id: string;
    networkName: string;
} {
    return {
        id: NEAR_NETWORK_ID,
        networkName: NEAR_NETWORK_ID,
    };
}

export function networkIdsMatch(a: string, b: string): boolean {
    if (a === b || a.toLowerCase() === b.toLowerCase()) return true;
    return normalizeNearAssetId(a) === normalizeNearAssetId(b);
}

export function tokenFromBridgeNetwork(
    asset: BridgeAsset,
    network: BridgeAsset["networks"][number],
    residency: "Intents" | "Ft" = "Intents",
): Token {
    if (residency === "Ft") {
        return {
            address: normalizeNearAssetId(network.id),
            symbol: network.symbol,
            decimals: network.decimals,
            name: asset.name,
            icon: asset.icon,
            network: network.name,
            chainIcons: network.chainIcons ?? undefined,
            residency: "Ft",
        };
    }
    return {
        address: network.id,
        symbol: network.symbol,
        decimals: network.decimals,
        name: asset.name,
        icon: asset.icon,
        network: network.name,
        chainIcons: network.chainIcons ?? undefined,
        residency: "Intents",
        minWithdrawalAmount: network.minWithdrawalAmount,
        minDepositAmount: network.minDepositAmount,
    };
}

function getNetworkMatchScore(
    tokenNetwork: string,
    preferredNetworks: string[],
): number {
    const normalizedTokenNetwork = tokenNetwork.trim().toLowerCase();
    const tokenBlockchain = getBlockchainType(normalizedTokenNetwork);
    let bestScore = 0;

    preferredNetworks.forEach((preferredNetwork, index) => {
        const normalizedPreferredNetwork =
            normalizePreferredNetwork(preferredNetwork);

        if (normalizedPreferredNetwork === normalizedTokenNetwork) {
            bestScore = Math.max(bestScore, 200 - index);
            return;
        }

        const preferredBlockchain = getBlockchainType(
            normalizedPreferredNetwork,
        );

        if (
            preferredBlockchain !== "unknown" &&
            preferredBlockchain === tokenBlockchain
        ) {
            bestScore = Math.max(bestScore, 100 - index);
        }
    });

    return bestScore;
}

export function pickCompatibleFallbackToken(
    preferredNetworks: string[],
    bridgeAssets: BridgeAsset[],
    preferredAssetId?: string | null,
): Token | null {
    let bestCandidate: { score: number; token: Token } | null = null;
    const normalizedAsset = preferredAssetId?.trim().toLowerCase() || null;

    for (const asset of bridgeAssets) {
        if (normalizedAsset && asset.id.toLowerCase() !== normalizedAsset) {
            continue;
        }

        for (const network of asset.networks) {
            const networkScore = getNetworkMatchScore(
                network.name,
                preferredNetworks,
            );

            if (networkScore === 0) {
                continue;
            }

            const candidate = tokenFromBridgeNetwork(asset, network);

            if (!bestCandidate || networkScore > bestCandidate.score) {
                bestCandidate = {
                    score: networkScore,
                    token: candidate,
                };
            }
        }
    }

    return bestCandidate?.token ?? null;
}

/**
 * Exact token from `?token=<assetId>&network=<id>`.
 * Prefixed network → Intents; bare NEAR contract → Ft.
 */
export function resolveExactBridgeToken(
    bridgeAssets: BridgeAsset[],
    assetId: string | null,
    networkId: string | null,
): Token | null {
    if (!bridgeAssets.length || !networkId) return null;

    const tokenResidency = isBareNearContractId(networkId)
        ? "Ft"
        : isIntentsNetworkId(networkId)
          ? "Intents"
          : null;
    if (!tokenResidency) return null;

    const normalizedAsset = assetId?.trim().toLowerCase() || null;
    let networkOnlyMatch: Token | null = null;

    for (const asset of bridgeAssets) {
        const network = asset.networks.find((item) =>
            networkIdsMatch(item.id, networkId),
        );
        if (!network) continue;

        // Ft variant only exists for NEAR nep141 bridge rows (same as token-select).
        if (tokenResidency === "Ft" && !network.id.startsWith("nep141:")) {
            continue;
        }

        const token = tokenFromBridgeNetwork(asset, network, tokenResidency);
        if (!normalizedAsset || asset.id.toLowerCase() === normalizedAsset) {
            return token;
        }
        // Prefer asset-id match; fall back to network id alone (authoritative).
        networkOnlyMatch ??= token;
    }

    return networkOnlyMatch;
}

/**
 * Resolve destination from `?network=` / `?networks=` deep links.
 * Prefer exact intents network id, then bridge name, then unique chain type.
 */
export function resolvePreferredDestinationNetwork(
    bridgeAsset: BridgeAsset,
    preferredNetworks: string[],
    preferredBlockchainTypes: Set<string>,
): { id: string; networkName: string } | null {
    const normalizedPreferred = preferredNetworks.map(
        normalizePreferredNetwork,
    );

    for (const preferred of normalizedPreferred) {
        const byId = bridgeAsset.networks.find((network) =>
            networkIdsMatch(network.id, preferred),
        );
        if (byId) {
            return { id: byId.id, networkName: byId.name };
        }
    }

    for (const preferred of normalizedPreferred) {
        const byName = bridgeAsset.networks.filter(
            (network) => network.name.toLowerCase() === preferred,
        );
        if (byName.length === 1) {
            return { id: byName[0].id, networkName: byName[0].name };
        }
    }

    // Soft chain-type match only when exactly one network qualifies.
    const byType = bridgeAsset.networks.filter((network) =>
        preferredBlockchainTypes.has(getBlockchainType(network.name)),
    );
    if (byType.length !== 1) return null;

    return { id: byType[0].id, networkName: byType[0].name };
}
