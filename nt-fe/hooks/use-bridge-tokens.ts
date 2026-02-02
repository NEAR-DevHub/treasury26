import { useQuery } from "@tanstack/react-query";
import { fetchBridgeTokens } from "@/lib/bridge-api";
import { useThemeStore } from "@/stores/theme-store";

export interface BridgeNetwork {
    id: string;
    name: string;
    icon: string | null;
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
    const { theme } = useThemeStore();

    return useQuery({
        queryKey: ["bridgeTokens", theme],
        queryFn: async () => {
            const fetchedAssets = await fetchBridgeTokens(theme);
            
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
                        networks: asset.networks,
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

