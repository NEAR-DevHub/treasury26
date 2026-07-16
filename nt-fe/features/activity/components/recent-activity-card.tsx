"use client";

import {
    AlertTriangle,
    ArrowDownToLine,
    ArrowRight,
    ArrowRightLeft,
    ArrowUpToLine,
    ChevronRight,
    Clock,
    Shield,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSubscription } from "@/hooks/use-subscription";
import { useTreasury } from "@/hooks/use-treasury";
import { useRecentActivity } from "@/hooks/use-treasury-queries";
import type { RecentActivity as RecentActivityType } from "@/lib/api";
import { cn, formatActivityAmount, formatSmartAmount } from "@/lib/utils";
import {
    useFormatHistoryDuration,
    useGetActivityLabel,
    useGetActivitySubLabel,
} from "../utils/history-utils";

type GroupedActivity =
    | {
          type: "single";
          activity: RecentActivityType;
      }
    | {
          type: "grouped";
          pool: string;
          activities: RecentActivityType[];
          totalAmount: string;
          tokenMetadata: RecentActivityType["tokenMetadata"];
          blockTime: string; // Most recent time
      };

import {
    type ColumnDef,
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    useReactTable,
} from "@tanstack/react-table";
import Link from "next/link";
import { ConfidentialState } from "@/components/confidential-state";
import { ExportButton } from "@/components/export-button";
import { FormattedDate } from "@/components/formatted-date";
import { StepperHeader } from "@/components/step-wizard";
import { Table, TableBody, TableCell, TableRow } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { parseWarningCopy } from "@/components/warning-message";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useWarningMessage, useWarnings } from "@/hooks/use-warnings";
import { useIsHistoryRefreshing } from "./history-refresh-indicator";
import { TransactionDetailsModal } from "./transaction-details-modal";

const ITEMS_ON_DASHBOARD = 10;
const MAX_ITEMS = 100;

const columnHelper = createColumnHelper<GroupedActivity>();

