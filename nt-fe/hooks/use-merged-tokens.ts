import { useMemo } from "react";
import {
    useAggregatedTokens,
    useAssets,
    type AggregatedAsset,
} from "@/hooks/use-assets";
import {
    useBridgeTokens,
    type BridgeAsset,
    type BridgeNetwork,
} from "@/hooks/use-bridge-tokens";
import { useTreasury } from "@/hooks/use-treasury";
import { NEAR_CHAIN_ICONS } from "@/constants/token";
import type { ChainIcons } from "@/lib/api";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { normalizeNearAssetId } from "@/lib/utils";

export interface MergedNetwork {
    id: string;
    name: string;
    symbol: string;
    chainIcons: ChainIcons | null;
    chainId: string;
    decimals: number;
    /** "Intents" for bridge networks; "Near" | "Ft" | "Lockup" | "Staked" for treasury networks */
    residency?: string;
    balance?: string;
    balanceUSD?: number;
    price?: number;
    lockedBalance?: string;
    minWithdrawalAmount?: string;
    minDepositAmount?: string;
}

export interface MergedToken {
    id: string;
    name: string;
    symbol: string;
    icon: string;
    networks: MergedNetwork[];
    /** Defined for treasury-held tokens; undefined for bridge-only tokens */
    totalBalance?: number;
    totalBalanceUSD?: number;
}

interface UseMergedTokensOptions {
    /** Set false to disable fetching entirely. Default: true */
    enabled?: boolean;
    /** When true, skips bridge-only tokens and bridge fetch. Default: false */
    showOnlyOwned?: boolean;
}

type TreasuryNetwork = AggregatedAsset["networks"][number];

// Unique key for tracking matched treasury networks during merge.
const networkKey = (n: TreasuryNetwork): string =>
    n.contractId ?? `${n.id}:${n.residency}`;

// Convert treasury network shape to a unified network model.
const mapTreasuryNetwork = (n: TreasuryNetwork): MergedNetwork => ({
    id: n.contractId ?? n.id,
    name: n.network,
    symbol: n.symbol,
    chainIcons:
        n.chainIcons ||
        (n.id === NEAR_NETWORK_ID && n.residency === "Near"
            ? NEAR_CHAIN_ICONS
            : null),
    chainId: n.network,
    decimals: n.decimals,
    residency: n.residency,
    lockedBalance:
        n.balance.type === "Standard" ? n.balance.locked.toFixed(0) : undefined,
    balance: n.availableBalanceRaw,
    balanceUSD: n.availableBalanceUSD,
    price: n.price,
});

// Overlay bridge metadata with treasury balances/residency, but keep treasury
// identity fields so selection can use this object directly.
const mapBridgeMatchedNetwork = (
    bridgeNetwork: BridgeNetwork,
    treasuryNetwork: TreasuryNetwork,
): MergedNetwork => ({
    id: treasuryNetwork.contractId ?? treasuryNetwork.id,
    name: treasuryNetwork.network,
    symbol: treasuryNetwork.symbol,
    chainIcons:
        treasuryNetwork.chainIcons ||
        (treasuryNetwork.id === NEAR_NETWORK_ID &&
        treasuryNetwork.residency === "Near"
            ? NEAR_CHAIN_ICONS
            : bridgeNetwork.chainIcons),
    chainId: bridgeNetwork.chainId,
    decimals: bridgeNetwork.decimals,
    residency: treasuryNetwork.residency,
    minWithdrawalAmount: bridgeNetwork.minWithdrawalAmount,
    minDepositAmount: bridgeNetwork.minDepositAmount,
    lockedBalance:
        treasuryNetwork.balance.type === "Standard"
            ? treasuryNetwork.balance.locked.toFixed(0)
            : undefined,
    balance: treasuryNetwork.availableBalanceRaw,
    balanceUSD: treasuryNetwork.availableBalanceUSD,
    price: treasuryNetwork.price,
});

