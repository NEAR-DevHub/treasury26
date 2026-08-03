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

    const networkMatch =
        asset?.networks.find(
            (network) =>
                network.id === networkId ||
                network.name === networkId ||
                getNetworkDisplayName(network.name) === networkId,
        ) ?? asset?.networks[0];

    const symbol = networkMatch?.symbol || asset?.name || tokenId;
    const networkName = networkMatch
        ? getNetworkDisplayName(networkMatch.name)
        : networkId;

    return {
        symbol,
        networkName,
        icon: asset?.icon || symbol?.charAt(0)?.toUpperCase() || "?",
        chainIcons: networkMatch?.chainIcons ?? undefined,
        minDepositAmount: networkMatch?.minDepositAmount,
        decimals: networkMatch?.decimals ?? 0,
    };
}

/**
 * Prefer a confidential member treasury that is not the destination,
 * then any confidential member, then last/first member treasury.
 */
export function resolvePayerTreasuryId(
    treasuries: Treasury[],
    destinationTreasuryId: string | undefined,
    lastTreasuryId: string | null | undefined,
): string | null {
    const members = treasuries.filter((treasury) => treasury.isMember);

    const confidentialOther = members.find(
        (treasury) =>
            treasury.isConfidential && treasury.daoId !== destinationTreasuryId,
    );
    if (confidentialOther) return confidentialOther.daoId;

    const confidentialAny = members.find((treasury) => treasury.isConfidential);
    if (confidentialAny) return confidentialAny.daoId;

    if (
        lastTreasuryId &&
        members.some((treasury) => treasury.daoId === lastTreasuryId)
    ) {
        return lastTreasuryId;
    }

    return members[0]?.daoId ?? null;
}
