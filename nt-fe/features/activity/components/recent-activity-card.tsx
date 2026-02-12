"use client";

import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
    ArrowDownToLine,
    ArrowUpToLine,
    ArrowRightLeft,
    ArrowRight,
    Clock,
    ChevronRight,
} from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { useRecentActivity } from "@/hooks/use-treasury-queries";
import { useSubscription } from "@/hooks/use-subscription";
import { useProposals } from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";
import { cn } from "@/lib/utils";
import { formatHistoryDuration, getFromAccount, getToAccount } from "../utils/history-utils";
import { useState, useMemo, useEffect } from "react";
import type { RecentActivity as RecentActivityType } from "@/lib/api";

type GroupedActivity = {
    type: "single";
    activity: RecentActivityType;
} | {
    type: "grouped";
    pool: string;
    activities: RecentActivityType[];
    totalAmount: string;
    tokenMetadata: RecentActivityType["tokenMetadata"];
    blockTime: string; // Most recent time
};
import {
    useReactTable,
    getCoreRowModel,
    flexRender,
    createColumnHelper,
    ColumnDef,
} from "@tanstack/react-table";
import { Table, TableBody, TableCell, TableRow } from "@/components/table";
import { FormattedDate } from "@/components/formatted-date";
import { TransactionDetailsModal } from "./transaction-details-modal";
import { MemberOnlyExportButton } from "@/components/member-only-export-button";
import Link from "next/link";
import { Checkbox } from "@/components/ui/checkbox";

const ITEMS_ON_DASHBOARD = 10;
const BATCH_SIZE = 25;
const MAX_ITEMS = 100;

const columnHelper = createColumnHelper<GroupedActivity>();

// Helper function to detect if an activity is a staking reward
const isStakingReward = (activity: RecentActivityType): boolean => {
    return (
        activity.tokenId === "near" &&
        activity.counterparty !== null &&
        parseFloat(activity.amount) > 0 // Staking rewards are always positive
    );
};

// Group consecutive staking rewards from the same pool
const groupStakingActivities = (
    activities: RecentActivityType[],
): GroupedActivity[] => {
    const grouped: GroupedActivity[] = [];
    let i = 0;

    while (i < activities.length) {
        const current = activities[i];

        if (isStakingReward(current)) {
            // Look ahead to find consecutive staking rewards from the same pool
            const pool = current.counterparty!;
            const group: RecentActivityType[] = [current];
            let j = i + 1;

            while (
                j < activities.length &&
                isStakingReward(activities[j]) &&
                activities[j].counterparty === pool
            ) {
                group.push(activities[j]);
                j++;
            }

            // Only group if there are 2 or more transactions from the same pool
            if (group.length >= 2) {
                const totalAmount = group
                    .reduce(
                        (sum, activity) => sum + parseFloat(activity.amount),
                        0,
                    )
                    .toString();

                grouped.push({
                    type: "grouped",
                    pool,
                    activities: group,
                    totalAmount,
                    tokenMetadata: current.tokenMetadata,
                    blockTime: current.blockTime, // Most recent (first in list)
                });

                i = j;
            } else {
                grouped.push({ type: "single", activity: current });
                i++;
            }
        } else {
            grouped.push({ type: "single", activity: current });
            i++;
        }
    }

    return grouped;
};