// Expand bridge entries to selectable variants (Intents + optional Ft).
const toBridgeVariants = (
    bridgeNetwork: BridgeNetwork,
    residency: "Intents" | "Ft" = "Intents",
    options?: {
        includeFtDuplicate?: boolean;
    },
): MergedNetwork[] => {
    const minWithdrawalAmount =
        residency === "Intents" ? bridgeNetwork.minWithdrawalAmount : undefined;
    const minDepositAmount =
        residency === "Intents" ? bridgeNetwork.minDepositAmount : undefined;

    const variants: MergedNetwork[] = [
        {
            id: bridgeNetwork.id,
            name: bridgeNetwork.name,
            symbol: bridgeNetwork.symbol,
            chainIcons: bridgeNetwork.chainIcons,
            chainId: bridgeNetwork.chainId,
            decimals: bridgeNetwork.decimals,
            residency,
            minWithdrawalAmount,
            minDepositAmount,
        },
    ];

    // Bridge near-mainnet token should also be selectable as FT form.
    const shouldAddFtDuplicate = options?.includeFtDuplicate ?? true;
    if (
        shouldAddFtDuplicate &&
        bridgeNetwork.chainId === "near:mainnet" &&
        bridgeNetwork.id.startsWith("nep141:")
    ) {
        variants.push({
            id: normalizeNearAssetId(bridgeNetwork.id),
            name: bridgeNetwork.name,
            symbol: bridgeNetwork.symbol,
            chainIcons: bridgeNetwork.chainIcons,
            chainId: bridgeNetwork.chainId,
            decimals: bridgeNetwork.decimals,
            residency: "Ft",
            minWithdrawalAmount: undefined,
            minDepositAmount: undefined,
        });
    }

    return variants;
};

// Merge one owned token with bridge networks if bridge data exists.
const mergeOwnedTokenWithBridge = (
    treasuryToken: AggregatedAsset,
    bridgeAsset: BridgeAsset | undefined,
    isConfidential: boolean,
): MergedToken => {
    if (!bridgeAsset) {
        return {
            id: treasuryToken.id.toLowerCase(),
            name: treasuryToken.name,
            symbol: treasuryToken.id.toUpperCase(),
            icon: treasuryToken.icon || "",
            networks: treasuryToken.networks.map(mapTreasuryNetwork),
            totalBalance: Number(treasuryToken.availableTotalBalance),
            totalBalanceUSD: treasuryToken.availableTotalBalanceUSD,
        };
    }

    // contractId match (exact): nep141:xxx.omft.near -> bridge network id
    const byContractId = new Map(
        treasuryToken.networks
            .filter((n) => n.contractId)
            .map((n) => [n.contractId!, n]),
    );

    // Chain-name fallback: only for treasury networks WITHOUT a contractId
    // (e.g. native NEAR, lockup). Networks with a contractId must match via
    // contractId and won't be double-matched through chain name.
    const byChain = new Map<string, typeof treasuryToken.networks>();
    for (const n of treasuryToken.networks) {
        if (n.contractId) continue;
        const group = byChain.get(n.network) ?? [];
        group.push(n);
        byChain.set(n.network, group);
    }

    const matched = new Set<string>();
    const networks: MergedNetwork[] = [];
    const treasuryFtIds = new Set(
        treasuryToken.networks
            .filter((n) => n.residency === "Ft")
            .map((n) => n.contractId ?? n.id),
    );

    for (const bn of bridgeAsset.networks) {
        const bridgeFtId = normalizeNearAssetId(bn.id);
        const includeFtDuplicate =
            !isConfidential &&
            bn.id.startsWith("nep141:") &&
            !treasuryFtIds.has(bridgeFtId);

        const contractMatch = byContractId.get(bn.id);
        const chainMatches = contractMatch
            ? [contractMatch]
            : (byChain.get(bn.name) ?? []);

        if (chainMatches.length === 0) {
            // No treasury holding - bridge-only network, always Intents
            networks.push(
                ...toBridgeVariants(bn, "Intents", {
                    includeFtDuplicate,
                }),
            );
            continue;
        }

        for (const tn of chainMatches) {
            matched.add(networkKey(tn));
            networks.push(mapBridgeMatchedNetwork(bn, tn));
        }

        // Chain-name match means treasury has native/lockup entries (no contractId).
        // Also add the bridge network itself as an Intents option so it can be
        // used as a swap target.
        if (!contractMatch) {
            networks.push(
                ...toBridgeVariants(bn, "Intents", {
                    includeFtDuplicate,
                }),
            );
        }
    }

    // Unmatched treasury networks (not covered by any bridge network)
    for (const tn of treasuryToken.networks) {
        if (!matched.has(networkKey(tn))) {
            networks.push(mapTreasuryNetwork(tn));
        }
    }

    return {
        id: treasuryToken.id.toLowerCase(),
        name: bridgeAsset.name,
        symbol: bridgeAsset.id.toUpperCase(),
        icon: treasuryToken.icon || bridgeAsset.icon || "",
        networks,
        totalBalance: Number(treasuryToken.availableTotalBalance),
        totalBalanceUSD: treasuryToken.availableTotalBalanceUSD,
    };
};

