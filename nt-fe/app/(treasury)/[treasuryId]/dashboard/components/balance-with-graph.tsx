import { TreasuryAsset } from "@/lib/api";
import { useState, useMemo } from "react";
import BalanceChart from "./chart";
import { Button } from "@/components/button";
import { ArrowLeftRight, ArrowUpRightIcon, Database, Download, Coins } from "lucide-react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useBalanceChart, } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/stores/treasury-store";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PageCard } from "@/components/card";
import { formatCurrency } from "@/lib/utils";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { ChartInterval } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthButton } from "@/components/auth-button";

interface Props {
    totalBalanceUSD: number | Big.Big;
    tokens: TreasuryAsset[];
    onDepositClick: () => void;
}

type TimePeriod = "1D" | "1W" | "1M" | "1Y";

const TIME_PERIODS: TimePeriod[] = ["1D", "1W", "1M", "1Y"];

// Map frontend time periods to backend intervals
const PERIOD_TO_INTERVAL: Record<TimePeriod, ChartInterval> = {
    "1D": "hourly",
    "1W": "daily",
    "1M": "daily",
    "1Y": "weekly",
};

// Calculate hours back for each period
const PERIOD_TO_HOURS: Record<TimePeriod, number> = {
    "1D": 24,
    "1W": 24 * 7,
    "1M": 24 * 30,
    "1Y": 24 * 365,
};

// Format timestamp based on time period
const formatTimestampForPeriod = (timestamp: string, period: TimePeriod): string => {
    const date = new Date(timestamp);

    switch (period) {
        case "1D":
            // Show time only: "3:00 PM"
            return date.toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
        case "1W":
        case "1M":
            // Show date: "6 Jan"
            return date.toLocaleDateString('en-US', {
                day: 'numeric',
                month: 'short'
            });
        case "1Y":
            // Show month and year: "Mar '25"
            const month = date.toLocaleDateString('en-US', { month: 'short' });
            const year = date.toLocaleDateString('en-US', { year: '2-digit' });
            return `${month} '${year}`;
        default:
            return date.toLocaleDateString();
    }
};

interface GroupedToken {
    symbol: string;
    tokens: TreasuryAsset[];
    totalBalanceUSD: number;
    icon: string;
    tokenIds: string[];
}

