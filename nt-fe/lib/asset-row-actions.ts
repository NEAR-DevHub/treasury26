import { buildPaymentsDeepLinkForAsset } from "@/app/(treasury)/[treasuryId]/dashboard/components/deposit/deposit-transfer-url";
import { buildTokenQueryParam } from "@/lib/token-query-param";

export interface AssetRowActionNetwork {
    id: string;
    contractId?: string;
    network: string;
    residency: string;
    symbol: string;
    decimals: number;
    icon: string;
    name: string;
    availableBalanceUSD: number;
    chainIcons?: unknown;
}

export interface AssetRowActionSource {
    id: string;
    networks: AssetRowActionNetwork[];
}

export function pickAssetActionNetwork(
    asset: AssetRowActionSource,
): AssetRowActionNetwork | null {
    const sendable = asset.networks.filter(
        (network) =>
            network.residency !== "Lockup" && network.residency !== "Staked",
    );
    if (sendable.length === 0) return null;

    return sendable.reduce((best, network) =>
        network.availableBalanceUSD > best.availableBalanceUSD ? network : best,
    );
}

export function buildAssetRowActionHrefs(
    treasuryId: string,
    asset: AssetRowActionSource,
): { sendHref: string; swapHref: string } | null {
    const network = pickAssetActionNetwork(asset);
    if (!network) return null;

    return {
        sendHref: buildPaymentsDeepLinkForAsset(treasuryId, {
            assetId: asset.id,
            networkId: network.contractId ?? network.id,
            networkName: network.network,
            residency: network.residency,
        }),
        swapHref: `/${treasuryId}/exchange?sellToken=${buildTokenQueryParam(network)}`,
    };
}
