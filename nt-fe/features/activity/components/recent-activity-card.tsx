"use client";
import {
    Alert01Icon,
    ArrowDown02Icon,
    ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { ConfidentialState } from "@/components/confidential-state";
import { EmptyState } from "@/components/empty-state";
import { Icon } from "@/components/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { parseWarningCopy } from "@/components/warning-message";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useTreasury } from "@/hooks/use-treasury";
import { useRecentActivity } from "@/hooks/use-treasury-queries";
import { useWarningMessage, useWarnings } from "@/hooks/use-warnings";
import type { RecentActivity as RecentActivityType } from "@/lib/api";
import { cn, formatActivityAmount } from "@/lib/utils";
import {
    getActivityStatus,
    useGetActivityLabel,
    useGetActivitySubLabel,
} from "../utils/history-utils";
import {
    ActivityRow,
    RowAmount,
    RowDate,
    RowStatus,
    SwapAmount,
} from "./activity-row";
import { ActivityGlyph, ActivityRowIcon } from "./activity-row-icon";
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

const SKELETON_ROWS = ["a", "b", "c", "d", "e", "f"];

export function RecentActivitySkeleton({
    rows = SKELETON_ROWS.length,
    fade = false,
}: {
    rows?: number;
    fade?: boolean;
}) {
    return (
        <div className="flex flex-col">
            {SKELETON_ROWS.slice(0, rows).map((row, index) => (
                <div
                    key={row}
                    className="flex h-17 items-center gap-4 px-3"
                    style={
                        fade
                            ? { opacity: Math.max(0.15, 1 - index * 0.55) }
                            : undefined
                    }
                >
                    <Skeleton className="size-10 shrink-0 rounded-full" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <Skeleton className="h-5 w-[min(140px,50%)]" />
                        <Skeleton className="h-4 w-[min(240px,60%)]" />
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <Skeleton className="h-5 w-28" />
                        <Skeleton className="h-4 w-20" />
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
                        <Icon
                            icon={Alert01Icon}
                            className="text-general-orange-foreground"
                        />
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
            return getActivityLabel(activity);
        },
        [getActivityLabel],
    );

    const getActivityFrom = useCallback(
        (activity: RecentActivityType) => {
            return getActivitySubLabel(activity, treasuryId);
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
                <ActivityRowIcon>
                    <Icon icon={ArrowDown02Icon} />
                </ActivityRowIcon>
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
                            <ActivityRowIcon>
                                <Icon icon={ArrowDown02Icon} />
                            </ActivityRowIcon>
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
                            <Icon
                                icon={ArrowRight01Icon}
                                className={cn(
                                    "text-muted-foreground transition-transform",
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
                icon={
                    <ActivityRowIcon>
                        <ActivityGlyph activity={activity} />
                    </ActivityRowIcon>
                }
                label={getActivityType(activity)}
                subLabel={getActivityFrom(activity)}
                amount={
                    activity.swap ? (
                        <SwapAmount swap={activity.swap} compact={isMobile} />
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
                    title={t("emptyDashboard.title")}
                    description={t("emptyDashboard.description")}
                    skeleton={<RecentActivitySkeleton rows={4} fade />}
                    className="py-0"
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
                        </h2>
                        <p className="truncate text-muted-foreground text-sm leading-[1.5] sm:text-base">
                            {t("recentSubtitle")}
                        </p>
                    </div>
                    {!isHidden &&
                        !showActivityUnavailable &&
                        activities.length > 0 && (
                            <Link href={`/${treasuryId}/dashboard/activity`}>
                                <Button
                                    variant="secondary"
                                    className="bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900 dark:bg-white/10 dark:text-gray-200 dark:hover:bg-white/20"
                                    size={isMobile ? "icon-sm" : "sm"}
                                >
                                    {!isMobile && (
                                        <span>{tCommon("seeMore")}</span>
                                    )}
                                    <Icon icon={ArrowRight01Icon} />
                                </Button>
                            </Link>
                        )}
                </header>
                <PageCard className="gap-0 overflow-hidden p-2 sm:px-3 sm:py-4">
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
