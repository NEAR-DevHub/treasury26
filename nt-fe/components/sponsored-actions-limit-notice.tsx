"use client";

import { Icon } from "@/components/icon";
import {
    Cancel01Icon,
    InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/button";
import { cn } from "@/lib/utils";
import type { SubscriptionStatus } from "@/lib/subscription-api";

interface SponsoredActionsLimitNoticeProps {
    treasuryId?: string;
    subscription?: SubscriptionStatus;
    showSidebarCard?: boolean;
    enableFloatingPopup?: boolean;
    onContactClick?: () => void;
}

const LOW_LIMIT_THRESHOLD_PERCENT = 10;

function formatResetDate(resetAt?: string) {
    if (!resetAt) {
        return "";
    }

    const date = new Date(resetAt);
    if (Number.isNaN(date.getTime())) {
        return "";
    }

    return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
    });
}

export function SponsoredActionsLimitNotice({
    treasuryId,
    subscription,
    showSidebarCard = true,
    enableFloatingPopup = true,
    onContactClick,
}: SponsoredActionsLimitNoticeProps) {
    const t = useTranslations("sponsoredActions");
    const [dismissed, setDismissed] = useState(false);
    const [portalReady, setPortalReady] = useState(false);

    const usage = useMemo(() => {
        if (!subscription) {
            return null;
        }

        const total = subscription.planConfig.limits.gasCoveredTransactions;
        if (total === null || total <= 0) {
            return null;
        }

        const available = Math.max(subscription.gasCoveredTransactions, 0);
        const used = Math.min(total, Math.max(total - available, 0));
        const availablePercent = (available / total) * 100;

        return {
            total,
            available,
            used,
            usedPercent: Math.max((used / total) * 100, 0),
            availablePercent,
            isExhausted: available <= 0,
            isLow:
                available > 0 &&
                availablePercent <= LOW_LIMIT_THRESHOLD_PERCENT,
        };
    }, [subscription]);

    const storageKey = treasuryId
        ? `sponsored-actions-notice-dismissed:${treasuryId}`
        : null;

    useEffect(() => {
        if (!storageKey || typeof window === "undefined") {
            return;
        }

        const storedValue = window.localStorage.getItem(storageKey);
        setDismissed(storedValue === "1");
    }, [storageKey]);

    useEffect(() => {
        setPortalReady(true);
    }, []);

    if (!usage || (!usage.isLow && !usage.isExhausted)) {
        return null;
    }

    const dismissNotice = () => {
        setDismissed(true);
        if (storageKey && typeof window !== "undefined") {
            window.localStorage.setItem(storageKey, "1");
        }
    };

    const title = usage.isExhausted ? t("titleExhausted") : t("titleAlmost");
    const resetDate = formatResetDate(subscription?.creditsResetAt);
    const resetDateOrFallback = resetDate || t("nextMonthlyReset");

    const floatingPopup =
        enableFloatingPopup && !dismissed ? (
            <div className="fixed bottom-4 right-4 z-60 w-sm max-w-[calc(100vw-2rem)] rounded-2xl bg-popover-foreground text-popover shadow-xl p-3 pb-2">
                <div className="flex items-center gap-2">
                    <Icon
                        icon={InformationCircleIcon}
                        className="mt-0.5 shrink-0 fill-destructive text-popover-foreground"
                    />
                    <div className="min-w-0 flex-1">
                        <p className="text-sm leading-6 font-semibold tracking-tight">
                            {title}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={dismissNotice}
                        className="rounded-sm opacity-70 transition-opacity hover:opacity-100"
                    >
                        <Icon icon={Cancel01Icon} />
                        <span className="sr-only">{t("closeNotice")}</span>
                    </button>
                </div>

                <div className="space-y-3 mt-5">
                    <p className="text-xs">
                        {t("teamUsage", {
                            total: usage.total.toLocaleString(),
                        })}
                    </p>

                    <div className="flex flex-col gap-0.5">
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-medium">
                                {t("available", {
                                    count: usage.available.toLocaleString(),
                                })}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {t("used", {
                                    count: usage.used.toLocaleString(),
                                })}
                            </span>
                        </div>

                        <div className="h-2 w-full overflow-hidden rounded-full bg-muted-foreground">
                            <div
                                className={cn(
                                    "h-full transition-all bg-accent",
                                )}
                                style={{ width: `${usage.usedPercent}%` }}
                            />
                        </div>
                    </div>

                    <p className="text-xs text-muted-foreground">
                        {usage.isExhausted
                            ? t("exhaustedBody", {
                                  date: resetDateOrFallback,
                              })
                            : t("almostBody")}
                    </p>

                    {usage.isExhausted && (
                        <div className="flex mt-5 justify-end">
                            <Button
                                size="sm"
                                className="w-fit bg-card text-card-foreground hover:bg-card/90 hover:text-foreground/90"
                                onClick={onContactClick}
                            >
                                {t("contactUs")}
                            </Button>
                        </div>
                    )}
                </div>
            </div>
        ) : null;

    return (
        <>
            {portalReady && typeof document !== "undefined"
                ? createPortal(floatingPopup, document.body)
                : floatingPopup}

            {showSidebarCard && usage.isExhausted && dismissed && (
                <div className="rounded-[8px] bg-secondary p-3">
                    <p className="text-sm font-medium text-foreground">
                        {title}
                    </p>

                    <p className="mt-1 text-xs">
                        {t("sidebarBody", { date: resetDateOrFallback })}
                    </p>

                    <Button
                        className="w-full mt-3 bg-card text-card-foreground hover:bg-card/90 hover:text-card-foreground/90"
                        onClick={onContactClick}
                    >
                        {t("contactUs")}
                    </Button>
                </div>
            )}
        </>
    );
}
