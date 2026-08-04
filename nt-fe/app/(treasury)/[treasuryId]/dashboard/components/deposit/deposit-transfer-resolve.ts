import { getNetworkDisplayName } from "@/components/token-display";
import type { BridgeAsset } from "@/hooks/use-bridge-tokens";
import type { Treasury } from "@/lib/api";
import type { ChainIcons } from "@/lib/api";

export type SendTokenMeta = {
    symbol: string;
    networkName: string;
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
        symbol,
        networkName: getNetworkDisplayName(networkMatch.name),
        icon: asset.icon || symbol?.charAt(0)?.toUpperCase() || "?",
        chainIcons: networkMatch.chainIcons ?? undefined,
        minDepositAmount: networkMatch.minDepositAmount,
        decimals: networkMatch.decimals ?? 0,
    };
}

export type PayWithTrezuNextStep =
    | { kind: "create" }
    | { kind: "pay"; payerTreasuryId: string }
    | { kind: "choose" };

/**
 * Pick the next Pay-with-Trezu step from member treasuries.
 * Excludes the destination treasury so users don't pay into themselves.
 * 0 remaining → create, 1 → pay directly, 2+ → choose in modal.
 */
export function resolvePayWithTrezuNextStep(
    treasuries: Treasury[],
    destinationTreasuryId?: string,
): PayWithTrezuNextStep {
    const members = treasuries.filter(
        (treasury) =>
            treasury.isMember &&
            (!destinationTreasuryId ||
                treasury.daoId !== destinationTreasuryId),
    );
    if (members.length === 0) return { kind: "create" };
    if (members.length === 1) {
        return { kind: "pay", payerTreasuryId: members[0].daoId };
    }
    return { kind: "choose" };
}
