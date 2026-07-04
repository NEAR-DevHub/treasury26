"use client";

import { RefreshCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo } from "react";
import { Button } from "@/components/button";
import { useTreasury } from "@/hooks/use-treasury";
import {
    useConfidentialHistoryRefreshStatus,
    usePublicHistoryRefresh,
    useRefreshConfidentialHistory,
} from "@/hooks/use-treasury-queries";
import type { ConfidentialHistoryRefreshStatus } from "@/lib/api";
import { cn, formatRelativeTime } from "@/lib/utils";
import { useSetHistoryRefreshing } from "./history-refresh-indicator";

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
 * Refresh button for treasury history, shown for both confidential and public
 * treasuries (hidden only on guest views of a confidential treasury).
 *
 * Confidential: triggers a backend history drain (which also re-snapshots
 * balances), gated by a backend-provided cooldown.
 * Public: there is no backend drain, so it just invalidates and refetches the
 * existing assets, balance chart, and recent activity queries, gated by a
 * frontend-only dummy cooldown.
 *
 * In both modes the tooltip shows "Last updated now" right after a refresh and
 * otherwise prompts the user to update the treasury data.
 */
export function HistoryRefreshButton({ className }: { className?: string }) {
    const t = useTranslations("activity");
    const locale = useLocale();
    const { treasuryId, isConfidential, isGuestTreasury } = useTreasury();

    // Guests of a confidential treasury can't trigger a backend drain, so the
    // refresh button is hidden from them entirely. It shows for confidential
    // members and for any public treasury (members or guests).
    const isConfidentialGuest = isConfidential && isGuestTreasury;
    const showRefreshButton = !isConfidentialGuest;

    // Confidential: backend-driven refresh + cooldown status.
    const {
        data: refreshStatus,
        isFetching: isRefreshStatusFetching,
        isLoading: isRefreshStatusLoading,
        refetch: refetchRefreshStatus,
    } = useConfidentialHistoryRefreshStatus(
        treasuryId,
        showRefreshButton && isConfidential,
    );
    const { isPending: isConfidentialRefreshing, mutate: refreshHistory } =
        useRefreshConfidentialHistory(treasuryId);

    // Public: frontend-only cache refetch with a dummy cooldown.
    const publicRefresh = usePublicHistoryRefresh(
        treasuryId,
        showRefreshButton && !isConfidential,
    );

    const refreshControlState: RefreshControlState = isConfidential
        ? getRefreshControlState({
              isRefreshing: isConfidentialRefreshing,
              isStatusFetching:
                  isRefreshStatusLoading || isRefreshStatusFetching,
              refreshStatus,
          })
        : publicRefresh.isRefreshing
          ? "refreshing"
          : publicRefresh.canRefresh
            ? "ready"
            : "cooldown";

    const isRefreshing = isConfidential
        ? isConfidentialRefreshing
        : publicRefresh.isRefreshing;

    // Publish the in-flight state so dashboard widgets fed by the refreshed
    // queries (chart, assets, recent activity) can show skeletons meanwhile.
    const setHistoryRefreshing = useSetHistoryRefreshing();
    useEffect(() => {
        setHistoryRefreshing(isRefreshing);
    }, [isRefreshing, setHistoryRefreshing]);
    useEffect(() => {
        return () => setHistoryRefreshing(false);
    }, [setHistoryRefreshing]);

    const lastUpdatedAt = isConfidential
        ? refreshStatus?.lastUpdatedAt
        : publicRefresh.lastUpdatedAt;
    const isRefreshDisabled = refreshControlState !== "ready";

    const justNowLabel = t("refresh.justNow");
    const refreshRelativeTime = lastUpdatedAt
        ? formatRelativeTime(lastUpdatedAt, {
              justNow: justNowLabel,
              moments: t("refresh.moments"),
              locale,
          })
        : null;
    const isJustNow = refreshRelativeTime === justNowLabel;

    const refreshTooltip = useMemo(() => {
        switch (refreshControlState) {
            case "refreshing":
                return t("refresh.refreshing");
            case "checking":
                return t("refresh.checking");
            // ready / cooldown / unavailable: keep "Last updated now" right
            // after a refresh, otherwise prompt to update the treasury data.
            default:
                return isJustNow && refreshRelativeTime
                    ? t("refresh.lastUpdated", { time: refreshRelativeTime })
                    : t("refresh.updateTreasuryData");
        }
    }, [refreshControlState, isJustNow, refreshRelativeTime, t]);

    const handleRefreshHistory = useCallback(async () => {
        if (refreshControlState !== "ready") {
            return;
        }

        if (!isConfidential) {
            publicRefresh.refresh();
            return;
        }

        const latestStatus = await refetchRefreshStatus();
        if (latestStatus.data?.canRefresh !== true) {
            return;
        }

        refreshHistory();
    }, [
        refreshControlState,
        isConfidential,
        publicRefresh,
        refetchRefreshStatus,
        refreshHistory,
    ]);

    if (!showRefreshButton) {
        return null;
    }

    return (
        <Button
            variant="secondary"
            size="icon"
            className={cn("h-9 w-9", className)}
            tooltipContent={refreshTooltip}
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
