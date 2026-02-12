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
    Upload,
    Clock,
} from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { useRecentActivity } from "@/hooks/use-treasury-queries";
import { useSubscription } from "@/hooks/use-subscription";
import { useProposals } from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";
import { cn } from "@/lib/utils";
import { formatHistoryDuration } from "../utils/history-utils";
import { useState, useMemo } from "react";
import type { RecentActivity as RecentActivityType } from "@/lib/api";
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

const ITEMS_ON_DASHBOARD = 10;

const columnHelper = createColumnHelper<RecentActivityType>();

export function RecentActivity() {
    const { treasuryId } = useTreasury();
    const [hideSmallTransactions, setHideSmallTransactions] = useState(false);
    const [selectedActivity, setSelectedActivity] = useState<RecentActivityType | null>(null);
    const [isModalOpen, setIsModalOpen] = useState(false);

    const {
        data: response,
        isLoading,
    } = useRecentActivity(
        treasuryId,
        ITEMS_ON_DASHBOARD,
        0,
        hideSmallTransactions ? 1 : undefined,
    );

    const { data: planDetails } = useSubscription(treasuryId);

    const activities = response?.data || [];
    const historyMonths = planDetails?.planConfig?.limits?.historyLookupMonths;

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

        // If received → show "From counterparty"
        if (isReceived && activity.counterparty) {
            return `from ${activity.counterparty}`;
        }

        // If sent → show "To receiver" (fall back to counterparty)
        if (!isReceived) {
            const to = activity.receiverId || activity.counterparty;
            if (to) return `to ${to}`;
        }

        return isReceived
            ? `from ${activity.counterparty || "unknown"}`
            : "to unknown";
    };

    const historyDescription = formatHistoryDuration(historyMonths);

    const columns = useMemo<ColumnDef<RecentActivityType, any>[]>(
        () => [
            columnHelper.display({
                id: "type",
                header: "",
                cell: ({ row }) => {
                    const activity = row.original;
                    const isSwap = !!activity.swap;
                    const isReceived = parseFloat(activity.amount) > 0;
                    const activityType = getActivityType(activity);

                    return (
                        <div className="flex items-center gap-3 min-w-0">
                            <div
                                className={cn(
                                    "flex h-10 w-10 items-center justify-center rounded-full shrink-0",
                                    isSwap
                                        ? "bg-blue-500/10"
                                        : isReceived
                                            ? "bg-general-success-background-faded"
                                            : "bg-general-destructive-background-faded",
                                )}
                            >
                                {isSwap ? (
                                    <ArrowRightLeft className="h-5 w-5 text-blue-500" />
                                ) : isReceived ? (
                                    <ArrowDownToLine className="h-5 w-5 text-general-success-foreground" />
                                ) : (
                                    <ArrowUpToLine className="h-5 w-5 text-general-destructive-foreground" />
                                )}
                            </div>
                            <div className="min-w-0 flex-1 overflow-hidden">
                                <div className="font-semibold truncate">
                                    {activityType}
                                </div>
                                <div className="text-md text-muted-foreground font-medium">
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
                    const activity = row.original;
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
                        <div className="flex items-center justify-end gap-2 shrink-0">
                            <div className="text-right transition-all group-hover:pr-2 shrink-0">
                                <div
                                    className={cn(
                                        "whitespace-nowrap font-semibold",
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
                                <div className="text-sm text-muted-foreground whitespace-nowrap">
                                    <FormattedDate
                                        date={new Date(activity.blockTime)}
                                        includeTime
                                    />
                                </div>
                            </div>
                            <ChevronRight className="h-5 w-5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-all shrink-0" />
                        </div>
                    );
                },
            }),
        ],
        [treasuryId],
    );

    const table = useReactTable({
        data: activities,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getRowId: (row) => row.id.toString(),
    });

    return (
        <>
            <Card className="gap-3 border-none shadow-none">
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3 px-6">
                    <div className="space-y-1">
                        <CardTitle>Recent Transactions</CardTitle>
                        <CardDescription>
                            Sent and received transactions ({historyDescription})
                        </CardDescription>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2">
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
                        </div>
                        <MemberOnlyExportButton />
                    </div>
                </CardHeader>
                <CardContent className="px-2">
                    {isLoading && page === 0 ? (
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
                            <div className="w-full overflow-hidden px-6">
                                <Table className="table-fixed w-full">
                                    <colgroup>
                                        <col />
                                        <col className="w-52" />
                                    </colgroup>
                                    <TableBody>
                                        {table.getRowModel().rows.map((row) => (
                                            <TableRow
                                                key={row.id}
                                                className="group cursor-pointer"
                                                onClick={() => handleActivityClick(row.original)}
                                            >
                                                {row
                                                    .getVisibleCells()
                                                    .map((cell, idx) => (
                                                        <TableCell
                                                            key={cell.id}
                                                            className={cn(
                                                                "py-3",
                                                                idx === 0 ? "pl-2 overflow-hidden" : "pr-0 text-right"
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
                                        ))}
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
