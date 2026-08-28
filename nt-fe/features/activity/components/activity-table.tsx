"use client";

import {
    ArrowRight01Icon,
    Clock01Icon,
    HelpCircleIcon,
    LoaderCircleIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Address } from "@/components/address";
import { MaskedBalance } from "@/components/balance-mask";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { FormattedDate } from "@/components/formatted-date";
import { Icon } from "@/components/icon";
import { Pagination } from "@/components/pagination";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/table";
import { TokenDisplay } from "@/components/token-display-with-network";
import { SwapTokenPair } from "@/components/token-pair";
import { Tooltip } from "@/components/tooltip";
import { TooltipUser } from "@/components/user";
import { useTreasury } from "@/hooks/use-treasury";
import type { RecentActivity } from "@/lib/api";
import { cn, formatActivityAmount, formatSmartAmount } from "@/lib/utils";
import {
    getActivityStatus,
    getFromAccountId,
    getToAccount,
    getToAccountId,
    useGetActivityLabel,
    useGetActivitySubLabel,
    useGetFromAccount,
} from "../utils/history-utils";
import {
    ActivityRow,
    RowAmount,
    RowDate,
    RowStatus,
    SwapAmount,
} from "./activity-row";
import { ActivityGlyph, ActivityRowIcon } from "./activity-row-icon";
import {
    bodyCellClassName,
    CELL_PADDING,
    HASH_COLUMN_CLASS,
    HEAD_CLASS,
    TableSheet,
} from "./activity-table-layout";
import { ActivityTableSkeleton } from "./activity-table-skeleton";
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

/**
 * The whole row opens the details dialog, so a click that lands on a link or a
 * button inside it (the explorer link, copy, the details arrow) is left alone.
 */
function isInteractiveTarget(target: EventTarget | null) {
    return target instanceof HTMLElement && !!target.closest("a, button");
}

