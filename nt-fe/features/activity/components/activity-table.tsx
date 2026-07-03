"use client";

import { useTranslations } from "next-intl";
import type { RecentActivity } from "@/lib/api";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/table";
import {
    ArrowDownToLine,
    ArrowUpToLine,
    ArrowRightLeft,
    ChevronRight,
    Info,
} from "lucide-react";
import { Pagination } from "@/components/pagination";
import { useTreasury } from "@/hooks/use-treasury";
import { FormattedDate } from "@/components/formatted-date";
import { TableSkeleton } from "@/components/table-skeleton";
import { EmptyState } from "@/components/empty-state";
import { Clock } from "lucide-react";
import { cn, formatActivityAmount, formatSmartAmount } from "@/lib/utils";
import { TokenAmountDisplay } from "@/components/token-display";
import { TransactionHashCell } from "./transaction-hash-cell";
import {
    useGetActivityLabel,
    useGetFromAccount,
    getToAccount,
    getFromAccountId,
    getToAccountId,
} from "../utils/history-utils";
import { TokenDisplay } from "@/components/token-display-with-network";
import { Tooltip } from "@/components/tooltip";
import { TooltipUser } from "@/components/user";
import { Address } from "@/components/address";

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
    const t = useTranslations("activity");
    const getActivityLabel = useGetActivityLabel();
    const getFromAccount = useGetFromAccount();
    const { treasuryId, isConfidential } = useTreasury();

    const totalPages = Math.ceil(total / pageSize);

    const getTypeLabel = (activity: RecentActivity) => {
        return getActivityLabel({
            ...activity,
            tokenSymbol: activity.tokenMetadata?.symbol,
        });
    };

    if (isLoading) {
        return <TableSkeleton rows={pageSize} columns={5} />;
    }

    if (activities.length === 0) {
        return (
            <EmptyState
                icon={Clock}
                title={t("empty.title")}
                description={t("empty.description")}
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
                                <TableHead className="w-[120px] pl-6 text-xs font-medium uppercase text-muted-foreground">
                                    {t("table.type")}
                                </TableHead>
                                <TableHead className="min-w-[180px] text-xs font-medium uppercase text-muted-foreground">
                                    {t("table.transaction")}
                                </TableHead>
                                <TableHead className="min-w-[150px] text-xs font-medium uppercase text-muted-foreground">
                                    {t("table.from")}
                                </TableHead>
                                <TableHead className="min-w-[150px] text-xs font-medium uppercase text-muted-foreground">
                                    {t("table.to")}
                                </TableHead>
                                <TableHead className="text-right pr-6 min-w-[120px] text-xs font-medium uppercase text-muted-foreground">
                                    <div className="flex items-center justify-end gap-1">
                                        {t("table.transactionHash")}
                                        <Tooltip
                                            content={t("table.hashTooltip")}
                                        >
                                            <Info className="h-3.5 w-3.5 text-muted-foreground" />
                                        </Tooltip>
                                    </div>
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {activities.map((activity) => {
                                const isSwap = !!activity.swap;
                                const isReceived =
                                    parseFloat(activity.amount) > 0;
                                const typeLabel = getTypeLabel(activity);
                                const fromId = getFromAccountId(
                                    activity,
                                    isReceived,
                                    treasuryId,
                                );
                                const toId = getToAccountId(
                                    activity,
                                    isReceived,
                                    treasuryId,
                                );

                                return (
                                    <TableRow key={activity.id}>
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
                                                    <span className="text-sm font-medium truncate">
                                                        {typeLabel}
                                                    </span>
                                                    <span className="text-xs text-muted-foreground whitespace-normal wrap-break-word md:whitespace-nowrap">
                                                        <FormattedDate
                                                            date={
                                                                new Date(
                                                                    activity.blockTime,
                                                                )
                                                            }
                                                            includeTime
                                                        />
                                                    </span>
                                                </div>
                                            </div>
                                        </TableCell>
                                        <TableCell className="min-w-[180px]">
                                            {isSwap &&
                                            activity.swap &&
                                            activity.swap.swapRole ===
                                                "deposit" ? (
                                                <div className="flex items-center gap-1.5">
                                                    {/* Sent token icon */}
                                                    {activity.swap
                                                        .sentTokenMetadata && (
                                                        <TokenDisplay
                                                            symbol={
                                                                activity.swap
                                                                    .sentTokenMetadata
                                                                    .symbol
                                                            }
                                                            icon={
                                                                activity.swap
                                                                    .sentTokenMetadata
                                                                    .icon || ""
                                                            }
                                                            chainIcons={
                                                                activity.swap
                                                                    .sentTokenMetadata
                                                                    .chainIcons
                                                            }
                                                            iconSize="sm"
                                                        />
                                                    )}
                                                    {/* Sent amount */}
                                                    {activity.swap.sentAmount &&
                                                    activity.swap
                                                        .sentTokenMetadata ? (
                                                        <span className="font-normal text-foreground whitespace-nowrap">
                                                            {formatSmartAmount(
                                                                activity.swap
                                                                    .sentAmount,
                                                            )}{" "}
                                                            {
                                                                activity.swap
                                                                    .sentTokenMetadata
                                                                    .symbol
                                                            }
                                                        </span>
                                                    ) : (
                                                        <span className="font-normal text-muted-foreground">
                                                            ?
                                                        </span>
                                                    )}
                                                    {/* Arrow */}
                                                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                                    {/* Received token icon */}
                                                    <TokenDisplay
                                                        symbol={
                                                            activity.swap
                                                                .receivedTokenMetadata
                                                                .symbol
                                                        }
                                                        icon={
                                                            activity.swap
                                                                .receivedTokenMetadata
                                                                .icon || ""
                                                        }
                                                        chainIcons={
                                                            activity.swap
                                                                .receivedTokenMetadata
                                                                .chainIcons
                                                        }
                                                        iconSize="sm"
                                                    />
                                                    {/* Received amount with + sign */}
                                                    <span className="font-normal text-general-success-foreground whitespace-nowrap">
                                                        {
                                                            activity.swap
                                                                .receivedTokenMetadata
                                                                .symbol
                                                        }
                                                    </span>
                                                </div>
                                            ) : isSwap &&
                                              activity.swap &&
                                              activity.swap.swapRole ===
                                                  "fulfillment" ? (
                                                <div className="flex items-center gap-1.5">
                                                    {/* Sent token icon */}
                                                    {activity.swap
                                                        .sentTokenMetadata && (
                                                        <TokenDisplay
                                                            symbol={
                                                                activity.swap
                                                                    .sentTokenMetadata
                                                                    .symbol
                                                            }
                                                            icon={
                                                                activity.swap
                                                                    .sentTokenMetadata
                                                                    .icon || ""
                                                            }
                                                            chainIcons={
                                                                activity.swap
                                                                    .sentTokenMetadata
                                                                    .chainIcons
                                                            }
                                                            iconSize="sm"
                                                        />
                                                    )}
                                                    {/* Sent amount */}
                                                    {activity.swap
                                                        .sentTokenMetadata ? (
                                                        <span className="font-normal text-foreground whitespace-nowrap">
                                                            {
                                                                activity.swap
                                                                    .sentTokenMetadata
                                                                    .symbol
                                                            }
                                                        </span>
                                                    ) : null}
                                                    {/* Arrow */}
                                                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                                    {/* Received token icon */}
                                                    <TokenDisplay
                                                        symbol={
                                                            activity.swap
                                                                .receivedTokenMetadata
                                                                .symbol
                                                        }
                                                        icon={
                                                            activity.swap
                                                                .receivedTokenMetadata
                                                                .icon || ""
                                                        }
                                                        chainIcons={
                                                            activity.swap
                                                                .receivedTokenMetadata
                                                                .chainIcons
                                                        }
                                                        iconSize="sm"
                                                    />
                                                    {/* Received amount with + sign */}
                                                    <span className="font-normal text-general-success-foreground whitespace-nowrap">
                                                        {activity.swap
                                                            .receivedAmount
                                                            ? `+${formatSmartAmount(activity.swap.receivedAmount)} `
                                                            : ""}
                                                        {
                                                            activity.swap
                                                                .receivedTokenMetadata
                                                                .symbol
                                                        }
                                                    </span>
                                                </div>
                                            ) : (
                                                <TokenAmountDisplay
                                                    icon={
                                                        activity.tokenMetadata
                                                            .icon
                                                    }
                                                    chainIcons={
                                                        activity.tokenMetadata
                                                            .chainIcons
                                                    }
                                                    symbol={
                                                        activity.tokenMetadata
                                                            .symbol
                                                    }
                                                    amount={formatActivityAmount(
                                                        activity.amount,
                                                    )}
                                                    className={cn(
                                                        "font-normal",
                                                        isReceived
                                                            ? "text-general-success-foreground"
                                                            : "text-foreground",
                                                    )}
                                                />
                                            )}
                                        </TableCell>
                                        <TableCell className="min-w-[150px] max-w-[200px]">
                                            {fromId ? (
                                                <TooltipUser
                                                    accountId={fromId}
                                                    chainName={
                                                        activity.tokenMetadata
                                                            ?.chainName
                                                    }
                                                >
                                                    <Address
                                                        address={fromId}
                                                        className="text-sm"
                                                    />
                                                </TooltipUser>
                                            ) : (
                                                <span className="text-sm truncate block">
                                                    {getFromAccount(
                                                        activity,
                                                        isReceived,
                                                        treasuryId,
                                                        isConfidential,
                                                    )}
                                                </span>
                                            )}
                                        </TableCell>
                                        <TableCell className="min-w-[150px] max-w-[200px]">
                                            {toId ? (
                                                <TooltipUser
                                                    accountId={toId}
                                                    chainName={
                                                        activity.tokenMetadata
                                                            ?.chainName
                                                    }
                                                >
                                                    <Address
                                                        address={toId}
                                                        className="text-sm"
                                                    />
                                                </TooltipUser>
                                            ) : (
                                                <span className="text-sm truncate block">
                                                    {getToAccount(
                                                        activity,
                                                        isReceived,
                                                        treasuryId,
                                                        isConfidential,
                                                    )}
                                                </span>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right pr-6">
                                            <TransactionHashCell
                                                transactionHashes={
                                                    activity.transactionHashes
                                                }
                                                receiptIds={activity.receiptIds}
                                                chainName={
                                                    activity.tokenMetadata
                                                        ?.chainName
                                                }
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
                    <div className="pb-4 pr-4">
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
