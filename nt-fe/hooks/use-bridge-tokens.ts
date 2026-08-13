import { useQuery } from "@tanstack/react-query";
import type { ChainIcons } from "@/lib/api";
import { fetchBridgeTokens } from "@/lib/bridge-api";
import { isIconUrl } from "@/lib/icon-url";

export interface BridgeNetwork {
    id: string;
    name: string;
    symbol: string;
    chainIcons: ChainIcons | null;
    chainId: string;
    decimals: number;
    minDepositAmount?: string;
    minWithdrawalAmount?: string;
    /** Intents ledger / catalog id */
    balanceAssetId?: string;
    /** 1Click quote routing id (may be 1cs_v1:) */
    quoteAssetId?: string;
    /** False when Bridge/POA cannot mint a stable public deposit address for this chain. */
    publicDepositSupported?: boolean;
}

export interface BridgeAsset {
    id: string;
    /** Catalog ticker (near.com `symbol` / API `assetName`), e.g. ETH */
    symbol: string;
    /** Catalog full name (near.com `name`), e.g. Ethereum */
    name: string;
    icon: string;
    networks: BridgeNetwork[];
}

/**
 * Hook to fetch bridge tokens with React Query
 */
export function useBridgeTokens(enabled: boolean = true) {
    return useQuery({
        queryKey: ["bridgeTokens"],
        queryFn: async () => {
            const fetchedAssets = await fetchBridgeTokens();

            const formattedAssets: BridgeAsset[] = fetchedAssets.map(
                (asset: any) => {
                    // near.com tokenlist: `symbol` = ticker, `name` = full name.
                    const symbol = asset.assetName || asset.name || asset.id;
                    const name = asset.name || asset.assetName || symbol;

                    return {
                        id: asset.id,
                        symbol,
                        name,
                        icon: isIconUrl(asset.icon)
                            ? asset.icon
                            : symbol?.charAt(0)?.toUpperCase() || "",
                        networks: asset.networks.map((network: any) => ({
                            id: network.id,
                            name: network.name,
                            symbol:
                                network.symbol === "wNEAR"
                                    ? "NEAR"
                                    : network.symbol,
                            chainIcons: network.chainIcons || null,
                            chainId: network.chainId,
                            decimals: network.decimals,
                            minDepositAmount: network.minDepositAmount,
                            minWithdrawalAmount: network.minWithdrawalAmount,
                            balanceAssetId:
                                network.balanceAssetId || network.id,
                            quoteAssetId:
                                network.quoteAssetId ||
                                network.balanceAssetId ||
                                network.id,
                            publicDepositSupported:
                                network.publicDepositSupported !== false,
                        })),
                    };
                },
            );

            return formattedAssets;
        },
        enabled,
        staleTime: 1000 * 60 * 10, // 10 minutes
        gcTime: 1000 * 60 * 30, // 30 minutes (formerly cacheTime)
    });
}
