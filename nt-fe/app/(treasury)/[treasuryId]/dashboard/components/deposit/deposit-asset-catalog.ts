import { getNetworkDisplayName } from "@/components/token-display";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { NEAR_CHAIN_ICONS } from "@/constants/token";
import type { AggregatedAsset } from "@/hooks/use-assets";
import type { BridgeAsset, BridgeNetwork } from "@/hooks/use-bridge-tokens";
import Big from "@/lib/big";
import { pickDefaultDepositAsset } from "@/lib/pick-default-token";
import { canonicalizeTokenIdForMatch, normalizeNearAssetId } from "@/lib/utils";
import type { SelectOption } from "./deposit-types";

export type AssetSection = {
    title: string;
    options: SelectOption[];
    display?: "list" | "chips";
};

export interface NetworkBalanceDisplay {
    amount: string;
    amountUSD: number;
}

export interface DepositAssetCatalog {
    allAssets: SelectOption[];
    assetSections: AssetSection[];
    assetBalanceMap: Map<string, { balance: string; balanceUSD: number }>;
    assetNetworksMap: Map<string, SelectOption[]>;
    networkBalancesByAsset: Map<string, Map<string, NetworkBalanceDisplay>>;
}

export function toNetworkOption(network: BridgeNetwork): SelectOption {
    const iconUrl = network.chainIcons?.icon ?? null;
    return {
        id: network.id,
        name: network.name,
        symbol: network.symbol,
        icon: iconUrl || network.name.charAt(0),
        gradient: "bg-linear-to-br from-green-500 to-teal-500",
        chainId: network.chainId,
    };
}

/**
 * Match a network by intents id / chain id (exact), or by name when unique.
 * Ambiguous soft matches leave selection empty so the user picks.
 */
export function matchNetworkPrefill(
    networks: SelectOption[],
    prefillNetworkId: string,
): SelectOption | null {
    const normalized = prefillNetworkId.toLowerCase().trim();
    if (!normalized) return null;

    const byId = networks.find(
        (network) => network.id.toLowerCase() === normalized,
    );
    if (byId) return byId;

    const byChainId = networks.find(
        (network) => (network.chainId || "").toLowerCase() === normalized,
    );
    if (byChainId) return byChainId;

    const byExactName = networks.filter((network) => {
        const canonical = network.name.toLowerCase();
        const display = getNetworkDisplayName(network.name).toLowerCase();
        return canonical === normalized || display === normalized;
    });
    if (byExactName.length === 1) return byExactName[0];
    if (byExactName.length > 1) return null;

    const byIncludes = networks.filter((network) => {
        const canonical = network.name.toLowerCase();
        const display = getNetworkDisplayName(network.name).toLowerCase();
        return canonical.includes(normalized) || display.includes(normalized);
    });
    if (byIncludes.length === 1) return byIncludes[0];
    return null;
}

export function buildNetworkBalanceMap(
    assetId: string,
    bridgeNetworks: BridgeNetwork[],
    ownedTreasuryAssetsById: Map<string, AggregatedAsset>,
): Map<string, NetworkBalanceDisplay> {
    const balances = new Map<string, NetworkBalanceDisplay>();
    const ownedAsset = ownedTreasuryAssetsById.get(assetId.toLowerCase());

    if (!ownedAsset) return balances;

    for (const bridgeNetwork of bridgeNetworks) {
        const normalizedBridgeId = normalizeNearAssetId(bridgeNetwork.id);
        const byContractId = ownedAsset.networks.filter(
            (network) =>
                normalizeNearAssetId(network.contractId) === normalizedBridgeId,
        );

        const bridgeNetworkName = bridgeNetwork.name.toLowerCase();
        const includeAllNearResidencies =
            assetId.toLowerCase() === NEAR_NETWORK_ID &&
            bridgeNetworkName === NEAR_NETWORK_ID;

        const chainMatches = ownedAsset.networks.filter(
            (network) => network.network.toLowerCase() === bridgeNetworkName,
        );

        const fallbackChainMatches = ownedAsset.networks.filter(
            (network) =>
                !network.contractId &&
                network.network.toLowerCase() === bridgeNetworkName,
        );

        const matches = includeAllNearResidencies
            ? chainMatches
            : byContractId.length > 0
              ? byContractId
              : fallbackChainMatches;

        if (matches.length === 0) continue;

        const amount = matches
            .reduce((sum, network) => {
                return sum.add(
                    Big(network.availableBalanceRaw).div(
                        Big(10).pow(network.decimals),
                    ),
                );
            }, Big(0))
            .toString();
        const amountUSD = matches.reduce(
            (sum, network) => sum + network.availableBalanceUSD,
            0,
        );

        if (Big(amount).gt(0)) {
            balances.set(bridgeNetwork.id, {
                amount,
                amountUSD,
            });
        }
    }

    return balances;
}