// Build tokens that exist only in bridge data.
const buildBridgeOnlyTokens = (
    bridgeAssets: BridgeAsset[],
    aggregatedTokens: AggregatedAsset[],
    isConfidential: boolean,
): MergedToken[] => {
    const ownedIds = new Set(aggregatedTokens.map((t) => t.id.toLowerCase()));

    return bridgeAssets
        .filter((a) => !ownedIds.has(a.id.toLowerCase()))
        .map(
            (a): MergedToken => ({
                id: a.id,
                name: a.name,
                symbol: a.id.toUpperCase(),
                icon: a.icon,
                networks: a.networks.flatMap((n) =>
                    toBridgeVariants(n, "Intents", {
                        includeFtDuplicate: !isConfidential,
                    }),
                ),
            }),
        )
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
};

/**
 * Fetches treasury assets and bridge tokens, returning a single merged array.
 *
 * - Owned tokens come first, sorted by USD value descending.
 * - Bridge-only tokens (not held in treasury) follow, sorted alphabetically.
 * - All bridge networks carry residency: "Intents".
 * - When a token is in both treasury and bridge, networks are merged: treasury
 *   networks retain their original residency, while bridge-only networks on that
 *   token get residency: "Intents".
 */
export function useMergedTokens({
    enabled = true,
    showOnlyOwned = false,
}: UseMergedTokensOptions = {}) {
    const { treasuryId, isConfidential } = useTreasury();

    const { data: { tokens: rawTokens = [] } = {} } = useAssets(treasuryId, {
        onlyPositiveBalance: false,
        onlySupportedTokens: true,
    });

    const aggregatedTokens = useAggregatedTokens(rawTokens);

    const { data: bridgeAssets = [], isLoading } = useBridgeTokens(
        enabled && !showOnlyOwned,
    );

    const tokens = useMemo((): MergedToken[] => {
        const bridgeAssetsMap = new Map(
            bridgeAssets.map((a) => [a.id.toLowerCase(), a]),
        );

        const ownedTokens = aggregatedTokens
            .map((treasuryToken) =>
                mergeOwnedTokenWithBridge(
                    treasuryToken,
                    bridgeAssetsMap.get(treasuryToken.id.toLowerCase()),
                    isConfidential,
                ),
            )
            .sort(
                (a, b) => (b.totalBalanceUSD ?? 0) - (a.totalBalanceUSD ?? 0),
            );

        if (showOnlyOwned) {
            return ownedTokens;
        }

        return [
            ...ownedTokens,
            ...buildBridgeOnlyTokens(
                bridgeAssets,
                aggregatedTokens,
                isConfidential,
            ),
        ];
    }, [aggregatedTokens, bridgeAssets, showOnlyOwned]);

    return { tokens, aggregatedTokens, isLoading };
}
