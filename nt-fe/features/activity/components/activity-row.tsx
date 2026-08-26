"use client";

import { LoaderCircleIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { MaskedBalance } from "@/components/balance-mask";
import { FormattedDate } from "@/components/formatted-date";
import { Icon } from "@/components/icon";
import type { RecentActivity } from "@/lib/api";
import { cn, formatSmartAmount } from "@/lib/utils";
import type { ActivityStatus } from "../utils/history-utils";

/**
 * The list shape every activity surface falls back to when a table is too wide
 * to be readable: badge, label/sub-label, then amount over a meta line. It backs
 * the dashboard's Recent Transactions card and the activity page on mobile.
 */
interface ActivityRowProps {
    icon: ReactNode;
    label: ReactNode;
    subLabel?: ReactNode;
    amount: ReactNode;
    /** Secondary line under the amount: date or execution status. */
    meta: ReactNode;
    trailing?: ReactNode;
    onClick: () => void;
    className?: string;
}

export function ActivityRow({
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
                <span className="truncate font-semibold text-base leading-[1.2]">
                    {label}
                </span>
                {subLabel ? (
                    <span className="truncate font-medium text-muted-foreground text-sm leading-[1.5]">
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

export function RowAmount({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return (
        <span
            className={cn(
                "w-full truncate text-right font-semibold text-base leading-[1.2]",
                className,
            )}
        >
            <MaskedBalance>{children}</MaskedBalance>
        </span>
    );
}

export function RowDate({
    date,
    relative = true,
}: {
    date: string;
    /** Absolute timestamps read better where the row stands in for a table. */
    relative?: boolean;
}) {
    return (
        <span className="w-full truncate text-right font-medium text-muted-foreground text-sm leading-[1.5]">
            {/* The row itself is the button, so the date can't carry one. */}
            <FormattedDate
                date={new Date(date)}
                relative={relative}
                includeTime={!relative}
                withTooltip={false}
            />
        </span>
    );
}

/** Replaces the date line while a transaction is still settling or has failed. */
export function RowStatus({ status }: { status: NonNullable<ActivityStatus> }) {
    const t = useTranslations("activity.details");
    return (
        <span
            className={cn(
                "flex items-center gap-1 font-medium text-sm leading-[1.5]",
                status === "failed"
                    ? "text-general-destructive-foreground"
                    : "text-general-orange-foreground",
            )}
        >
            {status === "pending" ? (
                <Icon icon={LoaderCircleIcon} className="animate-spin" />
            ) : null}
            {status === "pending" ? t("processing") : t("failed")}
        </span>
    );
}

export function SwapAmount({
    swap,
    compact,
}: {
    swap: NonNullable<RecentActivity["swap"]>;
    compact?: boolean;
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
            {compact ? (sentSymbol ?? "?") : sent}
            {" → "}
            {compact ? receivedSymbol : received}
        </RowAmount>
    );
}
