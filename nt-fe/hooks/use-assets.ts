import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { decimalFromBaseUnits } from "@/lib/amount-format";
import { getTreasuryAssets, type TreasuryAsset } from "@/lib/api";
import { availableBalance, totalBalance } from "@/lib/balance";
import Big from "@/lib/big";

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
        (token.residency === "Lockup" ||
            token.residency === "Staked" ||
            token.lockupInstanceId)
    ) {
        return false;
    }
    return true;
};

/**
 * Shared options for payments / deposit / token pickers so every observer
 * hits the same React Query cache entry (onlyPositiveBalance must not be
 * omitted — `undefined` vs `false` used to split the key and refetch).
 */
export const DEFAULT_ASSETS_QUERY = {
    onlyPositiveBalance: false,
    onlySupportedTokens: true,
} as const;

/**
 * Query hook to get whitelisted tokens with balances and prices
 * Fetches from backend which aggregates data from Ref Finance and FastNear
 */
export function useAssets(
    treasuryId: string | null | undefined,
    options?: {
        onlyPositiveBalance?: boolean;
        onlySupportedTokens?: boolean;
        enabled?: boolean;
    },
) {
    // Normalize so callers that omit onlyPositiveBalance share cache with
    // those that pass `false` explicitly.
    const onlyPositiveBalance = options?.onlyPositiveBalance ?? false;

    return useQuery({
        queryKey: ["treasuryAssets", treasuryId, onlyPositiveBalance],
        // getTreasuryAssets throws on failure (never resolves empty — do not
        // reintroduce a catch there): React Query keeps serving the last
        // successful data while it retries, so an outage or a post-txn fetch
        // hiccup never renders as a $0 treasury. Retry is pinned here so a
        // future defaultOptions.queries change can't silently remove it.
        queryFn: () => getTreasuryAssets(treasuryId!),
        enabled: !!treasuryId && (options?.enabled ?? true),
        staleTime: 1000 * 5, // 5 seconds (assets change frequently)
        retry: 3,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
        select: (data) => {
            return {
                ...data,
                tokens: data.tokens.filter((token) =>
                    isTokenValidByOptions(token, {
                        ...options,
                        onlyPositiveBalance,
                    }),
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
    id: string;
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
                if (!acc[token.id]) {
                    acc[token.id] = {
                        id: token.id.toUpperCase(),
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
                const tokenTotalBalance = decimalFromBaseUnits(
                    totalBalance(token.balance),
                    token.decimals,
                );
                const tokenAvailableBalance = decimalFromBaseUnits(
                    availableBalance(token.balance),
                    token.decimals,
                );

                // Aggregate total balance
                acc[token.id].totalBalance =
                    acc[token.id].totalBalance.add(tokenTotalBalance);
                acc[token.id].totalBalanceUSD += tokenTotalBalance
                    .mul(token.price)
                    .toNumber();

                // Aggregate available balance
                acc[token.id].availableTotalBalance = acc[
                    token.id
                ].availableTotalBalance.add(tokenAvailableBalance);
                acc[token.id].availableTotalBalanceUSD += tokenAvailableBalance
                    .mul(token.price)
                    .toNumber();

                // Track all network instances with computed available balance
                const availBal = availableBalance(token.balance);
                acc[token.id].networks.push({
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
