import { useQuery } from "@tanstack/react-query";
import { getTreasuryAssets } from "@/lib/api";
import { useMemo } from "react";
import { TreasuryAsset } from "@/lib/api";
import { formatBalance } from "@/lib/utils";
import Big from "big.js";
import { availableBalance, totalBalance } from "@/lib/balance";

const isTokenValidByOptions = (
    token: TreasuryAsset,
    options?: {
        onlyPositiveBalance?: boolean;
        onlySupportedTokens?: boolean;
    },
) => {
    if (options?.onlyPositiveBalance && availableBalance(token.balance).eq(0)) {
        return true;
    }
    if (
        options?.onlySupportedTokens &&
        (token.residency === "Lockup" || token.residency === "Staked")
    ) {
        return false;
    }
    return true;
};

/**
 * Query hook to get whitelisted tokens with balances and prices
 * Fetches from backend which aggregates data from Ref Finance and FastNear
 */
export function useAssets(
    treasuryId: string | null | undefined,
    options?: {
        onlyPositiveBalance?: boolean;
        onlySupportedTokens?: boolean;
    },
) {
    return useQuery({
        queryKey: ["treasuryAssets", treasuryId, options?.onlyPositiveBalance],
        queryFn: () => getTreasuryAssets(treasuryId!),
        enabled: !!treasuryId,
        staleTime: 1000 * 60 * 5, // 5 minutes
        select: (data) => {
            return {
                ...data,
                tokens: data.tokens.filter((token) =>
                    isTokenValidByOptions(token, options),
                ),
            };
        },
    });
}

export interface NetworkAsset extends TreasuryAsset {
    /** Available balance as raw string (not formatted) */
    availableBalanceRaw: string;
    /** Available balance in USD */
    availableBalanceUSD: number;
}

export interface AggregatedAsset {
    symbol: string;
    name: string;
    icon: string;
    totalBalanceUSD: number;
    totalBalance: Big;
    availableTotalBalanceUSD: number;
    availableTotalBalance: Big;
    price: number;
    weight: number;
    networks: NetworkAsset[];
    isAggregated: boolean;
}

/**
 * Hook to aggregate tokens by symbol across different networks/residencies
 * @param tokens - Array of treasury assets to aggregate
 * @returns Aggregated assets with calculated weights
 */
export function useAggregatedTokens(
    tokens: TreasuryAsset[],
): AggregatedAsset[] {
    return useMemo(() => {
        // Group tokens by symbol
        const grouped = tokens.reduce(
            (acc, token) => {
                const symbol = token.symbol === "wNEAR" ? "NEAR" : token.symbol;
                if (!acc[symbol]) {
                    acc[symbol] = {
                        symbol: symbol,
                        name: token.name,
                        icon: token.icon,
                        totalBalanceUSD: 0,
                        totalBalance: Big(0),
                        availableTotalBalanceUSD: 0,
                        availableTotalBalance: Big(0),
                        price: token.price,
                        weight: 0,
                        networks: [],
                        isAggregated: false,
                    };
                }

                // Normalize token balances (accounting for different decimals)
                const tokenTotalBalance = Big(
                    formatBalance(totalBalance(token.balance), token.decimals),
                );
                const tokenAvailableBalance = Big(
                    formatBalance(
                        availableBalance(token.balance),
                        token.decimals,
                    ),
                );

                // Aggregate total balance
                acc[symbol].totalBalance =
                    acc[symbol].totalBalance.add(tokenTotalBalance);
                acc[symbol].totalBalanceUSD += tokenTotalBalance
                    .mul(token.price)
                    .toNumber();

                // Aggregate available balance
                acc[symbol].availableTotalBalance = acc[
                    symbol
                ].availableTotalBalance.add(tokenAvailableBalance);
                acc[symbol].availableTotalBalanceUSD += tokenAvailableBalance
                    .mul(token.price)
                    .toNumber();

                // Track all network instances with computed available balance
                const availBal = availableBalance(token.balance);
                acc[symbol].networks.push({
                    ...token,
                    availableBalanceRaw: availBal.toString(),
                    availableBalanceUSD: tokenAvailableBalance
                        .mul(token.price)
                        .toNumber(),
                });

                return acc;
            },
            {} as Record<string, AggregatedAsset>,
        );

        // Calculate weights and mark aggregated tokens
        const totalUSD = Object.values(grouped).reduce(
            (sum, asset) => sum + asset.totalBalanceUSD,
            0,
        );

        return Object.values(grouped).map((asset) => ({
            ...asset,
            weight: totalUSD > 0 ? (asset.totalBalanceUSD / totalUSD) * 100 : 0,
            isAggregated: asset.networks.length > 1,
        }));
    }, [tokens]);
}
