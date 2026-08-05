import { getNetworkDisplayName } from "@/components/token-display";
import type { BridgeAsset } from "@/hooks/use-bridge-tokens";
import type { Treasury } from "@/lib/api";
import type { ChainIcons } from "@/lib/api";

export type SendTokenMeta = {
    /** Bridge asset id (e.g. "usdc") for payments `?token=`. */
    assetId: string;
    /** Intents network id for payments `?network=` exact destination match. */
    networkId: string;
    symbol: string;
    /** Display label (e.g. "Ethereum", "BNB Chain"). */
    networkName: string;
    /** Raw bridge network name (e.g. "eth", "bsc"). */
    bridgeNetworkName: string;
    icon: string;
    chainIcons?: ChainIcons;
    minDepositAmount?: string;
    decimals: number;
};

/** Resolve display metadata for a public transfer link from bridge tokens. */
export function resolveSendTokenMeta(
    bridgeAssets: BridgeAsset[],
    tokenId: string,
    networkId: string,
): SendTokenMeta | null {
    if (!tokenId && !networkId) return null;

    const asset =
        bridgeAssets.find((item) => item.id === tokenId) ??
        bridgeAssets.find((item) =>
            item.networks.some((network) => network.id === networkId),
        );
    if (!asset) return null;

    // Require an explicit network match — never fall back to networks[0].
    const networkMatch = asset.networks.find(
        (network) =>
            network.id === networkId ||
            network.name === networkId ||
            getNetworkDisplayName(network.name) === networkId,
    );
    if (!networkMatch) return null;

    const symbol = networkMatch.symbol || asset.name || tokenId;

    return {
        assetId: asset.id,
        networkId: networkMatch.id,
        symbol,
        networkName: getNetworkDisplayName(networkMatch.name),
        bridgeNetworkName: networkMatch.name,
        icon: asset.icon || symbol?.charAt(0)?.toUpperCase() || "?",
        chainIcons: networkMatch.chainIcons ?? undefined,
        minDepositAmount: networkMatch.minDepositAmount,
        decimals: networkMatch.decimals ?? 0,
    };
}

/** Bridge RPC chain id for an intents asset / network id from status. */
export function resolveBridgeChainId(
    bridgeAssets: BridgeAsset[],
    networkId: string,
): string | null {
    if (!networkId) return null;
    for (const asset of bridgeAssets) {
        const network = asset.networks.find((item) => item.id === networkId);
        if (network) return network.chainId || network.id;
    }
    return networkId;
}

export type PayWithTrezuNextStep =
    | { kind: "create" }
    | { kind: "pay"; payerTreasuryId: string }
    | { kind: "choose" };

export type PayWithTrezuTreasuryFilter = {
    destinationTreasuryId?: string;
    /** Confidential share: only confidential member treasuries can pay. */
    confidentialOnly?: boolean;
};

/**
 * Pick the next Pay-with-Trezu step from member treasuries.
 * Excludes the destination treasury so users don't pay into themselves.
 * 0 remaining → create, 1 → pay directly, 2+ → choose in modal.
 */
export function resolvePayWithTrezuNextStep(
    treasuries: Treasury[],
    options?: PayWithTrezuTreasuryFilter | string,
): PayWithTrezuNextStep {
    // Backward-compatible: older callers passed destination id as the 2nd arg.
    const filter: PayWithTrezuTreasuryFilter =
        typeof options === "string"
            ? { destinationTreasuryId: options }
            : (options ?? {});

    const members = treasuries.filter((treasury) => {
        if (!treasury.isMember) return false;
        if (
            filter.destinationTreasuryId &&
            treasury.daoId === filter.destinationTreasuryId
        ) {
            return false;
        }
        if (filter.confidentialOnly && !treasury.isConfidential) {
            return false;
        }
        return true;
    });
    if (members.length === 0) return { kind: "create" };
    if (members.length === 1) {
        return { kind: "pay", payerTreasuryId: members[0].daoId };
    }
    return { kind: "choose" };
}
