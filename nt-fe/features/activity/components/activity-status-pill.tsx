"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { ActivityStatus } from "../utils/history-utils";

interface ActivityStatusPillProps {
    status: ActivityStatus;
    className?: string;
}

const STATUS_CLASSES: Record<
    NonNullable<ActivityStatus> | "completed",
    string
> = {
    completed:
        "bg-general-success-background-faded text-general-success-foreground",
    pending:
        "bg-general-orange-background-faded text-general-orange-foreground",
    failed: "bg-general-destructive-background-faded text-general-destructive-foreground",
};

const STATUS_LABEL_KEYS: Record<
    NonNullable<ActivityStatus> | "completed",
    string
> = {
    completed: "completed",
    pending: "processing",
    failed: "failed",
};

/**
 * Pill for an activity's execution status. A `null` status means the
 * transaction is finalized on-chain and renders as "Completed".
 */
export function ActivityStatusPill({
    status,
    className,
}: ActivityStatusPillProps) {
    const t = useTranslations("activity.details");
    const resolvedStatus = status ?? "completed";

    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium",
                STATUS_CLASSES[resolvedStatus],
                className,
            )}
        >
            {resolvedStatus === "pending" ? (
                <Loader2 className="size-3 animate-spin" />
            ) : null}
            {t(STATUS_LABEL_KEYS[resolvedStatus])}
        </span>
    );
}
