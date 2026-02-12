import { TreasuryAsset } from "@/lib/api";
import { useState, useMemo } from "react";
import BalanceChart from "./chart";
import { Button } from "@/components/button";
import {
    ArrowLeftRight,
    ArrowUpRightIcon,
    Download,
    Coins,
} from "lucide-react";
import {
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
} from "@/components/ui/select";
import { useBalanceChart } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/hooks/use-treasury";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PageCard } from "@/components/card";
import { formatBalance, formatCurrency } from "@/lib/utils";
import type { ChartInterval } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthButton } from "@/components/auth-button";
import Big from "@/lib/big";
import { totalBalance } from "@/lib/balance";
import { useRouter } from "next/navigation";

interface Props {
    totalBalanceUSD: number | Big.Big;
    tokens: TreasuryAsset[];
    onDepositClick: () => void;
    isLoading?: boolean;
}

type TimePeriod = "1W" | "1M" | "3M" | "1Y";

const TIME_PERIODS: TimePeriod[] = ["1W", "1M", "3M", "1Y"];

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
): string => {
    const date = new Date(timestamp);

    switch (period) {
        case "1W":
        case "1M":
            // Show date: "6 Jan"
            return date.toLocaleDateString("en-US", {
                day: "numeric",
                month: "short",
            });
        case "1Y":
            // Show month and year: "Mar '25"
            const month = date.toLocaleDateString("en-US", { month: "short" });
            const year = date.toLocaleDateString("en-US", { year: "2-digit" });
            return `${month} '${year}`;
        default:
            return date.toLocaleDateString();
    }
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
    totalBalanceUSD,
    tokens,
    onDepositClick,
    isLoading: isLoadingTokens,
}: Props) {
    const { treasuryId } = useTreasury();
    const [selectedToken, setSelectedToken] = useState<string>("all");
    const [selectedPeriod, setSelectedPeriod] = useState<TimePeriod>("1W");
    const router = useRouter();
    // Group tokens by symbol (to handle same token on different networks)
    const groupedTokens = useMemo(() => {
        const grouped = new Map<string, GroupedToken>();

        for (const token of tokens) {
            const existing = grouped.get(token.symbol);

            // Convert token ID to balance-history format
            // Intents tokens need "intents.near:" prefix for balance-history API
            // Staked tokens need "staking:" prefix with pool IDs
            let tokenIdsForHistory: string[] = [];
            if (
                token.residency === "Intents" &&
                !token.id.startsWith("intents.near:")
            ) {
                tokenIdsForHistory = [`intents.near:${token.id}`];
            } else if (
                token.residency === "Staked" &&
                "staking" in token.balance
            ) {
                tokenIdsForHistory = token.balance.staking.pools.map(
                    (p) => `staking:${p.poolId}`,
                );
            } else {
                tokenIdsForHistory = [token.id];
            }

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
    }, [tokens, totalBalanceUSD]);

    // Get the selected token group
    const selectedTokenGroup =
        selectedToken === "all"
            ? null
            : groupedTokens.find((group) => group.symbol === selectedToken);

    const balance = selectedTokenGroup
        ? selectedTokenGroup.totalBalanceUSD
        : totalBalanceUSD;

    // Calculate time range for chart API
    const chartParams = useMemo(() => {
        if (!treasuryId) return null;

        const endTime = new Date();
        const hoursBack = PERIOD_TO_HOURS[selectedPeriod];
        const startTime = new Date(
            endTime.getTime() - hoursBack * 60 * 60 * 1000,
        );

        // Validate dates
        if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
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
    }, [treasuryId, selectedPeriod, selectedTokenGroup]);

    // Fetch balance chart data with USD values
    const { data: balanceChartData, isLoading } = useBalanceChart(chartParams);

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

            for (const [tokenId, snapshots] of Object.entries(
                balanceChartData,
            )) {
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
                    name: formatTimestampForPeriod(timestamp, selectedPeriod),
                    usdValue: usdValue,
                }));

            if (data.length > 0) {
                data.push({
                    name: "Now",
                    usdValue: Number(totalBalanceUSD),
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
                    name: formatTimestampForPeriod(timestamp, selectedPeriod),
                    usdValue: hasUSD ? usdValue : undefined,
                    balanceValue: balanceValue,
                }));
            if (data.length > 0) {
                data.push({
                    name: "Now",
                    usdValue: Number(selectedTokenGroup?.totalBalanceUSD),
                    balanceValue:
                        selectedTokenGroup?.totalBalance.toNumber() || 0,
                });
            }
            return { data, showUSD: hasAnyUSD };
        }
    }, [
        balanceChartData,
        selectedToken,
        selectedTokenGroup,
        selectedPeriod,
        totalBalanceUSD,
    ]);

    if (isLoadingTokens) {
        return (
            <PageCard>
                <div className="flex justify-around gap-4 mb-6">
                    <div className="flex-1">
                        <h3 className="text-xs font-medium text-muted-foreground">
                            Total Balance
                        </h3>
                        <Skeleton className="h-9 w-40 mt-2" />
                    </div>
                    <div className="flex md:flex-row items-end flex-col gap-1 md:gap-2 md:items-center">
                        <Skeleton className="h-8 w-[140px]" />
                        <Skeleton className="h-8 w-[160px]" />
                    </div>
                </div>

                <div className="grid grid-cols-3 gap-2 md:gap-4">
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                </div>
                <div className="h-56 w-full space-y-3 p-4">
                    <Skeleton className="h-50 w-full" />
                </div>
            </PageCard>
        );
    }

    return (
        <PageCard>
            <div className="mb-6">
                <div className="flex justify-between gap-4">
                    <div className="flex-1">
                        <h3 className="text-xs font-medium text-muted-foreground">
                            Total Balance
                        </h3>
                        <p className="text-3xl font-bold mt-2">
                            {formatCurrency(Number(balance))}
                        </p>
                    </div>
                    <div className="hidden md:flex md:flex-row items-end flex-col gap-1 md:gap-2 md:items-center">
                        <Select
                            value={selectedToken}
                            onValueChange={setSelectedToken}
                        >
                            <SelectTrigger
                                size="sm"
                                className="min-w-[140px] w-full"
                            >
                                <SelectValue>
                                    {selectedToken === "all" ? (
                                        <div className="flex items-center gap-2">
                                            <Coins className="size-4" />
                                            <span>All Tokens</span>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-2">
                                            {selectedTokenGroup?.icon && (
                                                <img
                                                    src={
                                                        selectedTokenGroup.icon
                                                    }
                                                    alt={
                                                        selectedTokenGroup.symbol
                                                    }
                                                    width={16}
                                                    height={16}
                                                    className="rounded-full"
                                                />
                                            )}
                                            <span>{selectedToken}</span>
                                        </div>
                                    )}
                                </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">
                                    <div className="flex items-center gap-2">
                                        <Coins className="size-4" />
                                        <span>All Tokens</span>
                                    </div>
                                </SelectItem>
                                {groupedTokens.map((group) => (
                                    <SelectItem
                                        key={group.symbol}
                                        value={group.symbol}
                                    >
                                        <div className="flex items-center gap-2">
                                            {group.icon && (
                                                <img
                                                    src={group.icon}
                                                    alt={group.symbol}
                                                    width={16}
                                                    height={16}
                                                    className="rounded-full"
                                                />
                                            )}
                                            <span>{group.symbol}</span>
                                        </div>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <ToggleGroup
                            type="single"
                            size="sm"
                            variant={"outline"}
                            value={selectedPeriod}
                            onValueChange={(e) =>
                                e && setSelectedPeriod(e as TimePeriod)
                            }
                        >
                            {TIME_PERIODS.map((e) => (
                                <ToggleGroupItem key={e} value={e}>
                                    {e}
                                </ToggleGroupItem>
                            ))}
                        </ToggleGroup>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-3 gap-2 md:gap-4">
                <Button onClick={onDepositClick} id="dashboard-step1">
                    <Download className="size-4" /> Deposit
                </Button>
                <AuthButton
                    permissionKind="transfer"
                    permissionAction="AddProposal"
                    className="w-full"
                    id="dashboard-step2"
                    onClick={() => router.push(`/${treasuryId}/payments`)}
                >
                    <ArrowUpRightIcon className="size-4" />
                    Send
                </AuthButton>
                <AuthButton
                    permissionKind="call"
                    permissionAction="AddProposal"
                    className="w-full"
                    id="dashboard-step3"
                >
                    <ArrowLeftRight className="size-4" /> Exchange
                </AuthButton>
                {/*<AuthButton permissionKind="call" permissionAction="AddProposal" className="w-full">
                    <Database className="size-4" /> Earn
                </AuthButton> */}
            </div>
            <div className="mt-3 flex gap-2 md:hidden">
                <Select value={selectedToken} onValueChange={setSelectedToken}>
                    <SelectTrigger size="sm" className="w-[140px]">
                        <SelectValue>
                            {selectedToken === "all" ? (
                                <div className="flex items-center gap-2">
                                    <Coins className="size-4" />
                                    <span>All Tokens</span>
                                </div>
                            ) : (
                                <div className="flex items-center gap-2">
                                    {selectedTokenGroup?.icon && (
                                        <img
                                            src={selectedTokenGroup.icon}
                                            alt={selectedTokenGroup.symbol}
                                            width={16}
                                            height={16}
                                            className="rounded-full"
                                        />
                                    )}
                                    <span>{selectedToken}</span>
                                </div>
                            )}
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">
                            <div className="flex items-center gap-2">
                                <Coins className="size-4" />
                                <span>All Tokens</span>
                            </div>
                        </SelectItem>
                        {groupedTokens.map((group) => (
                            <SelectItem key={group.symbol} value={group.symbol}>
                                <div className="flex items-center gap-2">
                                    {group.icon && (
                                        <img
                                            src={group.icon}
                                            alt={group.symbol}
                                            width={16}
                                            height={16}
                                            className="rounded-full"
                                        />
                                    )}
                                    <span>{group.symbol}</span>
                                </div>
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Select
                    value={selectedPeriod}
                    onValueChange={(value) =>
                        setSelectedPeriod(value as TimePeriod)
                    }
                >
                    <SelectTrigger size="sm" className="w-[92px]">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {TIME_PERIODS.map((period) => (
                            <SelectItem key={period} value={period}>
                                {period}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            {isLoading ? (
                <div className="h-56 w-full space-y-3 p-4">
                    <Skeleton className="h-50 w-full" />
                </div>
            ) : (
                <BalanceChart
                    data={chartData.data}
                    symbol={selectedTokenGroup?.symbol}
                />
            )}
        </PageCard>
    );
}