function buildOtherAsset(otherAssetName: string): SelectOption {
    return {
        id: "other",
        name: otherAssetName,
        icon: "O",
        gradient: "bg-brand-blue",
        networks: [
            {
                id: "other:near",
                name: "Near",
                symbol: "Other",
                chainIcons: NEAR_CHAIN_ICONS,
                chainId: "near:mainnet",
                decimals: 24,
            },
        ],
    };
}

export function buildDepositAssetCatalog(params: {
    bridgeAssets: BridgeAsset[];
    aggregatedTreasuryTokens: AggregatedAsset[];
    popularAssets: { tokenId?: string | null }[];
    isConfidential: boolean;
    otherAssetName: string;
    labels: {
        popularAssets: string;
        yourAssets: string;
        otherAssets: string;
    };
}): DepositAssetCatalog {
    const {
        bridgeAssets,
        aggregatedTreasuryTokens,
        popularAssets,
        isConfidential,
        otherAssetName,
        labels,
    } = params;

    const otherAsset = buildOtherAsset(otherAssetName);
    const newAssetNetworksMap = new Map<string, SelectOption[]>();
    const networkBalancesByAssetId = new Map<
        string,
        Map<string, NetworkBalanceDisplay>
    >();
    const ownedTreasuryAssetsById = new Map(
        aggregatedTreasuryTokens.map((asset) => [
            asset.id.toLowerCase(),
            asset,
        ]),
    );
    const assetBalancesById = new Map<
        string,
        { balance: string; balanceUSD: number }
    >();

    const yourAssets: SelectOption[] = [];
    const otherAssets: SelectOption[] = [];

    for (const asset of bridgeAssets) {
        const networks = asset.networks.map(toNetworkOption);
        newAssetNetworksMap.set(asset.id, networks);
        networkBalancesByAssetId.set(
            asset.id,
            buildNetworkBalanceMap(
                asset.id,
                asset.networks,
                ownedTreasuryAssetsById,
            ),
        );

        const normalizedId = asset.id.toLowerCase();
        const ownedAsset = ownedTreasuryAssetsById.get(normalizedId);
        const selectOption: SelectOption = {
            id: asset.id,
            name: asset.name,
            symbol: asset.networks[0]?.symbol,
            icon: asset.icon,
            gradient: "bg-brand-blue",
            networks: asset.networks,
        };

        if (ownedAsset) {
            yourAssets.push(selectOption);
            assetBalancesById.set(asset.id, {
                balance: ownedAsset.availableTotalBalance.toString(),
                balanceUSD: ownedAsset.availableTotalBalanceUSD,
            });
            continue;
        }

        otherAssets.push(selectOption);
    }

    yourAssets.sort((a, b) => {
        const aUSD = assetBalancesById.get(a.id)?.balanceUSD || 0;
        const bUSD = assetBalancesById.get(b.id)?.balanceUSD || 0;
        return bUSD - aUSD;
    });
    otherAssets.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    const formattedAssets: SelectOption[] = [...yourAssets, ...otherAssets];

    // Add "Other" at the end (not for confidential — it only supports NEAR network)
    if (!isConfidential) {
        formattedAssets.push(otherAsset);
        const otherNetworks = (otherAsset.networks ?? []) as BridgeNetwork[];
        newAssetNetworksMap.set("other", otherNetworks.map(toNetworkOption));
    }

    const assetsByNormalizedId = new Map<string, SelectOption>();
    for (const asset of formattedAssets) {
        assetsByNormalizedId.set(canonicalizeTokenIdForMatch(asset.id), asset);
        assetsByNormalizedId.set(asset.id.toLowerCase(), asset);

        const networks = newAssetNetworksMap.get(asset.id) || [];
        for (const network of networks) {
            assetsByNormalizedId.set(
                canonicalizeTokenIdForMatch(network.id),
                asset,
            );
            assetsByNormalizedId.set(network.id.toLowerCase(), asset);
            if (network.chainId) {
                assetsByNormalizedId.set(
                    canonicalizeTokenIdForMatch(network.chainId),
                    asset,
                );
                assetsByNormalizedId.set(network.chainId.toLowerCase(), asset);
            }
        }
    }

    const popularOptions: SelectOption[] = [];
    const seenPopularIds = new Set<string>();
    for (const popularAsset of popularAssets) {
        if (!popularAsset.tokenId) continue;
        const normalizedPopularId = canonicalizeTokenIdForMatch(
            popularAsset.tokenId,
        );
        const matched =
            assetsByNormalizedId.get(normalizedPopularId) ||
            assetsByNormalizedId.get(popularAsset.tokenId.toLowerCase());
        if (matched && !seenPopularIds.has(matched.id)) {
            seenPopularIds.add(matched.id);
            popularOptions.push(matched);
        }
    }

    const sections: AssetSection[] = [];
    if (popularOptions.length > 0) {
        sections.push({
            title: labels.popularAssets,
            options: popularOptions,
            display: "chips",
        });
    }
    sections.push({
        title: labels.yourAssets,
        options: yourAssets,
    });
    sections.push({
        title: labels.otherAssets,
        options: isConfidential ? otherAssets : [...otherAssets, otherAsset],
    });

    return {
        allAssets: formattedAssets,
        assetSections: sections,
        assetBalanceMap: assetBalancesById,
        assetNetworksMap: newAssetNetworksMap,
        networkBalancesByAsset: networkBalancesByAssetId,
    };
}

