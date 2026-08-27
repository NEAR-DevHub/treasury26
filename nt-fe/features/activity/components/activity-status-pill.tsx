"use client";
import { Icon } from "@/components/icon";
import { LoaderCircleIcon } from "@hugeicons/core-free-icons";
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
        "border-green-100 bg-general-success-background-faded text-general-success-foreground dark:border-green-900",
    pending:
        "border-general-orange-border bg-general-orange-background-faded text-general-orange-foreground",
    failed: "border-transparent bg-general-destructive-background-faded text-general-destructive-foreground",
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
                "inline-flex items-center gap-1 rounded-sm border px-2 py-1 text-xs font-medium",
                STATUS_CLASSES[resolvedStatus],
                className,
            )}
        >
            {resolvedStatus === "pending" ? (
                <Icon icon={LoaderCircleIcon} className="animate-spin" />
            ) : null}
            {t(STATUS_LABEL_KEYS[resolvedStatus])}
        </span>
    );
}
