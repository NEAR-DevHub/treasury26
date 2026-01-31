import { useQuery } from "@tanstack/react-query";
import { getTreasuryAssets } from "@/lib/api";
import { useMemo } from "react";
import { TreasuryAsset } from "@/lib/api";
import { formatBalance } from "@/lib/utils";
import Big from "big.js";
import { totalBalance } from "@/lib/balance";

/**
 * Query hook to get whitelisted tokens with balances and prices
 * Fetches from backend which aggregates data from Ref Finance and FastNear
 */
export function useAssets(
    treasuryId: string | null | undefined,
    options?: {
        onlyPositiveBalance?: boolean;
    },
) {
    return useQuery({
        queryKey: ["treasuryAssets", treasuryId, options?.onlyPositiveBalance],
        queryFn: () => getTreasuryAssets(treasuryId!),
        enabled: !!treasuryId,
        staleTime: 1000 * 60 * 5, // 5 minutes
        select: (data) => {
            if (options?.onlyPositiveBalance) {
                const filteredTokens = data.tokens.filter(
                    (asset) => Number(asset.balance) > 0,
                );
                return {
                    ...data,
                    tokens: filteredTokens,
                };
            }
            return data;
        },
    });
}

export interface AggregatedAsset {
    symbol: string;
    name: string;
    icon: string;
    totalBalanceUSD: number;
    totalBalance: Big;
    price: number;
    weight: number;
    networks: TreasuryAsset[];
    isAggregated: boolean;
}

/**
 * Hook to aggregate tokens by symbol across different networks/residencies
 * @param tokens - Array of treasury assets to aggregate
 * @returns Aggregated assets with calculated weights
 */
export function useAggregatedTokens(tokens: TreasuryAsset[]): AggregatedAsset[] {
    return useMemo(() => {
        // Group tokens by symbol
        const grouped = tokens.reduce((acc, token) => {
            const symbol = token.symbol === "wNEAR" ? "NEAR" : token.symbol;
            if (!acc[symbol]) {
                acc[symbol] = {
                    symbol: symbol,
                    name: token.name,
                    icon: token.icon,
                    totalBalanceUSD: 0,
                    totalBalance: Big(0),
                    price: token.price,
                    weight: 0,
                    networks: [],
                    isAggregated: false,
                };
            }

            // Aggregate USD balance
            acc[symbol].totalBalanceUSD += token.balanceUSD;

            // Normalize and aggregate token balance (accounting for different decimals)
            acc[symbol].totalBalance = acc[symbol].totalBalance.add(
                Big(formatBalance(totalBalance(token.balance), token.decimals))
            );

            // Track all network instances
            acc[symbol].networks.push(token);

            return acc;
        }, {} as Record<string, AggregatedAsset>);

        // Calculate weights and mark aggregated tokens
        const totalUSD = Object.values(grouped).reduce(
            (sum, asset) => sum + asset.totalBalanceUSD,
            0
        );

        return Object.values(grouped).map(asset => ({
            ...asset,
            weight: totalUSD > 0 ? (asset.totalBalanceUSD / totalUSD) * 100 : 0,
            isAggregated: asset.networks.length > 1,
        }));
    }, [tokens]);
}
