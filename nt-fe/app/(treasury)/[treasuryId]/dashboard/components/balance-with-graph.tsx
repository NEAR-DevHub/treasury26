"use client";

import {
    ArrowDown,
    Check,
    ChevronDown,
    ClockIcon,
    Coins,
    Eye,
    EyeOff,
    Info,
    Navigation,
    Shield,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useRef, useState } from "react";
import { AnimatedCurrency } from "@/components/animated-currency";
import { AuthButton } from "@/components/auth-button";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { SwapIcon } from "@/components/icons/swap";
import { ScrollContainer } from "@/components/scroll-container";
import { Tooltip } from "@/components/tooltip";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsHistoryRefreshing } from "@/features/activity";
import { HistoryRefreshButton } from "@/features/activity/components/history-refresh-button";
import { useTreasury } from "@/hooks/use-treasury";
import { useBalanceChart } from "@/hooks/use-treasury-queries";
import type { ChartInterval, TreasuryAsset } from "@/lib/api";
import { availableBalance, totalBalance } from "@/lib/balance";
import { getBalanceHistoryTokenIds } from "@/lib/balance-history-token-ids";
import Big from "@/lib/big";
import {
    getDashboardBalanceView,
    getDashboardBreakdownItems,
    getDashboardBucketVisibility,
} from "@/lib/dashboard-balance-view";
import { cn, formatBalance, formatCurrencyWithSubCent } from "@/lib/utils";
import BalanceChart from "./chart";

interface Props {
    tokens: TreasuryAsset[];
    isHidden: boolean;
    onDepositClick: () => void;
    isLoading?: boolean;
}

type TimePeriod = "1W" | "1M" | "3M" | "1Y";

const TIME_PERIODS: TimePeriod[] = ["1W", "1M", "3M", "1Y"];

// Chart filter chrome, per design: fully rounded grey pills, and floating
// white menus with no border and a soft shadow.
const FILTER_PILL_CLASS = "h-10 rounded-full text-[15px] font-semibold";
const FILTER_MENU_CLASS =
    "rounded-2xl border-0 p-1.5 shadow-[0_16px_40px_-12px_rgb(0_0_0/0.25)]";
const FILTER_MENU_ITEM_CLASS =
    "gap-3 rounded-xl px-2.5 py-2 text-base font-medium text-gray-700 focus:bg-gray-100 dark:text-gray-200 dark:focus:bg-white/10";
const FILTER_MOBILE_TRIGGER_CLASS =
    "data-[size=sm]:h-10 rounded-full border-0 bg-gray-100 px-4 text-[15px] font-semibold text-gray-700 shadow-none focus:ring-0 dark:bg-white/10 dark:text-gray-200";
// Radix Select keeps its check indicator absolutely positioned on the right,
// so its rows need the reserved right padding back.
const FILTER_SELECT_ITEM_CLASS = `${FILTER_MENU_ITEM_CLASS} pr-8`;

// Map frontend time periods to backend intervals
const PERIOD_TO_INTERVAL: Record<TimePeriod, ChartInterval> = {
    "1W": "daily",
    "1M": "daily",
    "3M": "daily",
    "1Y": "weekly",
};

// Calculate hours back for each period
const PERIOD_TO_HOURS: Record<TimePeriod, number> = {
    "1W": 24 * 7,
    "1M": 24 * 30,
    "3M": 24 * 90,
    "1Y": 24 * 365,
};

// Format timestamp based on time period
const formatTimestampForPeriod = (
    timestamp: string,
    period: TimePeriod,
    locale: string,
): string => {
    const date = new Date(timestamp);

    switch (period) {
        case "1W":
        case "1M":
            // Show date: "6 Jan"
            return date.toLocaleDateString(locale, {
                day: "numeric",
                month: "short",
            });
        case "3M":
            // Monthly label: "Nov"
            return date.toLocaleDateString(locale, { month: "short" });
        case "1Y": {
            // Show month and year: "Mar '25"
            const month = date.toLocaleDateString(locale, { month: "short" });
            const year = date.toLocaleDateString(locale, { year: "2-digit" });
            return `${month} '${year}`;
        }
        default:
            return date.toLocaleDateString(locale);
    }
};

