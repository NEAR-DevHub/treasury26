"use client";

import { RefreshCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";
import { Button } from "@/components/button";
import { useTreasury } from "@/hooks/use-treasury";
import {
    useConfidentialHistoryRefreshStatus,
    useRefreshConfidentialHistory,
} from "@/hooks/use-treasury-queries";
import type { ConfidentialHistoryRefreshStatus } from "@/lib/api";
import { cn, formatRelativeTime } from "@/lib/utils";

type RefreshControlState =
    | "ready"
    | "checking"
    | "refreshing"
    | "cooldown"
    | "unavailable";

function getRefreshControlState({
    isRefreshing,
    isStatusFetching,
    refreshStatus,
}: {
    isRefreshing: boolean;
    isStatusFetching: boolean;
    refreshStatus: ConfidentialHistoryRefreshStatus | null | undefined;
}): RefreshControlState {
    if (isRefreshing) {
        return "refreshing";
    }

    if (isStatusFetching) {
        return "checking";
    }

    if (!refreshStatus) {
        return "unavailable";
    }

    return refreshStatus.canRefresh ? "ready" : "cooldown";
}

/**
 * Refresh button for confidential treasuries. Triggers a confidential history
 * drain on the backend (which also re-snapshots balances), then invalidates the
 * assets, balance chart, and recent activity queries so balance, assets, and
 * recent transactions refresh together. Renders nothing for non-confidential
 * (or hidden guest) treasuries. Reuses the shared "last updated" tooltip.
 */
export function HistoryRefreshButton({ className }: { className?: string }) {
    const t = useTranslations("activity");
    const locale = useLocale();
    const { treasuryId, isConfidential, isGuestTreasury } = useTreasury();

    const isHidden = isConfidential && isGuestTreasury;
    const showRefreshButton = isConfidential && !isHidden;

    const {
        data: refreshStatus,
        isFetching: isRefreshStatusFetching,
        isLoading: isRefreshStatusLoading,
        refetch: refetchRefreshStatus,
    } = useConfidentialHistoryRefreshStatus(treasuryId, showRefreshButton);
    const { isPending: isRefreshing, mutate: refreshHistory } =
        useRefreshConfidentialHistory(treasuryId);

    const refreshControlState = getRefreshControlState({
        isRefreshing,
        isStatusFetching: isRefreshStatusLoading || isRefreshStatusFetching,
        refreshStatus,
    });
    const isRefreshDisabled = refreshControlState !== "ready";

    const refreshRelativeTime = refreshStatus?.lastUpdatedAt
        ? formatRelativeTime(refreshStatus.lastUpdatedAt, {
              justNow: t("refresh.justNow"),
              moments: t("refresh.moments"),
              locale,
          })
        : null;

    const refreshTooltip = useMemo(() => {
        switch (refreshControlState) {
            case "refreshing":
                return t("refresh.refreshing");
            case "checking":
                return t("refresh.checking");
            case "unavailable":
                return t("refresh.unavailable");
            case "cooldown":
                return refreshRelativeTime
                    ? t("refresh.lastUpdated", { time: refreshRelativeTime })
                    : t("refresh.unavailable");
            case "ready":
                return refreshRelativeTime
                    ? t("refresh.lastUpdated", { time: refreshRelativeTime })
                    : t("refresh.notUpdated");
        }
    }, [refreshControlState, refreshRelativeTime, t]);

    const handleRefreshHistory = useCallback(async () => {
        if (refreshControlState !== "ready") {
            return;
        }

        const latestStatus = await refetchRefreshStatus();
        if (latestStatus.data?.canRefresh !== true) {
            return;
        }

        refreshHistory();
    }, [refetchRefreshStatus, refreshControlState, refreshHistory]);

    if (!showRefreshButton) {
        return null;
    }

    return (
        <Button
            variant="secondary"
            size="icon"
            className={cn("h-9 w-9", className)}
            tooltipContent={refreshTooltip}
            aria-label={t("refresh.ariaLabel")}
            disabled={isRefreshDisabled}
            onClick={handleRefreshHistory}
        >
            <RefreshCw
                className={cn(
                    "h-4 w-4",
                    isRefreshing && "animate-spin motion-reduce:animate-none",
                )}
            />
        </Button>
    );
}
