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
import { ArrowDownToLine, ArrowUpToLine } from "lucide-react";
import { Pagination } from "@/components/pagination";
import { CopyButton } from "@/components/copy-button";
import { useTreasury } from "@/hooks/use-treasury";
import { FormattedDate } from "@/components/formatted-date";
import { TableSkeleton } from "@/components/table-skeleton";
import { EmptyState } from "@/components/empty-state";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { TokenAmountDisplay } from "@/components/token-display";

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

    const getTypeLabel = (amount: string) => {
        return parseFloat(amount) > 0 ? "Payment Received" : "Payment Send";
    };

    /**
     * Determines the sender of a transaction
     * For received payments: show the counterparty who sent funds
     * For sent payments: show the signer who initiated the transaction
     */
    const getFromAccount = (activity: RecentActivity, isReceived: boolean) => {
        if (isReceived && activity.counterparty) {
            return activity.counterparty;
        }
        return activity.signerId || "—";
    };

    /**
     * Determines the recipient of a transaction
     * For sent payments: show receiverId (primary), fallback to counterparty, then treasuryId
     * For received payments: show treasuryId (the treasury is always the recipient)
     */
    const getToAccount = (activity: RecentActivity, isReceived: boolean) => {
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
                                <TableHead>TRANSACTION</TableHead>
                                <TableHead>FROM</TableHead>
                                <TableHead>TO</TableHead>
                                <TableHead className="text-right pr-6">TRANSACTION</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {activities.map((activity) => {
                                const isReceived = parseFloat(activity.amount) > 0;
                                const typeLabel = getTypeLabel(activity.amount);

                                return (
                                    <TableRow
                                        key={activity.id}
                                    >
                                        <TableCell className="pl-6">
                                            <div className="flex items-center gap-3">
                                                <div
                                                    className={cn(
                                                        "flex h-10 w-10 items-center justify-center rounded-full shrink-0",
                                                        isReceived
                                                            ? "bg-general-success-background-faded"
                                                            : "bg-general-destructive-background-faded",
                                                    )}
                                                >
                                                    {isReceived ? (
                                                        <ArrowDownToLine className="h-5 w-5 text-general-success-foreground" />
                                                    ) : (
                                                        <ArrowUpToLine className="h-5 w-5 text-general-destructive-foreground" />
                                                    )}
                                                </div>
                                                <div className="flex flex-col gap-0.5">
                                                    <span className="text-sm font-medium">{typeLabel}</span>
                                                    <span className="text-xs text-muted-foreground">
                                                        <FormattedDate
                                                            date={new Date(activity.blockTime)}
                                                            includeTime
                                                        />
                                                    </span>
                                                </div>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <TokenAmountDisplay
                                                icon={activity.tokenMetadata.icon}
                                                symbol={activity.tokenMetadata.symbol}
                                                amount={formatAmount(activity.amount, activity.tokenMetadata.decimals)}
                                                className={isReceived ? "text-general-success-foreground" : "text-foreground"}
                                            />
                                        </TableCell>
                                        <TableCell>
                                            <span className="text-sm">
                                                {getFromAccount(activity, isReceived)}
                                            </span>
                                        </TableCell>
                                        <TableCell>
                                            <span className="text-sm">
                                                {getToAccount(activity, isReceived)}
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-right pr-6">
                                            {activity.transactionHashes.length > 0 && (
                                                <div className="flex items-center justify-end gap-2">
                                                    <a
                                                        href={`https://nearblocks.io/txns/${activity.transactionHashes[0]}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="text-sm underline hover:no-underline"
                                                    >
                                                        {activity.transactionHashes[0].slice(0, 12)}...
                                                    </a>
                                                    <CopyButton
                                                        text={activity.transactionHashes[0]}
                                                        toastMessage="Transaction hash copied"
                                                        className="h-6 w-6 p-0"
                                                        iconClassName="h-3 w-3"
                                                        variant="ghost"
                                                    />
                                                </div>
                                            )}
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

