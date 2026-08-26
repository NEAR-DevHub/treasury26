"use client";

import {
    ArrowRight01Icon,
    Clock01Icon,
    HelpCircleIcon,
    LoaderCircleIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
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
import { TableSkeleton } from "@/components/table-skeleton";
import { TokenDisplay } from "@/components/token-display-with-network";
import { Tooltip } from "@/components/tooltip";
import { TooltipUser } from "@/components/user";
import { useTreasury } from "@/hooks/use-treasury";
import type { RecentActivity, TokenMetadataInfo } from "@/lib/api";
import { cn, formatActivityAmount, formatSmartAmount } from "@/lib/utils";
import {
    getActivityStatus,
    getFromAccountId,
    getToAccount,
    getToAccountId,
    useGetActivityLabel,
    useGetFromAccount,
} from "../utils/history-utils";
import { ActivityGlyph, ActivityRowIcon } from "./activity-row-icon";
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

/** Shared geometry for the five columns, applied to header and body alike. */
const CELL_PADDING = [
    "px-6",
    "px-4",
    "px-3",
    "px-3",
    "px-3 text-right",
] as const;

const HEAD_CLASS = "h-10 text-sm font-semibold normal-case leading-[1.5]";

/**
 * The table paints a white sheet floating on the card's tertiary surface: the
 * header sits on the surface itself while the rows form a rounded, bordered
 * block. `border-separate` keeps that block's corners round — with collapsed
 * borders the radius on the outer cells would be dropped.
 */
function bodyCellClassName(
    columnIndex: number,
    isFirstRow: boolean,
    isLastRow: boolean,
) {
    return cn(
        "h-[66px] bg-card border-b border-general-border align-middle transition-colors group-hover:bg-general-tertiary",
        CELL_PADDING[columnIndex],
        isFirstRow && "border-t",
        columnIndex === 0 && "border-l",
        columnIndex === CELL_PADDING.length - 1 && "border-r",
        isFirstRow && columnIndex === 0 && "rounded-tl-xl",
        isFirstRow &&
            columnIndex === CELL_PADDING.length - 1 &&
            "rounded-tr-xl",
        isLastRow && columnIndex === 0 && "rounded-bl-xl",
        isLastRow && columnIndex === CELL_PADDING.length - 1 && "rounded-br-xl",
    );
}

/** The tertiary frame the white row sheet floats inside. */
function TableSheet({ children }: { children: ReactNode }) {
    return (
        <div className="rounded-2xl border border-general-border bg-general-tertiary p-1">
            {children}
        </div>
    );
}

/** Token glyph sized for the overlapping swap pair, which needs 20/28px. */
function TokenGlyph({
    token,
    className,
}: {
    token: TokenMetadataInfo;
    className?: string;
}) {
    const icon = token.icon;
    const isImageIcon =
        !!icon && (icon.startsWith("data:image") || icon.startsWith("http"));

    return isImageIcon ? (
        <img
            src={icon}
            alt={token.symbol}
            className={cn("shrink-0 rounded-full", className)}
        />
    ) : (
        <div
            className={cn(
                "flex shrink-0 items-center justify-center rounded-full bg-brand-blue text-white text-xs font-normal",
                className,
            )}
        >
            {token.symbol.charAt(0).toUpperCase()}
        </div>
    );
}

/** Sent token tucked behind the received one, matching the 36px row badge. */
function SwapTokenPair({
    sent,
    received,
}: {
    sent?: TokenMetadataInfo;
    received: TokenMetadataInfo;
}) {
    return (
        <div className="relative size-9 shrink-0">
            {sent && (
                <TokenGlyph
                    token={sent}
                    className="absolute left-0 top-0 size-5"
                />
            )}
            <TokenGlyph
                token={received}
                className="absolute bottom-0 right-0 size-7 border border-card bg-card"
            />
        </div>
    );
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
        return (
            <TableSkeleton
                rows={pageSize}
                columns={5}
                className="rounded-2xl border-general-border"
            />
        );
    }

    if (activities.length === 0) {
        return (
            <TableSheet>
                <div className="rounded-xl border border-general-border bg-card">
                    <EmptyState
                        icon={Clock01Icon}
                        title={t("empty.title")}
                        description={t("empty.description")}
                    />
                </div>
            </TableSheet>
        );
    }

    return (
        <div className="space-y-2">
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
                                    "w-[278px]",
                                    CELL_PADDING[4],
                                )}
                            >
                                <span className="flex items-center justify-end gap-2">
                                    {t("table.transactionHash")}
                                    <Tooltip content={t("table.hashTooltip")}>
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
                            const isLastRow = index === activities.length - 1;
                            const isReceived = parseFloat(activity.amount) > 0;
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
                                    className="group border-0 hover:bg-transparent"
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
                                                    {getActivityLabel(activity)}
                                                </span>
                                                {status === "pending" ? (
                                                    <span className="flex items-center gap-1 text-sm font-medium text-general-orange-foreground">
                                                        <Icon
                                                            icon={
                                                                LoaderCircleIcon
                                                            }
                                                            className="size-3 animate-spin"
                                                        />
                                                        {t("table.processing")}
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
                                                        activity.tokenMetadata
                                                            .symbol
                                                    }
                                                    icon={
                                                        activity.tokenMetadata
                                                            .icon || ""
                                                    }
                                                    chainIcons={
                                                        activity.tokenMetadata
                                                            .chainIcons
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
                                                        activity.tokenMetadata
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
                                                    className="min-w-0 truncate text-sm font-semibold text-general-foreground"
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
                                                    className="min-w-0 truncate text-sm font-semibold text-general-foreground"
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
                                                receiptIds={activity.receiptIds}
                                                chainName={
                                                    activity.tokenMetadata
                                                        ?.chainName
                                                }
                                            />
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                aria-label={t("details.title")}
                                                className="size-9 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
                                                onClick={() =>
                                                    openTransactionDetails(
                                                        activity,
                                                    )
                                                }
                                            >
                                                <Icon icon={ArrowRight01Icon} />
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </TableSheet>

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