// Helper function to detect if an activity is a staking reward
const isStakingReward = (activity: RecentActivityType): boolean => {
    // Must be NEAR token with positive amount
    if (
        activity.tokenId !== NEAR_NETWORK_ID ||
        parseFloat(activity.amount) <= 0
    ) {
        return false;
    }

    // Must have a counterparty that looks like a staking pool
    if (!activity.counterparty) {
        return false;
    }

    const counterparty = activity.counterparty.toLowerCase();
    // Check if it's a staking pool (ends with pool variants or contains 'pool')
    return (
        counterparty.endsWith(".poolv1.near") ||
        counterparty.endsWith(".pool.near")
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

export function RecentActivitySkeleton() {
    return (
        <div className="space-y-4 px-4 py-2">
            {[...Array(6)].map((_, i) => (
                <div
                    key={i}
                    className="grid grid-cols-[1fr_auto] items-center gap-6 border-b border-border pb-3 last:border-b-0"
                >
                    <div className="flex items-center gap-3 min-w-0">
                        <Skeleton className="h-10 w-10 rounded-full shrink-0 bg-general-unofficial-accent-0" />
                        <div className="space-y-2 min-w-0 flex-1">
                            <Skeleton className="h-6 w-[min(420px,100%)] bg-general-unofficial-accent-0" />
                            <Skeleton className="h-4 w-[min(420px,100%)] bg-general-unofficial-accent-0" />
                        </div>
                    </div>
                    <div className="text-right space-y-2">
                        <Skeleton className="h-6 w-36 bg-general-unofficial-accent-0" />
                        <Skeleton className="h-4 w-36 ml-auto bg-general-unofficial-accent-0" />
                    </div>
                </div>
            ))}
        </div>
    );
}

function RecentActivityUnavailableOverlay({
    heading,
    body,
}: {
    heading: string | null;
    body: string;
}) {
    return (
        <div className="relative min-h-[28rem]">
            <RecentActivitySkeleton />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 py-8">
                <div className="pointer-events-auto flex max-w-lg flex-col items-center gap-3 text-center">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-general-orange-background">
                        <AlertTriangle className="size-5 text-general-orange-foreground" />
                    </div>
                    <div>
                        {heading && (
                            <p className="text-base font-semibold text-foreground">
                                {heading}
                            </p>
                        )}
                        {body && (
                            <p className="text-sm text-muted-foreground">
                                {body}
                            </p>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export function RecentActivity() {
    const t = useTranslations("activity");
    const tCommon = useTranslations("common");
    const getActivityLabel = useGetActivityLabel();
    const getActivitySubLabel = useGetActivitySubLabel();
    const formatHistoryDuration = useFormatHistoryDuration();
    const { treasuryId, isConfidential, isGuestTreasury } = useTreasury();
    const [hideSmallTransactions, setHideSmallTransactions] = useState(false);
    const [selectedActivity, setSelectedActivity] =
        useState<RecentActivityType | null>(null);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
        new Set(),
    );
    const isMobile = useMediaQuery("(max-width: 640px)");
    const isHistoryRefreshing = useIsHistoryRefreshing();
    const isHidden = isConfidential && isGuestTreasury;
    const showConfidentialShield = isConfidential && !isGuestTreasury;
    const { getWarning } = useWarnings();
    const activityWarning = getWarning("data.activity");
    const activityWarningMessage = useWarningMessage(
        activityWarning,
        "data.activity",
    );
    const activityWarningCopy = useMemo(
        () => parseWarningCopy(activityWarningMessage),
        [activityWarningMessage],
    );
    const showActivityUnavailable =
        Boolean(activityWarningMessage) && !isHidden;
    const { data: response, isLoading } = useRecentActivity(
        treasuryId,
        MAX_ITEMS,
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

    const getActivityType = (activity: RecentActivityType) => {
        return getActivityLabel({
            ...activity,
            tokenSymbol: activity.tokenMetadata?.symbol,
        });
    };

    const getActivityFrom = (activity: RecentActivityType) => {
        return getActivitySubLabel(
            {
                ...activity,
                tokenSymbol: activity.tokenMetadata?.symbol,
            },
            treasuryId,
        );
    };

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
                                        {t("tabs.stakingRewards")}
                                    </div>
                                    <div className="text-xs sm:text-sm text-muted-foreground font-medium truncate">
                                        {t("fromPool", {
                                            pool: grouped.pool,
                                        })}
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
                            <div className="flex items-center justify-end min-w-0">
                                <div className="flex flex-col items-end gap-0.5 min-w-0 flex-1">
                                    <div className="text-sm sm:text-base font-semibold text-general-success-foreground truncate w-full text-right">
                                        {formatActivityAmount(
                                            grouped.totalAmount,
                                        )}{" "}
                                        {grouped.tokenMetadata?.symbol ??
                                            grouped.activities[0]?.tokenId}
                                    </div>
                                    <div className="text-xs sm:text-sm text-muted-foreground whitespace-nowrap">
                                        <FormattedDate
                                            date={new Date(grouped.blockTime)}
                                            relative
                                        />
                                    </div>
                                </div>
                                <div
                                    className={cn(
                                        "overflow-hidden transition-all shrink-0",
                                        isExpanded
                                            ? "w-6 ml-2"
                                            : "w-0 group-hover:w-6 group-hover:ml-1",
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
                        const isDeposit = swap.swapRole === "deposit";
                        const sentSymbol =
                            swap.sentTokenMetadata?.symbol ?? null;
                        const receivedSymbol =
                            swap.receivedTokenMetadata?.symbol ??
                            swap.receivedTokenId;
                        return (
                            <div className="flex flex-col items-end">
                                <div className="flex items-center justify-end gap-1.5 truncate">
                                    {isDeposit ? (
                                        <>
                                            {swap.sentAmount &&
                                            swap.sentTokenMetadata ? (
                                                <span className="font-semibold text-foreground hidden sm:inline truncate">
                                                    {formatSmartAmount(
                                                        swap.sentAmount,
                                                    )}{" "}
                                                    {sentSymbol}
                                                </span>
                                            ) : (
                                                <span className="font-semibold text-muted-foreground hidden sm:inline">
                                                    ?
                                                </span>
                                            )}
                                            <span className="font-semibold text-foreground sm:hidden">
                                                {sentSymbol ?? "?"}
                                            </span>
                                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                            <span className="font-semibold text-general-success-foreground truncate">
                                                {receivedSymbol}
                                            </span>
                                            {swap.receivedAmount == null ? (
                                                <span className="text-xs font-medium text-muted-foreground shrink-0">
                                                    pending
                                                </span>
                                            ) : null}
                                        </>
                                    ) : (
                                        <>
                                            {sentSymbol ? (
                                                <span className="font-semibold text-foreground truncate">
                                                    {sentSymbol}
                                                </span>
                                            ) : null}
                                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                            <span className="font-semibold text-general-success-foreground hidden sm:inline truncate">
                                                +
                                                {swap.receivedAmount
                                                    ? formatSmartAmount(
                                                          swap.receivedAmount,
                                                      )
                                                    : ""}{" "}
                                                {receivedSymbol}
                                            </span>
                                            <span className="font-semibold text-general-success-foreground sm:hidden truncate">
                                                {receivedSymbol}
                                            </span>
                                        </>
                                    )}
                                </div>
                                <div className="text-sm text-muted-foreground">
                                    <FormattedDate
                                        date={new Date(activity.blockTime)}
                                        relative
                                    />
                                </div>
                            </div>
                        );
                    }

                    return (
                        <div className="flex items-center justify-end min-w-0">
                            <div className="flex flex-col items-end gap-0.5 min-w-0 w-full">
                                <div
                                    className={cn(
                                        "text-sm sm:text-base font-semibold truncate w-full text-right",
                                        isReceived
                                            ? "text-general-success-foreground"
                                            : "text-foreground",
                                    )}
                                >
                                    {formatActivityAmount(activity.amount)}{" "}
                                    {activity.tokenMetadata?.symbol ??
                                        activity.tokenId}
                                </div>
                                <div className="text-xs sm:text-sm text-muted-foreground whitespace-nowrap">
                                    <FormattedDate
                                        date={new Date(activity.blockTime)}
                                        relative
                                    />
                                </div>
                            </div>
                        </div>
                    );
                },
            }),
        ],
        [expandedGroups, t],
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
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3 px-4">
                    <div className="space-y-1">
                        <StepperHeader
                            title={
                                showConfidentialShield ? (
                                    <span className="inline-flex items-center gap-1.5">
                                        <span>{t("recentTitle")}</span>
                                        <Tooltip
                                            content={tCommon(
                                                "confidentialDataTooltip",
                                            )}
                                        >
                                            <span className="inline-flex">
                                                <Shield className="size-4 fill-foreground" />
                                            </span>
                                        </Tooltip>
                                    </span>
                                ) : (
                                    t("recentTitle")
                                )
                            }
                        />
                    </div>
                    <div className="flex items-center gap-2">
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
                        {!isHidden && (
                            <>
                                {" "}
                                <ExportButton />
                                <Link
                                    href={`/${treasuryId}/dashboard/activity`}
                                >
                                    <Button
                                        variant="secondary"
                                        size={isMobile ? "icon" : "default"}
                                        className="h-9 px-3"
                                    >
                                        <span className="hidden sm:inline">
                                            {tCommon("viewAll")}
                                        </span>
                                        <ChevronRight className="h-4 w-4" />
                                    </Button>
                                </Link>
                            </>
                        )}
                    </div>
                </CardHeader>
                <CardContent className="px-2">
                    {isHidden ? (
                        <ConfidentialState
                            skeleton={<RecentActivitySkeleton />}
                        />
                    ) : showActivityUnavailable ? (
                        <RecentActivityUnavailableOverlay
                            heading={activityWarningCopy.heading}
                            body={activityWarningCopy.body}
                        />
                    ) : isLoading || isHistoryRefreshing ? (
                        <RecentActivitySkeleton />
                    ) : activities.length === 0 ? (
                        <EmptyState
                            icon={Clock}
                            title={t("emptyDashboard.title")}
                            description={t("emptyDashboard.description")}
                        />
                    ) : (
                        <>
                            <div className="w-full overflow-x-auto px-2">
                                <Table className="table-fixed w-full min-w-full">
                                    <colgroup>
                                        <col className="w-42 sm:w-52 lg:w-1/2" />
                                        <col className="min-w-0 lg:w-1/2" />
                                    </colgroup>
                                    <TableBody>
                                        {table.getRowModel().rows.map((row) => {
                                            const grouped = row.original;
                                            const isGroup =
                                                grouped.type === "grouped";
                                            const groupId = isGroup
                                                ? `${grouped.pool}-${grouped.blockTime}`
                                                : "";
                                            const isExpanded =
                                                isGroup &&
                                                expandedGroups.has(groupId);

                                            return (
                                                <>
                                                    <TableRow
                                                        key={row.id}
                                                        className="group cursor-pointer"
                                                        onClick={() => {
                                                            if (isGroup) {
                                                                toggleGroup(
                                                                    groupId,
                                                                );
                                                            } else {
                                                                handleActivityClick(
                                                                    grouped.activity,
                                                                );
                                                            }
                                                        }}
                                                    >
                                                        {row
                                                            .getVisibleCells()
                                                            .map(
                                                                (cell, idx) => (
                                                                    <TableCell
                                                                        key={
                                                                            cell.id
                                                                        }
                                                                        className={cn(
                                                                            "py-2 h-14",
                                                                            idx ===
                                                                                0
                                                                                ? "pl-0 overflow-hidden pr-0 max-w-0"
                                                                                : "pr-0 overflow-hidden",
                                                                        )}
                                                                    >
                                                                        {flexRender(
                                                                            cell
                                                                                .column
                                                                                .columnDef
                                                                                .cell,
                                                                            cell.getContext(),
                                                                        )}
                                                                    </TableCell>
                                                                ),
                                                            )}
                                                    </TableRow>
                                                    {isExpanded &&
                                                        grouped.activities.map(
                                                            (activity, idx) => (
                                                                <TableRow
                                                                    key={`${groupId}-sub-${idx}`}
                                                                    className="group cursor-pointer bg-muted/30"
                                                                    onClick={() =>
                                                                        handleActivityClick(
                                                                            activity,
                                                                        )
                                                                    }
                                                                >
                                                                    <TableCell className="py-2 h-14 pl-8 sm:pl-14 overflow-hidden max-w-0">
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
                                                                                    {t(
                                                                                        "tabs.stakingRewards",
                                                                                    )}
                                                                                </div>
                                                                                <div className="text-xs sm:text-sm text-muted-foreground font-medium truncate">
                                                                                    {t(
                                                                                        "fromPool",
                                                                                        {
                                                                                            pool: grouped.pool,
                                                                                        },
                                                                                    )}
                                                                                </div>
                                                                            </div>
                                                                        </div>
                                                                    </TableCell>
                                                                    <TableCell className="py-2 h-14 pr-3 pl-4 overflow-hidden">
                                                                        <div className="flex items-center justify-end min-w-0">
                                                                            <div className="flex flex-col items-end gap-0.5 min-w-0 w-full">
                                                                                <div className="text-sm sm:text-base font-semibold text-general-success-foreground truncate w-full text-right">
                                                                                    {formatActivityAmount(
                                                                                        activity.amount,
                                                                                    )}{" "}
                                                                                    {activity
                                                                                        .tokenMetadata
                                                                                        ?.symbol ??
                                                                                        activity.tokenId}
                                                                                </div>
                                                                                <div className="text-xs sm:text-sm text-muted-foreground whitespace-nowrap">
                                                                                    <FormattedDate
                                                                                        date={
                                                                                            new Date(
                                                                                                activity.blockTime,
                                                                                            )
                                                                                        }
                                                                                        relative
                                                                                    />
                                                                                </div>
                                                                            </div>
                                                                        </div>
                                                                    </TableCell>
                                                                </TableRow>
                                                            ),
                                                        )}
                                                </>
                                            );
                                        })}
                                    </TableBody>
                                </Table>
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