export function RecentActivity() {
    const { treasuryId } = useTreasury();
    const [hideSmallTransactions, setHideSmallTransactions] = useState(false);
    const [selectedActivity, setSelectedActivity] = useState<RecentActivityType | null>(null);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
    const [fetchLimit, setFetchLimit] = useState(BATCH_SIZE);

    const {
        data: response,
        isLoading,
    } = useRecentActivity(
        treasuryId,
        fetchLimit,
        0,
        hideSmallTransactions ? 1 : undefined,
    );

    const { data: planDetails } = useSubscription(treasuryId);

    const activities = response?.data || [];
    const historyMonths = planDetails?.planConfig?.limits?.historyLookupMonths;

    // Group staking activities
    const groupedActivities = useMemo(
        () => groupStakingActivities(activities),
        [activities],
    );

    // Dynamically fetch more data if needed
    useEffect(() => {
        // Only fetch more if:
        // 1. We have data
        // 2. We don't have enough grouped rows
        // 3. We haven't reached the max limit
        // 4. We're not currently loading
        if (
            !isLoading &&
            activities.length > 0 &&
            groupedActivities.length < ITEMS_ON_DASHBOARD &&
            fetchLimit < MAX_ITEMS &&
            activities.length >= fetchLimit // We got all the data we asked for
        ) {
            const nextLimit = Math.min(fetchLimit + BATCH_SIZE, MAX_ITEMS);
            setFetchLimit(nextLimit);
        }
    }, [activities.length, groupedActivities.length, fetchLimit, isLoading]);

    // Reset fetch limit when filters change
    useEffect(() => {
        setFetchLimit(BATCH_SIZE);
    }, [hideSmallTransactions, treasuryId]);

    // Take only the first ITEMS_ON_DASHBOARD after grouping
    const displayedActivities = useMemo(
        () => groupedActivities.slice(0, ITEMS_ON_DASHBOARD),
        [groupedActivities],
    );

    const toggleGroup = (groupId: string) => {
        setExpandedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(groupId)) {
                next.delete(groupId);
            } else {
                next.add(groupId);
            }
            return next;
        });
    };

    const handleActivityClick = (activity: RecentActivityType) => {
        setSelectedActivity(activity);
        setIsModalOpen(true);
    };

    const formatAmount = (amount: string, decimals: number) => {
        const num = parseFloat(amount);
        const absNum = Math.abs(num);
        const sign = num >= 0 ? "+" : "-";

        const decimalPlaces = absNum >= 1 ? 2 : Math.min(6, decimals);

        return `${sign}${absNum.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: decimalPlaces,
        })}`;
    };

    const formatSwapAmount = (amount: string, decimals: number) => {
        const num = Math.abs(parseFloat(amount));
        const decimalPlaces = num >= 1 ? 2 : Math.min(6, decimals);
        return num.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: decimalPlaces,
        });
    };

    const getActivityType = (activity: RecentActivityType) => {
        if (activity.swap) return "Swap";
        const isReceived = parseFloat(activity.amount) > 0;
        return isReceived ? "Payment Received" : "Payment Sent";
    };

    const getActivityFrom = (activity: RecentActivityType) => {
        if (activity.swap) return "via NEAR Intents";

        const isReceived = parseFloat(activity.amount) > 0;

        // For received payments: show sender
        if (isReceived) {
            const from = getFromAccount(activity, isReceived);
            return from !== "—" ? `from ${from}` : "from unknown";
        }

        // For sent payments: show recipient
        const to = getToAccount(activity, isReceived, treasuryId);
        return to !== "—" ? `to ${to}` : "to unknown";
    };

    const historyDescription = formatHistoryDuration(historyMonths);

    const columns = useMemo<ColumnDef<GroupedActivity, any>[]>(
        () => [
            columnHelper.display({
                id: "type",
                header: "",
                cell: ({ row }) => {
                    const grouped = row.original;

                    if (grouped.type === "grouped") {
                        return (
                            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                                <div
                                    className={cn(
                                        "flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-full shrink-0",
                                        "bg-general-success-background-faded",
                                    )}
                                >
                                    <ArrowDownToLine className="h-4 w-4 sm:h-5 sm:w-5 text-general-success-foreground" />
                                </div>
                                <div className="min-w-0 flex-1 overflow-hidden">
                                    <div className="text-sm sm:text-base font-semibold truncate">
                                        Staking Rewards
                                    </div>
                                    <div className="text-xs sm:text-sm text-muted-foreground font-medium truncate">
                                        from {grouped.pool}
                                    </div>
                                </div>
                            </div>
                        );
                    }

                    const activity = grouped.activity;
                    const isSwap = !!activity.swap;
                    const isReceived = parseFloat(activity.amount) > 0;
                    const activityType = getActivityType(activity);

                    return (
                        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                            <div
                                className={cn(
                                    "flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-full shrink-0",
                                    isSwap
                                        ? "bg-blue-500/10"
                                        : isReceived
                                            ? "bg-general-success-background-faded"
                                            : "bg-general-destructive-background-faded",
                                )}
                            >
                                {isSwap ? (
                                    <ArrowRightLeft className="h-4 w-4 sm:h-5 sm:w-5 text-blue-500" />
                                ) : isReceived ? (
                                    <ArrowDownToLine className="h-4 w-4 sm:h-5 sm:w-5 text-general-success-foreground" />
                                ) : (
                                    <ArrowUpToLine className="h-4 w-4 sm:h-5 sm:w-5 text-general-destructive-foreground" />
                                )}
                            </div>
                            <div className="min-w-0 flex-1 overflow-hidden">
                                <div className="text-sm sm:text-base font-semibold truncate">
                                    {activityType}
                                </div>
                                <div className="text-xs sm:text-sm text-muted-foreground font-medium truncate">
                                    {getActivityFrom(activity)}
                                </div>
                            </div>
                        </div>
                    );
                },
            }),
            columnHelper.display({
                id: "amount",
                header: "",
                cell: ({ row }) => {
                    const grouped = row.original;

                    if (grouped.type === "grouped") {
                        const groupId = `${grouped.pool}-${grouped.blockTime}`;
                        const isExpanded = expandedGroups.has(groupId);

                        return (
                            <div className="flex items-center justify-end shrink-0">
                                <div className="flex flex-col items-end gap-0.5">
                                    <div className="text-sm sm:text-base whitespace-nowrap font-semibold text-general-success-foreground">
                                        {formatAmount(
                                            grouped.totalAmount,
                                            grouped.tokenMetadata.decimals,
                                        )}{" "}
                                        {grouped.tokenMetadata.symbol}
                                    </div>
                                    <div className="text-xs sm:text-sm text-muted-foreground whitespace-nowrap">
                                        <FormattedDate
                                            date={new Date(grouped.blockTime)}
                                            includeTime
                                        />
                                    </div>
                                </div>
                                <div
                                    className={cn(
                                        "overflow-hidden transition-all shrink-0",
                                        isExpanded
                                            ? "w-6 ml-2"
                                            : "w-0 group-hover:w-6 group-hover:ml-1"
                                    )}
                                >
                                    <ChevronRight
                                        className={cn(
                                            "h-5 w-5 text-muted-foreground transition-transform",
                                            isExpanded && "rotate-90",
                                        )}
                                    />
                                </div>
                            </div>
                        );
                    }

                    const activity = grouped.activity;
                    const isReceived = parseFloat(activity.amount) > 0;

                    if (activity.swap) {
                        const swap = activity.swap;
                        return (
                            <div className="text-right">
                                <div className="flex items-center justify-end gap-1.5">
                                    {swap.sentAmount &&
                                        swap.sentTokenMetadata ? (
                                        <span className="font-semibold text-general-destructive-foreground">
                                            {formatSwapAmount(
                                                swap.sentAmount,
                                                swap.sentTokenMetadata.decimals,
                                            )}{" "}
                                            {swap.sentTokenMetadata.symbol}
                                        </span>
                                    ) : (
                                        <span className="font-semibold text-muted-foreground">
                                            ?
                                        </span>
                                    )}
                                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                    <span className="font-semibold text-general-success-foreground">
                                        {formatSwapAmount(
                                            swap.receivedAmount,
                                            swap.receivedTokenMetadata.decimals,
                                        )}{" "}
                                        {swap.receivedTokenMetadata.symbol}
                                    </span>
                                </div>
                                <div className="text-sm text-muted-foreground">
                                    <FormattedDate
                                        date={new Date(activity.blockTime)}
                                        includeTime
                                    />
                                </div>
                            </div>
                        );
                    }

                    return (
                        <div className="flex items-center justify-end shrink-0">
                            <div className="flex flex-col items-end gap-0.5">
                                <div
                                    className={cn(
                                        "text-sm sm:text-base whitespace-nowrap font-semibold",
                                        isReceived
                                            ? "text-general-success-foreground"
                                            : "text-foreground"
                                    )}
                                >
                                    {formatAmount(
                                        activity.amount,
                                        activity.tokenMetadata.decimals,
                                    )}{" "}
                                    {activity.tokenMetadata.symbol}
                                </div>
                                <div className="text-xs sm:text-sm text-muted-foreground whitespace-nowrap">
                                    <FormattedDate
                                        date={new Date(activity.blockTime)}
                                        includeTime
                                    />
                                </div>
                            </div>
                        </div>
                    );
                },
            }),
        ],
        [expandedGroups],
    );

    const table = useReactTable({
        data: displayedActivities,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getRowId: (row, index) =>
            row.type === "grouped"
                ? `group-${row.pool}-${row.blockTime}`
                : `single-${row.activity.id}`,
    });

    return (
        <>
            <Card className="gap-3 border-none shadow-none">
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3 px-6">
                    <div className="space-y-1">
                        <CardTitle className="text-base md:text-lg font-bold">Recent Transactions</CardTitle>
                        <CardDescription>
                            Sent and received transactions ({historyDescription})
                        </CardDescription>
                    </div>
                    <div className="flex items-center gap-4">
                        {/* TODO: Uncomment after price integration */}
                        {/* <div className="flex items-center gap-2">
                            <Checkbox
                                id="hide-small"
                                checked={hideSmallTransactions}
                                onCheckedChange={(checked) =>
                                    setHideSmallTransactions(!!checked)
                                }
                            />
                            <label
                                htmlFor="hide-small"
                                className="text-sm text-muted-foreground leading-none cursor-pointer whitespace-nowrap"
                            >
                                Hide transactions &lt;1USD
                            </label>
                        </div> */}
                        <MemberOnlyExportButton />
                    </div>
                </CardHeader>
                <CardContent className="px-2">
                    {isLoading ? (
                        <div className="space-y-4 px-4 py-2">
                            {[...Array(3)].map((_, i) => (
                                <div
                                    key={i}
                                    className="flex items-center justify-between"
                                >
                                    <div className="flex items-center gap-3">
                                        <Skeleton className="h-10 w-10 rounded-full" />
                                        <div className="space-y-2">
                                            <Skeleton className="h-10 w-50" />
                                        </div>
                                    </div>
                                    <div className="text-right space-y-2">
                                        <Skeleton className="h-10 w-24" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : activities.length === 0 ? (
                        <EmptyState
                            icon={Clock}
                            title={"Loading your activity"}
                            description={
                                "Your transactions and actions will appear here once they happen"
                            }
                        />
                    ) : (
                        <>
                            <div className="w-full overflow-x-auto px-6">
                                <Table className="table-fixed w-full min-w-full">
                                    <colgroup>
                                        <col />
                                        <col className="w-40 sm:w-52" />
                                    </colgroup>
                                    <TableBody>
                                        {table.getRowModel().rows.map((row) => {
                                            const grouped = row.original;
                                            const isGroup = grouped.type === "grouped";
                                            const groupId = isGroup
                                                ? `${grouped.pool}-${grouped.blockTime}`
                                                : "";
                                            const isExpanded = isGroup && expandedGroups.has(groupId);

                                            return (
                                                <>
                                                    <TableRow
                                                        key={row.id}
                                                        className="group cursor-pointer"
                                                        onClick={() => {
                                                            if (isGroup) {
                                                                toggleGroup(groupId);
                                                            } else {
                                                                handleActivityClick(grouped.activity);
                                                            }
                                                        }}
                                                    >
                                                        {row
                                                            .getVisibleCells()
                                                            .map((cell, idx) => (
                                                                <TableCell
                                                                    key={cell.id}
                                                                    className={cn(
                                                                        "py-3",
                                                                        idx === 0 ? "pl-0 overflow-hidden" : "pr-0"
                                                                    )}
                                                                >
                                                                    {flexRender(
                                                                        cell.column
                                                                            .columnDef.cell,
                                                                        cell.getContext(),
                                                                    )}
                                                                </TableCell>
                                                            ))}
                                                    </TableRow>
                                                    {isExpanded &&
                                                        grouped.activities.map((activity, idx) => (
                                                            <TableRow
                                                                key={`${groupId}-sub-${idx}`}
                                                                className="group cursor-pointer bg-muted/30"
                                                                onClick={() => handleActivityClick(activity)}
                                                            >
                                                                <TableCell className="py-3 pl-8 sm:pl-14 overflow-hidden">
                                                                    <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                                                                        <div
                                                                            className={cn(
                                                                                "flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-full shrink-0",
                                                                                "bg-general-success-background-faded",
                                                                            )}
                                                                        >
                                                                            <ArrowDownToLine className="h-4 w-4 sm:h-5 sm:w-5 text-general-success-foreground" />
                                                                        </div>
                                                                        <div className="min-w-0 flex-1 overflow-hidden">
                                                                            <div className="text-sm sm:text-base font-semibold truncate">
                                                                                Staking Rewards
                                                                            </div>
                                                                            <div className="text-xs sm:text-sm text-muted-foreground font-medium truncate">
                                                                                from {grouped.pool}
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                </TableCell>
                                                                <TableCell className="py-3 pr-0 pl-4">
                                                                    <div className="flex items-center justify-end shrink-0 pr-6">
                                                                        <div className="flex flex-col items-end gap-0.5">
                                                                            <div className="text-sm sm:text-base whitespace-nowrap font-semibold text-general-success-foreground">
                                                                                {formatAmount(
                                                                                    activity.amount,
                                                                                    activity.tokenMetadata.decimals,
                                                                                )}{" "}
                                                                                {activity.tokenMetadata.symbol}
                                                                            </div>
                                                                            <div className="text-xs sm:text-sm text-muted-foreground whitespace-nowrap">
                                                                                <FormattedDate
                                                                                    date={new Date(activity.blockTime)}
                                                                                    includeTime
                                                                                />
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                </TableCell>
                                                            </TableRow>
                                                        ))}
                                                </>
                                            );
                                        })}
                                    </TableBody>
                                </Table>
                            </div>
                            <div className="px-6">
                                <Link href={`/${treasuryId}/dashboard/activity`}>
                                    <Button
                                        variant="outline"
                                        className="w-full mt-4 bg-transparent hover:bg-muted/50"
                                    >
                                        View Full Activity
                                    </Button>
                                </Link>
                            </div>
                        </>
                    )}
                </CardContent>
            </Card>

            <TransactionDetailsModal
                activity={selectedActivity}
                treasuryId={treasuryId || ""}
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
            />
        </>
    );
}
