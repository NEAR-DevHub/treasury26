"use client";

import {
    AlertTriangle,
    ArrowDown,
    ChevronRight,
    Clock,
    Loader2,
    Navigation,
    Shield,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { ConfidentialState } from "@/components/confidential-state";
import { EmptyState } from "@/components/empty-state";
import { FormattedDate } from "@/components/formatted-date";
import { SwapIcon } from "@/components/icons/swap";
import { Tooltip } from "@/components/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { parseWarningCopy } from "@/components/warning-message";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useTreasury } from "@/hooks/use-treasury";
import { useRecentActivity } from "@/hooks/use-treasury-queries";
import { useWarningMessage, useWarnings } from "@/hooks/use-warnings";
import type { RecentActivity as RecentActivityType } from "@/lib/api";
import { cn, formatActivityAmount, formatSmartAmount } from "@/lib/utils";
import {
    type ActivityStatus,
    getActivityStatus,
    useGetActivityLabel,
    useGetActivitySubLabel,
} from "../utils/history-utils";
import { useIsHistoryRefreshing } from "./history-refresh-indicator";
import { TransactionDetailsModal } from "./transaction-details-modal";

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

const ITEMS_ON_DASHBOARD = 10;
const MAX_ITEMS = 100;

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
            const pool = current.counterparty ?? "";
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

/**
 * Neutral 36px badge that fronts every row. The design deliberately keeps the
 * badge monochrome — direction is carried by the glyph and the amount colour,
 * not by a tinted circle.
 */
function RowIcon({ children }: { children: ReactNode }) {
    return (
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-general-border bg-general-secondary text-muted-foreground">
            {children}
        </div>
    );
}

function activityIcon(activity: RecentActivityType) {
    if (activity.swap) return <SwapIcon className="size-4" />;
    return parseFloat(activity.amount) > 0 ? (
        <ArrowDown className="size-4" />
    ) : (
        <Navigation className="size-4" />
    );
}

interface ActivityRowProps {
    icon: ReactNode;
    label: ReactNode;
    subLabel?: ReactNode;
    amount: ReactNode;
    /** Secondary line under the amount: relative date or execution status. */
    meta: ReactNode;
    trailing?: ReactNode;
    onClick: () => void;
    className?: string;
}

function ActivityRow({
    icon,
    label,
    subLabel,
    amount,
    meta,
    trailing,
    onClick,
    className,
}: ActivityRowProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "flex w-full cursor-pointer items-center rounded-2xl px-1 text-left transition-colors hover:bg-general-secondary",
                className,
            )}
        >
            <div className="flex h-16 items-center px-2">{icon}</div>
            <div className="flex h-16 min-w-0 flex-1 flex-col justify-center px-2">
                <span className="truncate font-semibold text-sm leading-[1.2] sm:text-base">
                    {label}
                </span>
                {subLabel ? (
                    <span className="truncate font-medium text-muted-foreground text-xs leading-[1.5] sm:text-sm">
                        {subLabel}
                    </span>
                ) : null}
            </div>
            <div className="flex h-16 min-w-0 flex-1 flex-col items-end justify-center gap-0.5 px-2">
                {amount}
                {meta}
            </div>
            {trailing ? (
                <div className="flex h-16 items-center pr-1">{trailing}</div>
            ) : null}
        </button>
    );
}

