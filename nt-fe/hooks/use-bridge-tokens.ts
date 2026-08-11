import { useQuery } from "@tanstack/react-query";
import type { ChainIcons } from "@/lib/api";
import { fetchBridgeTokens } from "@/lib/bridge-api";

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
                    const hasValidIcon =
                        asset.icon &&
                        (asset.icon.startsWith("http") ||
                            asset.icon.startsWith("data:") ||
                            asset.icon.startsWith("/"));

                    return {
                        id: asset.id,
                        name: asset.name || asset.assetName,
                        icon: hasValidIcon
                            ? asset.icon
                            : (asset.name || asset.assetName)
                                  ?.charAt(0)
                                  ?.toUpperCase() || "",
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
