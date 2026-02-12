"use client";

import type { RecentActivity } from "@/lib/api";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/table";
import { ArrowDownToLine, ArrowUpToLine, ArrowRightLeft, ArrowRight } from "lucide-react";
import { Pagination } from "@/components/pagination";
import { useTreasury } from "@/hooks/use-treasury";
import { FormattedDate } from "@/components/formatted-date";
import { TableSkeleton } from "@/components/table-skeleton";
import { EmptyState } from "@/components/empty-state";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { TokenAmountDisplay } from "@/components/token-display";
import { TransactionHashCell } from "./transaction-hash-cell";

interface ActivityTableProps {
    activities: RecentActivity[];
    isLoading: boolean;
    pageIndex: number;
    pageSize: number;
    total: number;
    onPageChange: (page: number) => void;
}

export function ActivityTable({
    activities,
    isLoading,
    pageIndex,
    pageSize,
    total,
    onPageChange,
}: ActivityTableProps) {
    const { treasuryId } = useTreasury();

    const totalPages = Math.ceil(total / pageSize);

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

    const getTypeLabel = (activity: RecentActivity) => {
        if (activity.swap) return "Swap";
        const isReceived = parseFloat(activity.amount) > 0;
        return isReceived ? "Payment Received" : "Payment Send";
    };

    /**
     * Determines the sender of a transaction
     * For swaps: show "via NEAR Intents"
     * For received payments: show the counterparty who sent funds
     * For sent payments: show the signer who initiated the transaction
     */
    const getFromAccount = (activity: RecentActivity, isReceived: boolean) => {
        if (activity.swap) return "via NEAR Intents";
        if (isReceived && activity.counterparty) {
            return activity.counterparty;
        }
        return activity.signerId || "—";
    };

    /**
     * Determines the recipient of a transaction
     * For swaps: show treasury (swaps are always treasury operations)
     * For sent payments: show receiverId (primary), fallback to counterparty, then treasuryId
     * For received payments: show treasuryId (the treasury is always the recipient)
     */
    const getToAccount = (activity: RecentActivity, isReceived: boolean) => {
        if (activity.swap) return treasuryId || "—";
        if (!isReceived) {
            return activity.receiverId || activity.counterparty || treasuryId || "—";
        }
        return treasuryId || "—";
    };


    if (isLoading) {
        return <TableSkeleton rows={pageSize} columns={5} />;
    }

    if (activities.length === 0) {
        return (
            <EmptyState
                icon={Clock}
                title="No transactions found"
                description="Your transactions will appear here once they happen"
            />
        );
    }

    return (
        <>
            <div className="space-y-4">
                <div className="rounded-md border">
                    <Table>
                        <TableHeader>
                            <TableRow className="hover:bg-transparent">
                                <TableHead className="w-[120px] pl-6">TYPE</TableHead>
                                <TableHead className="min-w-[180px]">TRANSACTION</TableHead>
                                <TableHead className="min-w-[150px]">FROM</TableHead>
                                <TableHead className="min-w-[150px]">TO</TableHead>
                                <TableHead className="text-right pr-6 min-w-[120px]">TRANSACTION</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {activities.map((activity) => {
                                const isSwap = !!activity.swap;
                                const isReceived = parseFloat(activity.amount) > 0;
                                const typeLabel = getTypeLabel(activity);

                                return (
                                    <TableRow
                                        key={activity.id}
                                    >
                                        <TableCell className="pl-6">
                                            <div className="flex items-center gap-3">
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
                                                <div className="flex flex-col gap-0.5 min-w-0">
                                                    <span className="text-sm font-medium truncate">{typeLabel}</span>
                                                    <span className="text-xs text-muted-foreground whitespace-normal wrap-break-word md:whitespace-nowrap">
                                                        <FormattedDate
                                                            date={new Date(activity.blockTime)}
                                                            includeTime
                                                        />
                                                    </span>
                                                </div>
                                            </div>
                                        </TableCell>
                                        <TableCell className="min-w-[180px]">
                                            {isSwap && activity.swap ? (
                                                <div className="flex items-center gap-1.5">
                                                    {activity.swap.sentAmount && activity.swap.sentTokenMetadata ? (
                                                        <span className="font-semibold text-general-destructive-foreground whitespace-nowrap">
                                                            {formatSwapAmount(
                                                                activity.swap.sentAmount,
                                                                activity.swap.sentTokenMetadata.decimals,
                                                            )}{" "}
                                                            {activity.swap.sentTokenMetadata.symbol}
                                                        </span>
                                                    ) : (
                                                        <span className="font-semibold text-muted-foreground">?</span>
                                                    )}
                                                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                                    <span className="font-semibold text-general-success-foreground whitespace-nowrap">
                                                        {formatSwapAmount(
                                                            activity.swap.receivedAmount,
                                                            activity.swap.receivedTokenMetadata.decimals,
                                                        )}{" "}
                                                        {activity.swap.receivedTokenMetadata.symbol}
                                                    </span>
                                                </div>
                                            ) : (
                                                <TokenAmountDisplay
                                                    icon={activity.tokenMetadata.icon}
                                                    symbol={activity.tokenMetadata.symbol}
                                                    amount={formatAmount(activity.amount, activity.tokenMetadata.decimals)}
                                                    className={isReceived ? "text-general-success-foreground" : "text-foreground"}
                                                />
                                            )}
                                        </TableCell>
                                        <TableCell className="min-w-[150px] max-w-[200px]">
                                            <span className="text-sm truncate block">
                                                {getFromAccount(activity, isReceived)}
                                            </span>
                                        </TableCell>
                                        <TableCell className="min-w-[150px] max-w-[200px]">
                                            <span className="text-sm truncate block">
                                                {getToAccount(activity, isReceived)}
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-right pr-6">
                                            <TransactionHashCell
                                                transactionHashes={activity.transactionHashes}
                                                receiptIds={activity.receiptIds}
                                            />
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                    <div className="pb-4">
                        <Pagination
                            pageIndex={pageIndex}
                            totalPages={totalPages}
                            onPageChange={onPageChange}
                        />
                    </div>
                )}
            </div>
        </>
    );
}