function RowAmount({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return (
        <span
            className={cn(
                "w-full truncate text-right font-semibold text-sm leading-[1.2] sm:text-base",
                className,
            )}
        >
            {children}
        </span>
    );
}

function RowDate({ date }: { date: string }) {
    return (
        <span className="w-full truncate text-right font-medium text-muted-foreground text-xs leading-[1.5] sm:text-sm">
            {/* The row itself is the button, so the date can't carry one. */}
            <FormattedDate date={new Date(date)} relative withTooltip={false} />
        </span>
    );
}

/** Replaces the date line while a transaction is still settling or has failed. */
function RowStatus({ status }: { status: NonNullable<ActivityStatus> }) {
    const t = useTranslations("activity.details");
    return (
        <span
            className={cn(
                "flex items-center gap-1 font-medium text-xs leading-[1.5] sm:text-sm",
                status === "failed"
                    ? "text-general-destructive-foreground"
                    : "text-general-orange-foreground",
            )}
        >
            {status === "pending" ? (
                <Loader2 className="size-3 animate-spin" />
            ) : null}
            {status === "pending" ? t("processing") : t("failed")}
        </span>
    );
}

function SwapAmount({
    swap,
}: {
    swap: NonNullable<RecentActivityType["swap"]>;
}) {
    const sentSymbol = swap.sentTokenMetadata?.symbol ?? null;
    const receivedSymbol =
        swap.receivedTokenMetadata?.symbol ?? swap.receivedTokenId;
    const sent =
        swap.sentAmount && sentSymbol
            ? `${formatSmartAmount(swap.sentAmount)} ${sentSymbol}`
            : (sentSymbol ?? "?");
    const received = swap.receivedAmount
        ? `${formatSmartAmount(swap.receivedAmount)} ${receivedSymbol}`
        : receivedSymbol;

    return (
        <RowAmount>
            {/* Narrow screens can't fit both amounts, so they fall back to symbols. */}
            <span className="hidden sm:inline">{sent}</span>
            <span className="sm:hidden">{sentSymbol ?? "?"}</span>
            {" → "}
            <span className="hidden sm:inline">{received}</span>
            <span className="sm:hidden">{receivedSymbol}</span>
        </RowAmount>
    );
}

const SKELETON_ROWS = ["a", "b", "c", "d", "e", "f"];

export function RecentActivitySkeleton() {
    return (
        <div className="flex flex-col">
            {SKELETON_ROWS.map((row) => (
                <div key={row} className="flex h-16 items-center gap-4 px-3">
                    <Skeleton className="size-9 shrink-0 rounded-full bg-general-unofficial-accent-0" />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <Skeleton className="h-4 w-[min(240px,60%)] bg-general-unofficial-accent-0" />
                        <Skeleton className="h-3 w-[min(160px,40%)] bg-general-unofficial-accent-0" />
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                        <Skeleton className="h-4 w-28 bg-general-unofficial-accent-0" />
                        <Skeleton className="h-3 w-20 bg-general-unofficial-accent-0" />
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
        <div className="relative min-h-[24rem]">
            <RecentActivitySkeleton />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 py-8">
                <div className="pointer-events-auto flex max-w-lg flex-col items-center gap-3 text-center">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-general-orange-background">
                        <AlertTriangle className="size-5 text-general-orange-foreground" />
                    </div>
                    <div>
                        {heading && (
                            <p className="font-semibold text-base text-foreground">
                                {heading}
                            </p>
                        )}
                        {body && (
                            <p className="text-muted-foreground text-sm">
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
    const { treasuryId, isConfidential, isGuestTreasury } = useTreasury();
    const [hideSmallTransactions] = useState(false);
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

    const activities = response?.data || [];

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

    const getActivityType = useCallback(
        (activity: RecentActivityType) => {
            return getActivityLabel({
                ...activity,
                tokenSymbol: activity.tokenMetadata?.symbol,
            });
        },
        [getActivityLabel],
    );

    const getActivityFrom = useCallback(
        (activity: RecentActivityType) => {
            return getActivitySubLabel(
                {
                    ...activity,
                    tokenSymbol: activity.tokenMetadata?.symbol,
                },
                treasuryId,
            );
        },
        [getActivitySubLabel, treasuryId],
    );

    const renderStakingRewardRow = (
        activity: RecentActivityType,
        pool: string,
        className?: string,
    ) => (
        <ActivityRow
            key={`sub-${activity.id}`}
            icon={
                <RowIcon>
                    <ArrowDown className="size-4" />
                </RowIcon>
            }
            label={t("tabs.stakingRewards")}
            subLabel={t("fromPool", { pool })}
            amount={
                <RowAmount className="text-general-success-foreground">
                    {formatActivityAmount(activity.amount)}{" "}
                    {activity.tokenMetadata?.symbol ?? activity.tokenId}
                </RowAmount>
            }
            meta={<RowDate date={activity.blockTime} />}
            onClick={() => handleActivityClick(activity)}
            className={className}
        />
    );

    const renderRow = (grouped: GroupedActivity) => {
        if (grouped.type === "grouped") {
            const groupId = `${grouped.pool}-${grouped.blockTime}`;
            const isExpanded = expandedGroups.has(groupId);

            return (
                <div key={`group-${groupId}`} className="flex flex-col">
                    <ActivityRow
                        icon={
                            <RowIcon>
                                <ArrowDown className="size-4" />
                            </RowIcon>
                        }
                        label={t("tabs.stakingRewards")}
                        subLabel={t("fromPool", { pool: grouped.pool })}
                        amount={
                            <RowAmount className="text-general-success-foreground">
                                {formatActivityAmount(grouped.totalAmount)}{" "}
                                {grouped.tokenMetadata?.symbol ??
                                    grouped.activities[0]?.tokenId}
                            </RowAmount>
                        }
                        meta={<RowDate date={grouped.blockTime} />}
                        trailing={
                            <ChevronRight
                                className={cn(
                                    "size-5 text-muted-foreground transition-transform",
                                    isExpanded && "rotate-90",
                                )}
                            />
                        }
                        onClick={() => toggleGroup(groupId)}
                    />
                    {isExpanded &&
                        grouped.activities.map((activity) =>
                            renderStakingRewardRow(
                                activity,
                                grouped.pool,
                                "pl-6 sm:pl-10",
                            ),
                        )}
                </div>
            );
        }

        const activity = grouped.activity;
        const status = getActivityStatus(activity);
        const isReceived = parseFloat(activity.amount) > 0;

        return (
            <ActivityRow
                key={`single-${activity.id}`}
                icon={<RowIcon>{activityIcon(activity)}</RowIcon>}
                label={getActivityType(activity)}
                subLabel={getActivityFrom(activity)}
                amount={
                    activity.swap ? (
                        <SwapAmount swap={activity.swap} />
                    ) : (
                        <RowAmount
                            className={
                                isReceived
                                    ? "text-general-success-foreground"
                                    : "text-foreground"
                            }
                        >
                            {formatActivityAmount(activity.amount)}{" "}
                            {activity.tokenMetadata?.symbol ?? activity.tokenId}
                        </RowAmount>
                    )
                }
                meta={
                    status ? (
                        <RowStatus status={status} />
                    ) : (
                        <RowDate date={activity.blockTime} />
                    )
                }
                onClick={() => handleActivityClick(activity)}
            />
        );
    };

    const renderContent = () => {
        if (isHidden) {
            return <ConfidentialState skeleton={<RecentActivitySkeleton />} />;
        }
        if (showActivityUnavailable) {
            return (
                <RecentActivityUnavailableOverlay
                    heading={activityWarningCopy.heading}
                    body={activityWarningCopy.body}
                />
            );
        }
        if (isLoading || isHistoryRefreshing) {
            return <RecentActivitySkeleton />;
        }
        if (activities.length === 0) {
            return (
                <EmptyState
                    icon={Clock}
                    title={t("emptyDashboard.title")}
                    description={t("emptyDashboard.description")}
                />
            );
        }
        return (
            <div className="flex flex-col">
                {displayedActivities.map(renderRow)}
            </div>
        );
    };

    return (
        <>
            <section className="flex flex-col gap-3">
                <header className="flex items-center gap-3">
                    <div className="flex min-w-0 flex-1 flex-col">
                        <h2 className="flex items-center gap-1.5 font-semibold text-xl leading-[1.2] tracking-[-0.4px]">
                            {t("recentTitle")}
                            {showConfidentialShield && (
                                <Tooltip
                                    content={tCommon("confidentialDataTooltip")}
                                >
                                    <span className="inline-flex">
                                        <Shield className="size-4 fill-foreground" />
                                    </span>
                                </Tooltip>
                            )}
                        </h2>
                        <p className="truncate text-muted-foreground text-sm leading-[1.5] sm:text-base">
                            {t("recentSubtitle")}
                        </p>
                    </div>
                    {!isHidden && (
                        <Link href={`/${treasuryId}/dashboard/activity`}>
                            <Button
                                variant="secondary"
                                className="bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900 dark:bg-white/10 dark:text-gray-200 dark:hover:bg-white/20"
                                size={isMobile ? "icon-sm" : "sm"}
                            >
                                <span className="hidden sm:inline">
                                    {tCommon("seeMore")}
                                </span>
                                <ChevronRight className="size-4" />
                            </Button>
                        </Link>
                    )}
                </header>
                <PageCard className="gap-0 overflow-hidden px-3 py-4">
                    {renderContent()}
                </PageCard>
            </section>

            <TransactionDetailsModal
                activity={selectedActivity}
                treasuryId={treasuryId || ""}
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
            />
        </>
    );
}
