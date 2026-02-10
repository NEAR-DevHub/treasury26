import { useQuery } from "@tanstack/react-query";
import { fetchBridgeTokens } from "@/lib/bridge-api";
import { ChainIcons } from "@/lib/api";

export interface BridgeNetwork {
    id: string;
    name: string;
    chainIcons: ChainIcons | null;
    chainId: string;
    decimals: number;
}

export interface BridgeAsset {
    id: string;
    name: string;
    symbol: string;
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
                        symbol:
                            asset.symbol === "wNEAR" ? "NEAR" : asset.symbol,
                        icon: hasValidIcon
                            ? asset.icon
                            : asset.symbol?.charAt(0) || "?",
                        networks: asset.networks.map((network: any) => ({
                            id: network.id,
                            name: network.name,
                            chainIcons: network.chainIcons || null,
                            chainId: network.chainId,
                            decimals: network.decimals,
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