// Full date for tooltip label when axis label is abbreviated (3M/1Y)
const formatFullDateForPeriod = (
    timestamp: string,
    period: TimePeriod,
    locale: string,
): string | undefined => {
    if (period !== "3M" && period !== "1Y") return undefined;
    const date = new Date(timestamp);
    return date.toLocaleDateString(locale, {
        day: "numeric",
        month: "short",
        year: "2-digit",
    });
};

interface GroupedToken {
    symbol: string;
    tokens: TreasuryAsset[];
    totalBalanceUSD: number;
    totalBalance: Big;
    icon: string;
    tokenIds: string[];
}

export default function BalanceWithGraph({
    tokens,
    isHidden,
    onDepositClick,
    isLoading: isLoadingTokens,
}: Props) {
    const t = useTranslations("balanceWithGraph");
    const tCommon = useTranslations("common");
    const locale = useLocale();
    const isHistoryRefreshing = useIsHistoryRefreshing();
    const {
        treasuryId,
        isConfidential: isConfidentialTreasury,
        isGuestTreasury,
    } = useTreasury();
    const [selectedToken, setSelectedToken] = useState<string>("all");
    const [selectedPeriod, setSelectedPeriod] = useState<TimePeriod>("1W");
    const [isChartHovered, setIsChartHovered] = useState(false);
    const [isBalanceMasked, setIsBalanceMasked] = useState(false);
    const router = useRouter();
    const handleChartMouseEnter = useCallback(
        () => setIsChartHovered(true),
        [],
    );
    const handleChartMouseLeave = useCallback(
        () => setIsChartHovered(false),
        [],
    );
    const isConfidential = isConfidentialTreasury && isGuestTreasury;
    const showConfidentialShield = isConfidentialTreasury && !isGuestTreasury;
    // Group tokens by symbol (to handle same token on different networks)
    const groupedTokens = useMemo(() => {
        const grouped = new Map<string, GroupedToken>();

        for (const token of tokens) {
            const existing = grouped.get(token.symbol);
            const tokenIdsForHistory = getBalanceHistoryTokenIds(token);

            if (existing) {
                existing.tokens.push(token);
                existing.totalBalanceUSD += token.balanceUSD;
                existing.totalBalance = existing.totalBalance.add(
                    Big(
                        formatBalance(
                            totalBalance(token.balance),
                            token.decimals,
                        ),
                    ),
                );
                // Add all token IDs, deduplicating
                for (const tokenId of tokenIdsForHistory) {
                    if (!existing.tokenIds.includes(tokenId)) {
                        existing.tokenIds.push(tokenId);
                    }
                }
            } else {
                grouped.set(token.symbol, {
                    symbol: token.symbol,
                    tokens: [token],
                    totalBalanceUSD: token.balanceUSD,
                    totalBalance: Big(
                        formatBalance(
                            totalBalance(token.balance),
                            token.decimals,
                        ),
                    ),
                    icon: token.icon,
                    tokenIds: tokenIdsForHistory,
                });
            }
        }

        // Sort by total USD value descending
        return Array.from(grouped.values()).sort(
            (a, b) => b.totalBalanceUSD - a.totalBalanceUSD,
        );
    }, [tokens]);

    // Get the selected token group
    const selectedTokenGroup =
        selectedToken === "all"
            ? null
            : groupedTokens.find((group) => group.symbol === selectedToken);
    const headerScopedTokens = useMemo(() => {
        return selectedTokenGroup?.tokens ?? tokens;
    }, [selectedTokenGroup, tokens]);

    const balanceView = useMemo(() => {
        return getDashboardBalanceView(headerScopedTokens);
    }, [headerScopedTokens]);
    const balanceBreakdownItems = useMemo(() => {
        return getDashboardBreakdownItems(headerScopedTokens);
    }, [headerScopedTokens]);
    const bucketVisibility = useMemo(
        () => getDashboardBucketVisibility(headerScopedTokens),
        [headerScopedTokens],
    );
    const showBreakdown =
        bucketVisibility.showLocked || bucketVisibility.showEarning;

    // Calculate time range for chart API
    const chartParams = useMemo(() => {
        if (!treasuryId || isConfidential) return null;

        const endTime = new Date();
        const hoursBack = PERIOD_TO_HOURS[selectedPeriod];
        const startTime = new Date(
            endTime.getTime() - hoursBack * 60 * 60 * 1000,
        );

        // Validate dates
        if (
            Number.isNaN(startTime.getTime()) ||
            Number.isNaN(endTime.getTime())
        ) {
            return null;
        }

        const params = {
            accountId: treasuryId,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            interval: PERIOD_TO_INTERVAL[selectedPeriod],
            tokenIds: selectedTokenGroup?.tokenIds, // Undefined for "all tokens"
        };

        return params;
    }, [treasuryId, selectedPeriod, selectedTokenGroup, isConfidential]);

    // Freeze chartParams while hovering so that parent re-renders (from other
    // queries like useAssets) don't change the query key, which would flip
    // isLoading to true and unmount the chart — destroying the tooltip.
    const frozenChartParams = useRef(chartParams);
    if (!isChartHovered) {
        frozenChartParams.current = chartParams;
    }

    // Fetch balance chart data with USD values
    const {
        data: balanceChartData,
        isLoading,
        isFetching,
    } = useBalanceChart(frozenChartParams.current);

    // Transform chart data for display
    const chartData = useMemo(() => {
        if (!balanceChartData) {
            return { data: [], showUSD: true };
        }

        if (selectedToken === "all") {
            // Aggregate USD values across all tokens
            const timeMap = new Map<
                string,
                { usdValue: number; hasUSD: boolean }
            >();

            for (const [, snapshots] of Object.entries(balanceChartData)) {
                if (!Array.isArray(snapshots)) continue;
                for (const snapshot of snapshots) {
                    const existing = timeMap.get(snapshot.timestamp) || {
                        usdValue: 0,
                        hasUSD: false,
                    };
                    const hasUSD =
                        snapshot.valueUsd !== null &&
                        snapshot.valueUsd !== undefined;

                    timeMap.set(snapshot.timestamp, {
                        usdValue: existing.usdValue + (snapshot.valueUsd || 0),
                        hasUSD: existing.hasUSD || hasUSD,
                    });
                }
            }

            const data = Array.from(timeMap.entries())
                .sort(
                    (a, b) =>
                        new Date(a[0]).getTime() - new Date(b[0]).getTime(),
                )
                .map(([timestamp, { usdValue }]) => ({
                    name: formatTimestampForPeriod(
                        timestamp,
                        selectedPeriod,
                        locale,
                    ),
                    fullDate: formatFullDateForPeriod(
                        timestamp,
                        selectedPeriod,
                        locale,
                    ),
                    usdValue: usdValue,
                }));

            if (data.length > 0) {
                // Only include tokens whose history token IDs have price data
                const tokenIdsWithPrices = new Set(
                    Object.entries(balanceChartData)
                        .filter(
                            ([, snapshots]) =>
                                Array.isArray(snapshots) &&
                                snapshots.some((s) => s.priceUsd != null),
                        )
                        .map(([tokenId]) => tokenId),
                );
                const nowBalanceUSD = groupedTokens
                    .filter(
                        (group) =>
                            group.tokens.some(
                                (t) => t.residency !== "Lockup",
                            ) &&
                            group.tokenIds.some((id) =>
                                tokenIdsWithPrices.has(id),
                            ),
                    )
                    .flatMap((group) =>
                        group.tokens.filter((t) => t.residency !== "Lockup"),
                    )
                    .reduce((sum, t) => sum + t.balanceUSD, 0);
                data.push({
                    name: t("chartNow"),
                    fullDate: undefined,
                    usdValue: nowBalanceUSD,
                });
            }

            // Check if any snapshot has USD values
            const hasAnyUSD = Array.from(timeMap.values()).some(
                (v) => v.hasUSD,
            );

            return { data, showUSD: hasAnyUSD };
        } else {
            // Aggregate values for selected token across all networks
            const timeMap = new Map<
                string,
                { usdValue: number; balanceValue: number; hasUSD: boolean }
            >();

            for (const [tokenIdString, snapshots] of Object.entries(
                balanceChartData,
            )) {
                if (!Array.isArray(snapshots)) continue;
                const isPartOfSelectedTokenGroup =
                    selectedTokenGroup?.tokenIds.includes(tokenIdString);

                // Only include token IDs that belong to the selected token group
                if (isPartOfSelectedTokenGroup) {
                    for (const snapshot of snapshots) {
                        const existing = timeMap.get(snapshot.timestamp) || {
                            usdValue: 0,
                            balanceValue: 0,
                            hasUSD: false,
                        };
                        const hasUSD =
                            snapshot.valueUsd !== null &&
                            snapshot.valueUsd !== undefined;
                        const balanceValue = parseFloat(snapshot.balance) || 0;

                        timeMap.set(snapshot.timestamp, {
                            usdValue:
                                existing.usdValue + (snapshot.valueUsd || 0),
                            balanceValue: existing.balanceValue + balanceValue,
                            hasUSD: existing.hasUSD || hasUSD,
                        });
                    }
                }
            }
            const hasAnyUSD = Array.from(timeMap.values()).some(
                (v) => v.hasUSD,
            );
            const data = Array.from(timeMap.entries())
                .sort(
                    (a, b) =>
                        new Date(a[0]).getTime() - new Date(b[0]).getTime(),
                )
                .map(([timestamp, { usdValue, balanceValue, hasUSD }]) => ({
                    name: formatTimestampForPeriod(
                        timestamp,
                        selectedPeriod,
                        locale,
                    ),
                    fullDate: formatFullDateForPeriod(
                        timestamp,
                        selectedPeriod,
                        locale,
                    ),
                    usdValue: hasUSD ? usdValue : undefined,
                    balanceValue: balanceValue,
                }));
            if (data.length > 0) {
                const nonLockupTokens = (
                    selectedTokenGroup?.tokens ?? []
                ).filter((t) => t.residency !== "Lockup");
                const selectedTokenIdsWithPrices = new Set(
                    Object.entries(balanceChartData)
                        .filter(
                            ([, snapshots]) =>
                                Array.isArray(snapshots) &&
                                snapshots.some((s) => s.priceUsd != null),
                        )
                        .map(([tokenId]) => tokenId),
                );
                const hasHistoricalPrices =
                    selectedTokenGroup?.tokenIds.some((id) =>
                        selectedTokenIdsWithPrices.has(id),
                    ) ?? false;
                const nowUSD = hasHistoricalPrices
                    ? nonLockupTokens.reduce((sum, t) => sum + t.balanceUSD, 0)
                    : undefined;
                const nowBalance = nonLockupTokens.reduce(
                    (sum, t) =>
                        sum +
                        Big(
                            formatBalance(
                                availableBalance(t.balance),
                                t.decimals,
                            ),
                        ).toNumber(),
                    0,
                );
                data.push({
                    name: t("chartNow"),
                    fullDate: undefined,
                    usdValue: nowUSD,
                    balanceValue: nowBalance,
                });
            }
            return { data, showUSD: hasAnyUSD };
        }
    }, [
        balanceChartData,
        selectedToken,
        selectedTokenGroup,
        selectedPeriod,
        tokens,
        groupedTokens,
        locale,
    ]);

    // Symbols excluded from the "all tokens" chart USD calculation (no historical prices)
    const chartExcludedSymbols = useMemo(() => {
        if (!balanceChartData) return [];
        const tokenIdsWithPrices = new Set(
            Object.entries(balanceChartData)
                .filter(
                    ([, snapshots]) =>
                        Array.isArray(snapshots) &&
                        snapshots.some((s) => s.priceUsd != null),
                )
                .map(([tokenId]) => tokenId),
        );

        return groupedTokens
            .filter(
                (group) =>
                    !group.tokenIds.some((id) => tokenIdsWithPrices.has(id)),
            )
            .map((group) => group.symbol);
    }, [balanceChartData, groupedTokens]);

    // Freeze chart data while hovering so tooltip isn't lost when parent
    // re-renders due to other queries (e.g. token balance) refetching.
    const frozenChartData = useRef(chartData);
    if (!isChartHovered) {
        frozenChartData.current = chartData;
    }
    const displayChartData = frozenChartData.current;

    if (isLoadingTokens) {
        return (
            <PageCard className="relative">
                <div className="flex justify-around gap-4 mb-6">
                    <div className="flex-1">
                        <h3 className="font-medium text-base text-gray-500">
                            {t("totalBalance")}
                        </h3>
                        <Skeleton className="mt-2 h-11 w-56 rounded-xl" />
                    </div>

                    <div className="flex md:flex-row items-end flex-col gap-1 md:gap-2 md:items-center">
                        <Skeleton className="h-10 w-[168px] rounded-full" />
                        <Skeleton className="h-10 w-[100px] rounded-full" />
                    </div>
                </div>

                <div className="grid grid-cols-3 gap-2 md:gap-4">
                    <Skeleton className="h-13 w-full rounded-2xl" />
                    <Skeleton className="h-13 w-full rounded-2xl" />
                    <Skeleton className="h-13 w-full rounded-2xl" />
                </div>
                <div className="h-56 w-full space-y-3 p-4">
                    <Skeleton className="h-50 w-full" />
                </div>
            </PageCard>
        );
    }

    return (
        <PageCard id="balance-with-graph">
            <div className="mb-6">
                <div className="flex justify-between gap-4 items-start">
                    <div className="flex-1">
                        <h3 className="flex items-center gap-1.5 font-medium text-base text-gray-500">
                            {t("totalBalance")}
                            {showConfidentialShield && (
                                <Tooltip
                                    content={tCommon("confidentialDataTooltip")}
                                >
                                    <span className="inline-flex">
                                        <Shield className="size-4 fill-foreground" />
                                    </span>
                                </Tooltip>
                            )}
                            {!isConfidential &&
                                selectedToken === "all" &&
                                chartExcludedSymbols.length > 0 && (
                                    <Tooltip
                                        side="right"
                                        content={
                                            <div>
                                                <p className="font-medium mb-1">
                                                    {t("excludedTokens")}
                                                </p>
                                                <p>
                                                    {chartExcludedSymbols.join(
                                                        ", ",
                                                    )}
                                                </p>
                                            </div>
                                        }
                                    >
                                        <Info className="size-3 cursor-help" />
                                    </Tooltip>
                                )}
                            <button
                                type="button"
                                onClick={() => setIsBalanceMasked((v) => !v)}
                                aria-label={
                                    isBalanceMasked
                                        ? t("showBalance")
                                        : t("hideBalance")
                                }
                                aria-pressed={isBalanceMasked}
                                className="cursor-pointer text-gray-400 transition-colors hover:text-gray-700"
                            >
                                {isBalanceMasked ? (
                                    <EyeOff className="size-4" />
                                ) : (
                                    <Eye className="size-4" />
                                )}
                            </button>
                        </h3>
                        <p className="mt-2 font-bold text-[2.5rem]/11 tracking-tighter">
                            {isHidden || isBalanceMasked ? (
                                "••••••"
                            ) : (
                                <AnimatedCurrency
                                    value={balanceView.totalUsd}
                                />
                            )}
                        </p>
                        {showBreakdown && (
                            <div className="mt-2 hidden md:flex items-center gap-2 text-sm text-muted-foreground">
                                {balanceBreakdownItems.map((item, idx) => (
                                    <div key={item.key} className="contents">
                                        {idx > 0 && (
                                            <span
                                                aria-hidden="true"
                                                className="h-3 w-px bg-border"
                                            />
                                        )}
                                        <span>
                                            {t(
                                                `bucket${item.key[0].toUpperCase()}${item.key.slice(1)}` as
                                                    | "bucketAvailable"
                                                    | "bucketLocked"
                                                    | "bucketEarning",
                                            )}{" "}
                                            <span className="font-semibold text-foreground">
                                                {formatCurrencyWithSubCent(
                                                    item.value,
                                                )}
                                            </span>
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    {!isConfidential && (
                        <div className="hidden md:flex md:flex-row items-end flex-col gap-1 md:gap-2 md:items-center">
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="pill"
                                        size="sm"
                                        disabled={isLoadingTokens || isLoading}
                                        className={cn(
                                            FILTER_PILL_CLASS,
                                            "justify-between",
                                        )}
                                        data-testid="chart-token-trigger"
                                    >
                                        {selectedToken === "all" ? (
                                            <span className="flex items-center gap-2">
                                                <Coins className="size-4" />
                                                <span>{t("allTokens")}</span>
                                            </span>
                                        ) : (
                                            <span className="flex items-center gap-2">
                                                {selectedTokenGroup?.icon && (
                                                    <img
                                                        src={
                                                            selectedTokenGroup.icon
                                                        }
                                                        alt={
                                                            selectedTokenGroup.symbol
                                                        }
                                                        width={20}
                                                        height={20}
                                                        className="size-5 rounded-full"
                                                    />
                                                )}
                                                <span>{selectedToken}</span>
                                            </span>
                                        )}
                                        <ChevronDown className="size-4 opacity-50" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    align="end"
                                    className={cn(
                                        FILTER_MENU_CLASS,
                                        "min-w-[168px] p-0",
                                    )}
                                >
                                    <ScrollContainer className="max-h-[300px] p-1.5">
                                        <DropdownMenuItem
                                            onSelect={() =>
                                                setSelectedToken("all")
                                            }
                                            className={cn(
                                                FILTER_MENU_ITEM_CLASS,
                                                "flex items-center justify-between",
                                            )}
                                        >
                                            <span className="flex items-center gap-3">
                                                <Coins className="size-5" />
                                                <span>{t("allTokens")}</span>
                                            </span>
                                            {selectedToken === "all" && (
                                                <Check className="size-4 text-foreground" />
                                            )}
                                        </DropdownMenuItem>
                                        {groupedTokens.map((group) => (
                                            <DropdownMenuItem
                                                key={group.symbol}
                                                onSelect={() =>
                                                    setSelectedToken(
                                                        group.symbol,
                                                    )
                                                }
                                                className={cn(
                                                    FILTER_MENU_ITEM_CLASS,
                                                    "flex items-center justify-between",
                                                )}
                                            >
                                                <span className="flex items-center gap-3">
                                                    {group.icon && (
                                                        <img
                                                            src={group.icon}
                                                            alt={group.symbol}
                                                            width={20}
                                                            height={20}
                                                            className="size-5 rounded-full"
                                                        />
                                                    )}
                                                    <span>{group.symbol}</span>
                                                </span>
                                                {selectedToken ===
                                                    group.symbol && (
                                                    <Check className="size-4 text-foreground" />
                                                )}
                                            </DropdownMenuItem>
                                        ))}
                                    </ScrollContainer>
                                </DropdownMenuContent>
                            </DropdownMenu>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="pill"
                                        size="sm"
                                        disabled={isLoadingTokens || isLoading}
                                        className={cn(
                                            FILTER_PILL_CLASS,
                                            "w-fit justify-between gap-1.5",
                                        )}
                                        data-testid="chart-period-trigger"
                                    >
                                        <span>
                                            {t(`period.${selectedPeriod}`)}
                                        </span>
                                        <ChevronDown className="size-4 opacity-50" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    align="end"
                                    className={cn(
                                        FILTER_MENU_CLASS,
                                        "min-w-[112px]",
                                    )}
                                >
                                    {TIME_PERIODS.map((period) => (
                                        <DropdownMenuItem
                                            key={period}
                                            onSelect={() =>
                                                setSelectedPeriod(period)
                                            }
                                            className={cn(
                                                FILTER_MENU_ITEM_CLASS,
                                                "flex items-center justify-between",
                                            )}
                                            data-testid={`chart-period-option-${period}`}
                                        >
                                            <span>{t(`period.${period}`)}</span>
                                            {selectedPeriod === period && (
                                                <Check className="size-4 text-foreground" />
                                            )}
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    )}
                    <HistoryRefreshButton className="h-10 w-10 rounded-2xl bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900 dark:bg-white/10 dark:text-gray-200 dark:hover:bg-white/20" />
                </div>
                {showBreakdown && (
                    <div className="mt-4 border-t border-border/70 pt-3 space-y-3 md:hidden">
                        {balanceBreakdownItems.map((item) => (
                            <div
                                key={item.key}
                                className="flex items-center justify-between text-base"
                            >
                                <span className="text-muted-foreground">
                                    {t(
                                        `bucket${item.key[0].toUpperCase()}${item.key.slice(1)}` as
                                            | "bucketAvailable"
                                            | "bucketLocked"
                                            | "bucketEarning",
                                    )}
                                </span>
                                <span className="font-semibold text-foreground">
                                    {formatCurrencyWithSubCent(item.value)}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="grid grid-cols-3 gap-2 md:gap-4">
                <Button
                    onClick={onDepositClick}
                    id="dashboard-step1"
                    size="xl"
                    className="max-md:h-11 max-md:px-3 max-md:text-sm"
                >
                    <ArrowDown className="size-4 max-md:size-3.5" />{" "}
                    {t("receive")}
                </Button>
                <AuthButton
                    permissionKind="transfer"
                    permissionAction="AddProposal"
                    size="xl"
                    className="w-full max-md:h-11 max-md:px-3 max-md:text-sm"
                    id="dashboard-step2"
                    onClick={() => router.push(`/${treasuryId}/payments`)}
                >
                    <Navigation className="size-4 max-md:size-3.5" />
                    {t("send")}
                </AuthButton>
                <AuthButton
                    permissionKind="call"
                    permissionAction="AddProposal"
                    size="xl"
                    className="w-full max-md:h-11 max-md:px-3 max-md:text-sm"
                    id="dashboard-step3"
                    onClick={() => router.push(`/${treasuryId}/exchange`)}
                >
                    <SwapIcon className="size-4 max-md:size-3.5" /> {t("swap")}
                </AuthButton>
                {/*<AuthButton permissionKind="call" permissionAction="AddProposal" className="w-full">
                    <Database className="size-4" /> Earn
                </AuthButton> */}
            </div>
            <div
                className={cn(
                    "mt-3 flex gap-2 md:hidden",
                    isConfidential ? "hidden" : "",
                )}
            >
                <Select value={selectedToken} onValueChange={setSelectedToken}>
                    <SelectTrigger
                        size="sm"
                        className={cn(FILTER_MOBILE_TRIGGER_CLASS, "w-[150px]")}
                        disabled={
                            isLoadingTokens || (!isConfidential && isLoading)
                        }
                    >
                        <SelectValue>
                            {selectedToken === "all" ? (
                                <div className="flex items-center gap-2">
                                    <Coins className="size-4" />
                                    <span>{t("allTokens")}</span>
                                </div>
                            ) : (
                                <div className="flex items-center gap-2">
                                    {selectedTokenGroup?.icon && (
                                        <img
                                            src={selectedTokenGroup.icon}
                                            alt={selectedTokenGroup.symbol}
                                            width={20}
                                            height={20}
                                            className="size-5 rounded-full"
                                        />
                                    )}
                                    <span>{selectedToken}</span>
                                </div>
                            )}
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent className={cn(FILTER_MENU_CLASS, "p-0")}>
                        <SelectItem
                            value="all"
                            className={FILTER_SELECT_ITEM_CLASS}
                        >
                            <div className="flex items-center gap-3">
                                <Coins className="size-5" />
                                <span>{t("allTokens")}</span>
                            </div>
                        </SelectItem>
                        {groupedTokens.map((group) => (
                            <SelectItem
                                key={group.symbol}
                                value={group.symbol}
                                className={FILTER_SELECT_ITEM_CLASS}
                            >
                                <div className="flex items-center gap-3">
                                    {group.icon && (
                                        <img
                                            src={group.icon}
                                            alt={group.symbol}
                                            width={20}
                                            height={20}
                                            className="size-5 rounded-full"
                                        />
                                    )}
                                    <span>{group.symbol}</span>
                                </div>
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {!isConfidential && (
                    <Select
                        value={selectedPeriod}
                        onValueChange={(value) =>
                            setSelectedPeriod(value as TimePeriod)
                        }
                    >
                        <SelectTrigger
                            size="sm"
                            className={cn(
                                FILTER_MOBILE_TRIGGER_CLASS,
                                "w-[100px]",
                            )}
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent className={cn(FILTER_MENU_CLASS, "p-0")}>
                            {TIME_PERIODS.map((period) => (
                                <SelectItem
                                    key={period}
                                    value={period}
                                    className={FILTER_SELECT_ITEM_CLASS}
                                >
                                    {t(`period.${period}`)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
            </div>
            <div className={cn(isConfidential ? "hidden" : "")}>
                {isLoading ||
                isHistoryRefreshing ||
                (isFetching && chartData.data.length === 0) ? (
                    <div className="h-56 w-full space-y-3 p-4">
                        <Skeleton className="h-50 w-full" />
                    </div>
                ) : selectedToken !== "all" &&
                  displayChartData.data.length === 0 ? (
                    <EmptyState
                        icon={ClockIcon}
                        title={t("noTokenChartTitle")}
                        description={t("noTokenChartDescription", {
                            symbol: selectedTokenGroup?.symbol ?? selectedToken,
                        })}
                        className="h-56"
                    />
                ) : (
                    <BalanceChart
                        data={displayChartData.data}
                        symbol={selectedTokenGroup?.symbol}
                        timePeriod={selectedPeriod}
                        onMouseEnter={handleChartMouseEnter}
                        onMouseLeave={handleChartMouseLeave}
                    />
                )}
            </div>
        </PageCard>
    );
}