function SwapTransactionCell({
    swap,
}: {
    swap: NonNullable<RecentActivity["swap"]>;
}) {
    const sentSymbol = swap.sentTokenMetadata?.symbol;
    const receivedSymbol = swap.receivedTokenMetadata.symbol;
    // A fulfillment credits the treasury, so it keeps the incoming colour and
    // sign; a deposit is the leg the treasury pays for and stays neutral.
    const isIncoming = swap.swapRole === "fulfillment";

    return (
        <div className="flex items-center gap-2">
            <SwapTokenPair
                sent={swap.sentTokenMetadata}
                received={swap.receivedTokenMetadata}
            />
            <div className="flex min-w-0 flex-col">
                <span className="truncate text-xs font-medium tracking-[0.18px] text-muted-foreground">
                    {swap.sentAmount && sentSymbol ? (
                        <>
                            <MaskedBalance>
                                {formatSmartAmount(swap.sentAmount)}
                            </MaskedBalance>{" "}
                            {sentSymbol}
                        </>
                    ) : (
                        (sentSymbol ?? "?")
                    )}
                </span>
                <span
                    className={cn(
                        "truncate text-sm font-semibold",
                        isIncoming
                            ? "text-general-success-foreground"
                            : "text-general-foreground",
                    )}
                >
                    {swap.receivedAmount ? (
                        <>
                            {isIncoming ? "+" : ""}
                            <MaskedBalance>
                                {formatSmartAmount(swap.receivedAmount)}
                            </MaskedBalance>{" "}
                            {receivedSymbol}
                        </>
                    ) : (
                        receivedSymbol
                    )}
                </span>
            </div>
        </div>
    );
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
    const getActivitySubLabel = useGetActivitySubLabel();
    const getFromAccount = useGetFromAccount();
    const { treasuryId, isConfidential } = useTreasury();
    const [selectedActivity, setSelectedActivity] =
        useState<RecentActivity | null>(null);
    const [isModalOpen, setIsModalOpen] = useState(false);

    const totalPages = Math.ceil(total / pageSize);

    const openTransactionDetails = (activity: RecentActivity) => {
        setSelectedActivity(activity);
        setIsModalOpen(true);
    };

    if (isLoading) {
        return <ActivityTableSkeleton />;
    }

    if (activities.length === 0) {
        return (
            <>
                <div className="md:hidden">
                    <EmptyState
                        icon={Clock01Icon}
                        title={t("empty.title")}
                        description={t("empty.description")}
                    />
                </div>
                <div className="hidden md:block">
                    <TableSheet>
                        <div className="rounded-xl border border-general-border bg-card">
                            <EmptyState
                                icon={Clock01Icon}
                                title={t("empty.title")}
                                description={t("empty.description")}
                            />
                        </div>
                    </TableSheet>
                </div>
            </>
        );
    }

    return (
        <div className="space-y-2">
            {/* Mobile: the five columns collapse into a badge + two stacked lines. */}
            <div className="flex flex-col py-4 md:hidden">
                {activities.map((activity) => {
                    const status = getActivityStatus(activity);
                    const isReceived = parseFloat(activity.amount) > 0;

                    return (
                        <ActivityRow
                            key={activity.id}
                            icon={
                                <ActivityRowIcon>
                                    <ActivityGlyph activity={activity} />
                                </ActivityRowIcon>
                            }
                            label={getActivityLabel(activity)}
                            subLabel={getActivitySubLabel(activity, treasuryId)}
                            amount={
                                activity.swap ? (
                                    <SwapAmount swap={activity.swap} />
                                ) : (
                                    <RowAmount
                                        className={
                                            isReceived
                                                ? "text-general-success-foreground"
                                                : "text-general-foreground"
                                        }
                                    >
                                        {formatActivityAmount(activity.amount)}{" "}
                                        {activity.tokenMetadata?.symbol ??
                                            activity.tokenId}
                                    </RowAmount>
                                )
                            }
                            meta={
                                status ? (
                                    <RowStatus status={status} />
                                ) : (
                                    <RowDate
                                        date={activity.blockTime}
                                        relative={false}
                                    />
                                )
                            }
                            onClick={() => openTransactionDetails(activity)}
                        />
                    );
                })}
            </div>

            <div className="hidden md:block">
                <TableSheet>
                    <Table className="table-fixed border-separate border-spacing-0">
                        <TableHeader className="border-0 bg-transparent">
                            <TableRow className="border-0 hover:bg-transparent">
                                <TableHead
                                    className={cn(HEAD_CLASS, CELL_PADDING[0])}
                                >
                                    {t("table.type")}
                                </TableHead>
                                <TableHead
                                    className={cn(HEAD_CLASS, CELL_PADDING[1])}
                                >
                                    {t("table.transaction")}
                                </TableHead>
                                <TableHead
                                    className={cn(HEAD_CLASS, CELL_PADDING[2])}
                                >
                                    {t("table.from")}
                                </TableHead>
                                <TableHead
                                    className={cn(HEAD_CLASS, CELL_PADDING[3])}
                                >
                                    {t("table.to")}
                                </TableHead>
                                <TableHead
                                    className={cn(
                                        HEAD_CLASS,
                                        HASH_COLUMN_CLASS,
                                        CELL_PADDING[4],
                                    )}
                                >
                                    <span className="flex items-center justify-end gap-2">
                                        {t("table.transactionHash")}
                                        <Tooltip
                                            content={t("table.hashTooltip")}
                                        >
                                            <Icon
                                                icon={HelpCircleIcon}
                                                className="size-4 text-general-muted-foreground"
                                            />
                                        </Tooltip>
                                    </span>
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {activities.map((activity, index) => {
                                const isFirstRow = index === 0;
                                const isLastRow =
                                    index === activities.length - 1;
                                const isReceived =
                                    parseFloat(activity.amount) > 0;
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
                                    <TableRow
                                        key={activity.id}
                                        className="group cursor-pointer border-0 hover:bg-transparent"
                                        onClick={(event) => {
                                            if (
                                                isInteractiveTarget(
                                                    event.target,
                                                )
                                            )
                                                return;
                                            openTransactionDetails(activity);
                                        }}
                                    >
                                        <TableCell
                                            className={bodyCellClassName(
                                                0,
                                                isFirstRow,
                                                isLastRow,
                                            )}
                                        >
                                            <div className="flex items-center gap-2">
                                                <ActivityRowIcon>
                                                    <ActivityGlyph
                                                        activity={activity}
                                                    />
                                                </ActivityRowIcon>
                                                <div className="flex min-w-0 flex-1 flex-col">
                                                    <span className="truncate text-sm font-semibold text-general-foreground">
                                                        {getActivityLabel(
                                                            activity,
                                                        )}
                                                    </span>
                                                    {status === "pending" ? (
                                                        <span className="flex items-center gap-1 text-sm font-medium text-general-orange-foreground">
                                                            <Icon
                                                                icon={
                                                                    LoaderCircleIcon
                                                                }
                                                                className="size-3 animate-spin"
                                                            />
                                                            {t(
                                                                "table.processing",
                                                            )}
                                                        </span>
                                                    ) : (
                                                        <span className="truncate text-sm font-medium text-muted-foreground">
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
                                        <TableCell
                                            className={bodyCellClassName(
                                                1,
                                                isFirstRow,
                                                isLastRow,
                                            )}
                                        >
                                            {activity.swap ? (
                                                <SwapTransactionCell
                                                    swap={activity.swap}
                                                />
                                            ) : (
                                                <div className="flex items-center gap-2">
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
                                                        iconSize="xl"
                                                    />
                                                    <span
                                                        className={cn(
                                                            "truncate text-sm font-semibold",
                                                            isReceived
                                                                ? "text-general-success-foreground"
                                                                : "text-general-foreground",
                                                        )}
                                                    >
                                                        <MaskedBalance>
                                                            {formatActivityAmount(
                                                                activity.amount,
                                                            )}
                                                        </MaskedBalance>{" "}
                                                        {
                                                            activity
                                                                .tokenMetadata
                                                                .symbol
                                                        }
                                                    </span>
                                                </div>
                                            )}
                                        </TableCell>
                                        <TableCell
                                            className={bodyCellClassName(
                                                2,
                                                isFirstRow,
                                                isLastRow,
                                            )}
                                        >
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
                                                        className="w-fit min-w-0 max-w-full truncate text-sm font-semibold text-general-foreground"
                                                    />
                                                </TooltipUser>
                                            ) : (
                                                <Address
                                                    address={getFromAccount(
                                                        activity,
                                                        isReceived,
                                                        treasuryId,
                                                        isConfidential,
                                                    )}
                                                    className="min-w-0 truncate text-sm font-semibold text-general-foreground"
                                                />
                                            )}
                                        </TableCell>
                                        <TableCell
                                            className={bodyCellClassName(
                                                3,
                                                isFirstRow,
                                                isLastRow,
                                            )}
                                        >
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
                                                        className="w-fit min-w-0 max-w-full truncate text-sm font-semibold text-general-foreground"
                                                    />
                                                </TooltipUser>
                                            ) : (
                                                <Address
                                                    address={getToAccount(
                                                        activity,
                                                        isReceived,
                                                        treasuryId,
                                                        isConfidential,
                                                    )}
                                                    className="min-w-0 truncate text-sm font-semibold text-general-foreground"
                                                />
                                            )}
                                        </TableCell>
                                        <TableCell
                                            className={bodyCellClassName(
                                                4,
                                                isFirstRow,
                                                isLastRow,
                                            )}
                                        >
                                            <div className="flex items-center justify-end gap-1">
                                                <TransactionHashCell
                                                    transactionHashes={
                                                        activity.transactionHashes
                                                    }
                                                    receiptIds={
                                                        activity.receiptIds
                                                    }
                                                    chainName={
                                                        activity.tokenMetadata
                                                            ?.chainName
                                                    }
                                                />
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={t(
                                                        "details.title",
                                                    )}
                                                    className="size-9 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
                                                    onClick={() =>
                                                        openTransactionDetails(
                                                            activity,
                                                        )
                                                    }
                                                >
                                                    <Icon
                                                        icon={ArrowRight01Icon}
                                                    />
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </TableSheet>
            </div>

            {totalPages > 1 && (
                <Pagination
                    pageIndex={pageIndex}
                    totalPages={totalPages}
                    onPageChange={onPageChange}
                />
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