export function resolvePrefillSelection(params: {
    catalog: DepositAssetCatalog;
    prefillTokenId?: string;
    prefillNetworkId?: string;
    isAssetsPending: boolean;
}): {
    targetAsset: SelectOption | undefined;
    networkToSelect: SelectOption | null;
    filteredNetworks: SelectOption[];
    selectedNetworkBalances: Map<string, NetworkBalanceDisplay>;
} {
    const { catalog, prefillTokenId, prefillNetworkId, isAssetsPending } =
        params;
    const {
        allAssets: formattedAssets,
        assetNetworksMap,
        networkBalancesByAsset,
        assetBalanceMap,
    } = catalog;

    const yourAssets = formattedAssets.filter((asset) =>
        assetBalanceMap.has(asset.id),
    );

    // Auto-select asset only (network stays empty unless URL prefill):
    // 1) explicit prefill token/network
    // 2) highest-USD owned asset (yourAssets is USD-sorted)
    // 3) USDC, else first available
    let targetAsset: SelectOption | undefined;
    let networkFromTokenPrefill: SelectOption | null = null;

    if (prefillTokenId) {
        const targetId = normalizeNearAssetId(prefillTokenId).toLowerCase();
        targetAsset = formattedAssets.find(
            (asset) =>
                normalizeNearAssetId(asset.id).toLowerCase() === targetId,
        );

        // Non-NEAR proposals often pass network-level token IDs (contract IDs).
        if (!targetAsset) {
            for (const asset of formattedAssets) {
                const assetNetworks = assetNetworksMap.get(asset.id) || [];
                const matchedNetwork = assetNetworks.find((network) => {
                    const networkId = normalizeNearAssetId(
                        network.id,
                    ).toLowerCase();
                    const chainId = normalizeNearAssetId(
                        network.chainId,
                    ).toLowerCase();
                    return networkId === targetId || chainId === targetId;
                });

                if (matchedNetwork) {
                    targetAsset = asset;
                    networkFromTokenPrefill = matchedNetwork;
                    break;
                }
            }
        }
    }

    // If token is not provided (or didn't resolve), derive asset from network prefill.
    if (!targetAsset && prefillNetworkId) {
        for (const asset of formattedAssets) {
            const assetNetworks = assetNetworksMap.get(asset.id) || [];
            const matchedNetwork = matchNetworkPrefill(
                assetNetworks,
                prefillNetworkId,
            );
            if (matchedNetwork) {
                targetAsset = asset;
                networkFromTokenPrefill = matchedNetwork;
                break;
            }
        }
    }

    // Wait for treasury assets so we don't flash USDC then swap to the
    // highest-USD owned holding when the cache/fetch lands.
    if (!targetAsset && !isAssetsPending) {
        targetAsset = pickDefaultDepositAsset(yourAssets, formattedAssets);
    }

    if (!targetAsset) {
        return {
            targetAsset: undefined,
            networkToSelect: null,
            filteredNetworks: [],
            selectedNetworkBalances: new Map(),
        };
    }

    const availableNetworks = assetNetworksMap.get(targetAsset.id) || [];
    // Keep canonical bridge network names (e.g. `eth`) for warning matching;
    // UI layers call getNetworkDisplayName when rendering.
    const filteredNetworks = [...availableNetworks];
    const selectedNetworkBalances =
        networkBalancesByAsset.get(targetAsset.id) || new Map();

    // Network is never inferred from balances / USDC / single-option.
    // Prefer exact token→network (contract id); soft URL network prefill only
    // when it uniquely identifies a network — otherwise leave empty.
    let networkToSelect: SelectOption | null = networkFromTokenPrefill;
    if (prefillNetworkId) {
        networkToSelect =
            matchNetworkPrefill(availableNetworks, prefillNetworkId) ??
            networkFromTokenPrefill;
    }

    return {
        targetAsset,
        networkToSelect,
        filteredNetworks,
        selectedNetworkBalances,
    };
}