export default function BalanceWithGraph({ totalBalanceUSD, tokens, onDepositClick }: Props) {
    const params = useParams();
    const treasuryId = params?.treasuryId as string | undefined;
    const { selectedTreasury: accountId } = useTreasury();
    const [selectedToken, setSelectedToken] = useState<string>("all");
    const [selectedPeriod, setSelectedPeriod] = useState<TimePeriod>("1W");

    // Group tokens by symbol (to handle same token on different networks)
    const groupedTokens = useMemo(() => {
        const grouped = new Map<string, GroupedToken>();

        for (const token of tokens) {
            const existing = grouped.get(token.symbol);

            // Convert token ID to balance-history format
            // Intents tokens need "intents.near:" prefix for balance-history API
            let tokenIdForHistory = token.id;
            if (token.residency === "Intents" && !token.id.startsWith("intents.near:")) {
                tokenIdForHistory = `intents.near:${token.id}`;
            }

            if (existing) {
                existing.tokens.push(token);
                existing.totalBalanceUSD += token.balanceUSD;
                // Only add if it's not already in the array (deduplicate)
                if (!existing.tokenIds.includes(tokenIdForHistory)) {
                    existing.tokenIds.push(tokenIdForHistory);
                }
            } else {
                grouped.set(token.symbol, {
                    symbol: token.symbol,
                    tokens: [token],
                    totalBalanceUSD: token.balanceUSD,
                    icon: token.icon,
                    tokenIds: [tokenIdForHistory],
                });
            }
        }

        // Sort by total USD value descending
        return Array.from(grouped.values()).sort((a, b) => b.totalBalanceUSD - a.totalBalanceUSD);
    }, [tokens]);

    // Get the selected token group
    const selectedTokenGroup = selectedToken === "all"
        ? null
        : groupedTokens.find(group => group.symbol === selectedToken);

    const balance = selectedTokenGroup ? selectedTokenGroup.totalBalanceUSD : totalBalanceUSD;

    // Calculate time range for chart API
    const chartParams = useMemo(() => {
        if (!accountId) return null;

        const endTime = new Date();
        const hoursBack = PERIOD_TO_HOURS[selectedPeriod];
        const startTime = new Date(endTime.getTime() - (hoursBack * 60 * 60 * 1000));

        // Validate dates
        if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
            return null;
        }

        const params = {
            accountId,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            interval: PERIOD_TO_INTERVAL[selectedPeriod],
            tokenIds: selectedTokenGroup?.tokenIds, // Undefined for "all tokens"
        };

        return params;
    }, [accountId, selectedPeriod, selectedTokenGroup]);

    // Fetch balance chart data with USD values
    const { data: balanceChartData, isLoading } = useBalanceChart(chartParams);

    // Transform chart data for display
    const chartData = useMemo(() => {
        if (!balanceChartData) {
            return { data: [], showUSD: true };
        }

        if (selectedToken === "all") {
            // Aggregate USD values across all tokens
            const timeMap = new Map<string, { usdValue: number; hasUSD: boolean }>();

            for (const [tokenId, snapshots] of Object.entries(balanceChartData)) {
                for (const snapshot of snapshots) {
                    const existing = timeMap.get(snapshot.timestamp) || { usdValue: 0, hasUSD: false };
                    const hasUSD = snapshot.value_usd !== null && snapshot.value_usd !== undefined;

                    timeMap.set(snapshot.timestamp, {
                        usdValue: existing.usdValue + (snapshot.value_usd || 0),
                        hasUSD: existing.hasUSD || hasUSD,
                    });
                }
            }

            const data = Array.from(timeMap.entries())
                .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
                .map(([timestamp, { usdValue }]) => ({
                    name: formatTimestampForPeriod(timestamp, selectedPeriod),
                    value: usdValue,
                }));

            // Check if any snapshot has USD values
            const hasAnyUSD = Array.from(timeMap.values()).some(v => v.hasUSD);

            return { data, showUSD: hasAnyUSD };
        } else {
            // Aggregate values for selected token across all networks
            const timeMap = new Map<string, { usdValue: number; balance: number; hasUSD: boolean }>();

            for (const [tokenId, snapshots] of Object.entries(balanceChartData)) {
                // Only include token IDs that belong to the selected token group
                if (selectedTokenGroup?.tokenIds.includes(tokenId)) {
                    for (const snapshot of snapshots) {
                        const existing = timeMap.get(snapshot.timestamp) || {
                            usdValue: 0,
                            balance: 0,
                            hasUSD: false
                        };
                        const hasUSD = snapshot.value_usd !== null && snapshot.value_usd !== undefined;
                        const balance = parseFloat(snapshot.balance) || 0;

                        timeMap.set(snapshot.timestamp, {
                            usdValue: existing.usdValue + (snapshot.value_usd || 0),
                            balance: existing.balance + balance,
                            hasUSD: existing.hasUSD || hasUSD,
                        });
                    }
                }
            }

            const hasAnyUSD = Array.from(timeMap.values()).some(v => v.hasUSD);

            const data = Array.from(timeMap.entries())
                .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
                .map(([timestamp, { usdValue, balance }]) => ({
                    name: formatTimestampForPeriod(timestamp, selectedPeriod),
                    value: hasAnyUSD ? usdValue : balance,
                }));

            return { data, showUSD: hasAnyUSD };
        }
    }, [balanceChartData, selectedToken, selectedTokenGroup, selectedPeriod]);

    return (
        <PageCard>
            <div className="flex justify-around gap-4 mb-6">
                <div className="flex-1">
                    <h3 className="text-xs font-medium text-muted-foreground">Total Balance</h3>
                    <p className="text-3xl font-bold mt-2">{formatCurrency(Number(balance))}</p>
                </div>
                <div className="flex gap-2 items-center">
                    <Select value={selectedToken} onValueChange={setSelectedToken}>
                        <SelectTrigger size="sm" className="min-w-[140px]">
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
                            {groupedTokens.map(group => (
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
                    <ToggleGroup type="single" size="sm" variant={"outline"} value={selectedPeriod} onValueChange={(e) => setSelectedPeriod(e as TimePeriod)}>
                        {TIME_PERIODS.map((e => <ToggleGroupItem key={e} value={e}>{e}</ToggleGroupItem>))}
                    </ToggleGroup>
                </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Button onClick={onDepositClick} id="dashboard-step1">
                    <Download className="size-4" /> Deposit
                </Button>
                <Link href={treasuryId ? `/${treasuryId}/payments` : "/payments"} className="flex" id="dashboard-step2">
                    <AuthButton permissionKind="transfer" permissionAction="AddProposal" className="w-full">
                        <ArrowUpRightIcon className="size-4" />Send
                    </AuthButton>
                </Link>
                <AuthButton permissionKind="call" permissionAction="AddProposal" className="w-full" id="dashboard-step3">
                    <ArrowLeftRight className="size-4" /> Exchange
                </AuthButton>
                <AuthButton permissionKind="call" permissionAction="AddProposal" className="w-full" id="dashboard-step4">
                    <Database className="size-4" /> Earn
                </AuthButton>
            </div>
            {isLoading ? (
                <div className="h-56 w-full space-y-3 p-4">
                    <Skeleton className="h-50 w-full" />
                </div>
            ) : (
                <BalanceChart data={chartData.data} showUSD={chartData.showUSD} />
            )}
        </PageCard >
    )
}

