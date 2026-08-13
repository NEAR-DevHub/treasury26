"use client";

import {
    ArrowDownToLine,
    ArrowRightLeft,
    ChevronRight,
    Clock,
    Info,
    Loader2,
    Minus,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { FormattedAmount } from "@/components/formatted-amount";
import { FormattedDate } from "@/components/formatted-date";
import { Pagination } from "@/components/pagination";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/table";
import { TableSkeleton } from "@/components/table-skeleton";
import { TokenDisplay } from "@/components/token-display-with-network";
import { Tooltip } from "@/components/tooltip";
import { User } from "@/components/user";
import { useTreasury } from "@/hooks/use-treasury";
import type { RecentActivity } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
    activityUnitPriceUsd,
    isPositiveActivityAmount,
    unitPriceUsdForAmount,
} from "../utils/activity-amount";
import {
    getActivityStatus,
    getFromAccountId,
    getToAccount,
    getToAccountId,
    useGetActivityLabel,
    useGetFromAccount,
} from "../utils/history-utils";
import { TransactionDetailsModal } from "./transaction-details-modal";
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
    const t = useTranslations("activity");
    const getActivityLabel = useGetActivityLabel();
    const getFromAccount = useGetFromAccount();
    const { treasuryId, isConfidential } = useTreasury();
    const [selectedActivity, setSelectedActivity] =
        useState<RecentActivity | null>(null);
    const [isModalOpen, setIsModalOpen] = useState(false);

    const totalPages = Math.ceil(total / pageSize);

    const getTypeLabel = (activity: RecentActivity) => {
        return getActivityLabel(activity);
    };

    const openTransactionDetails = (activity: RecentActivity) => {
        setSelectedActivity(activity);
        setIsModalOpen(true);
    };

    if (isLoading) {
        return <TableSkeleton rows={pageSize} columns={6} />;
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
                            <TableHead className="text-right pr-2 min-w-[120px] text-xs font-medium uppercase text-muted-foreground">
                                <div className="flex items-center justify-end gap-1">
                                    {t("table.transactionHash")}
                                    <Tooltip content={t("table.hashTooltip")}>
                                        <Info className="h-3.5 w-3.5 text-muted-foreground" />
                                    </Tooltip>
                                </div>
                            </TableHead>
                            <TableHead className="w-10 pr-4">
                                <span className="sr-only">
                                    {t("details.title")}
                                </span>
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {activities.map((activity) => {
                            const isSwap = !!activity.swap;
                            const isReceived = isPositiveActivityAmount(
                                activity.amount,
                            );
                            const typeLabel = getTypeLabel(activity);
                            const status = getActivityStatus(activity);
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
                                            <div className="flex h-8 w-8 items-center justify-center rounded-full shrink-0 bg-muted">
                                                {isSwap ? (
                                                    <ArrowRightLeft className="h-4 w-4" />
                                                ) : isReceived ? (
                                                    <ArrowDownToLine className="h-4 w-4" />
                                                ) : (
                                                    <Minus className="h-4 w-4" />
                                                )}
                                            </div>
                                            <div className="flex flex-col gap-0.5 min-w-0">
                                                <span className="text-sm font-medium truncate">
                                                    {typeLabel}
                                                </span>
                                                {status === "pending" ? (
                                                    <span className="inline-flex items-center gap-1 text-xs font-medium text-general-orange-foreground">
                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                        {t("table.processing")}
                                                    </span>
                                                ) : (
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
                                                )}
                                            </div>
                                        </div>
                                    </TableCell>
                                    <TableCell className="min-w-[180px]">
                                        {isSwap &&
                                        activity.swap &&
                                        activity.swap.swapRole === "deposit" ? (
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
                                                    <FormattedAmount
                                                        kind="token"
                                                        value={
                                                            activity.swap
                                                                .sentAmount
                                                        }
                                                        symbol={
                                                            activity.swap
                                                                .sentTokenMetadata
                                                                .symbol
                                                        }
                                                        tokenDecimals={
                                                            activity.swap
                                                                .sentTokenMetadata
                                                                .decimals
                                                        }
                                                        unitPriceUsd={unitPriceUsdForAmount(
                                                            activity.swap
                                                                .sentAmount,
                                                            activity.swap
                                                                .sentAmountUsd,
                                                            activity.swap
                                                                .sentTokenMetadata
                                                                .price,
                                                        )}
                                                        profile="compact"
                                                        className="font-normal text-foreground whitespace-nowrap"
                                                    />
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
                                                {activity.swap
                                                    .receivedAmount ? (
                                                    <FormattedAmount
                                                        kind="token"
                                                        value={
                                                            activity.swap
                                                                .receivedAmount
                                                        }
                                                        symbol={
                                                            activity.swap
                                                                .receivedTokenMetadata
                                                                .symbol
                                                        }
                                                        tokenDecimals={
                                                            activity.swap
                                                                .receivedTokenMetadata
                                                                .decimals
                                                        }
                                                        unitPriceUsd={unitPriceUsdForAmount(
                                                            activity.swap
                                                                .receivedAmount,
                                                            activity.swap
                                                                .receivedAmountUsd,
                                                            activity.swap
                                                                .receivedTokenMetadata
                                                                .price,
                                                        )}
                                                        profile="compact"
                                                        signDisplay="always"
                                                        className="font-normal text-general-success-foreground whitespace-nowrap"
                                                    />
                                                ) : (
                                                    <span className="font-normal text-general-success-foreground whitespace-nowrap">
                                                        {
                                                            activity.swap
                                                                .receivedTokenMetadata
                                                                .symbol
                                                        }
                                                    </span>
                                                )}
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-2">
                                                {(activity.tokenMetadata.icon ||
                                                    activity.tokenMetadata
                                                        .chainIcons) && (
                                                    <TokenDisplay
                                                        symbol={
                                                            activity
                                                                .tokenMetadata
                                                                .symbol
                                                        }
                                                        icon={
                                                            activity
                                                                .tokenMetadata
                                                                .icon || ""
                                                        }
                                                        chainIcons={
                                                            activity
                                                                .tokenMetadata
                                                                .chainIcons
                                                        }
                                                        iconSize="lg"
                                                    />
                                                )}
                                                <FormattedAmount
                                                    kind="token"
                                                    value={activity.amount}
                                                    symbol={
                                                        activity.tokenMetadata
                                                            .symbol
                                                    }
                                                    tokenDecimals={
                                                        activity.tokenMetadata
                                                            .decimals
                                                    }
                                                    unitPriceUsd={activityUnitPriceUsd(
                                                        activity,
                                                    )}
                                                    profile="compact"
                                                    signDisplay="always"
                                                    className={cn(
                                                        "font-normal",
                                                        isReceived
                                                            ? "text-general-success-foreground"
                                                            : "text-foreground",
                                                    )}
                                                />
                                            </div>
                                        )}
                                    </TableCell>
                                    <TableCell className="min-w-[150px] max-w-[200px]">
                                        {fromId ? (
                                            <User
                                                accountId={fromId}
                                                variant="details"
                                                withLink={false}
                                                withHoverCard
                                                chainName={
                                                    activity.tokenMetadata
                                                        ?.chainName
                                                }
                                            />
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
                                            <User
                                                accountId={toId}
                                                variant="details"
                                                withLink={false}
                                                withHoverCard
                                                chainName={
                                                    activity.tokenMetadata
                                                        ?.chainName
                                                }
                                            />
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
                                    <TableCell className="text-right pr-2">
                                        <TransactionHashCell
                                            transactionHashes={
                                                activity.transactionHashes
                                            }
                                            receiptIds={activity.receiptIds}
                                            chainName={
                                                activity.tokenMetadata
                                                    ?.chainName
                                            }
                                            depositAddress={
                                                activity.quoteDepositAddress
                                            }
                                            isConfidential={isConfidential}
                                        />
                                    </TableCell>
                                    <TableCell className="w-10 px-0 pr-4 text-right">
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={t("details.title")}
                                            className="size-8 p-0 text-muted-foreground hover:text-foreground"
                                            onClick={() =>
                                                openTransactionDetails(activity)
                                            }
                                        >
                                            <ChevronRight className="size-4" />
                                        </Button>
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

            <TransactionDetailsModal
                activity={selectedActivity}
                treasuryId={treasuryId || ""}
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
            />
        </div>
    );
}
