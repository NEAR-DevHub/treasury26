"use client";

import { AlertTriangle, Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/alert";
import { useFormatDate } from "@/components/formatted-date";
import {
    fillAction,
    useWarnings,
    type WarningSeverity,
} from "@/hooks/use-warnings";
import { extractBannerWarningCopy } from "@/lib/warning-message";
import { cn } from "@/lib/utils";

// Matches [label](url) markdown links and bare https:// URLs.
const LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)|(https?:\/\/[^\s]+)/g;

function renderWithLinks(text: string) {
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;

    for (const match of text.matchAll(LINK_PATTERN)) {
        const index = match.index!;
        if (index > lastIndex) {
            parts.push(
                <span key={lastIndex}>{text.slice(lastIndex, index)}</span>,
            );
        }
        const label = match[1] ?? match[3]!;
        const href = match[2] ?? match[3]!;
        parts.push(
            <a
                key={index}
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="inline underline underline-offset-2"
            >
                {label}
            </a>,
        );
        lastIndex = index + match[0].length;
    }

    if (lastIndex < text.length) {
        parts.push(<span key={lastIndex}>{text.slice(lastIndex)}</span>);
    }

    return parts.length > 0 ? parts : text;
}

interface SlotWarningProps {
    slot: string;
    token?: string;
    network?: string;
    /** Overrides the word substituted for the {action} placeholder. */
    action?: string;
    className?: string;
    headingClassName?: string;
    bodyClassName?: string;
}

function getAlertVariant(
    severity: WarningSeverity,
): "default" | "info" | "warning" | "destructive" {
    switch (severity) {
        case "critical":
        case "warning":
            return "warning";
        case "info":
        default:
            return "info";
    }
}

function formatScheduleText(
    formatDate: (date: Date | string | number) => string,
    scheduledStart: string | null,
    scheduledEnd: string | null,
): string {
    const parts: string[] = [];
    if (scheduledStart) parts.push(`on ${formatDate(scheduledStart)}`);
    if (scheduledEnd) parts.push(`until ${formatDate(scheduledEnd)}`);
    return parts.join(" ");
}

export function SlotWarning({
    slot,
    token,
    network,
    action,
    className,
    headingClassName,
    bodyClassName,
}: SlotWarningProps) {
    const { getWarning } = useWarnings();
    const formatDate = useFormatDate();
    const warning = getWarning(slot, token, network);

    if (!warning?.message) {
        return null;
    }

    let message = fillAction(warning.message, action ?? warning.slot ?? slot);

    // Replace {schedule} with formatted dates if present in the message.
    const scheduleText = formatScheduleText(
        formatDate,
        warning.scheduledStart,
        warning.scheduledEnd,
    );
    const hasInlineSchedule = message.includes("{schedule}");
    if (hasInlineSchedule) {
        message = message.replace(/\{schedule\}/g, scheduleText || "");
    }

    const variant = getAlertVariant(warning.severity);
    const Icon = warning.severity === "info" ? Info : AlertTriangle;

    const { heading, body } = extractBannerWarningCopy(message);

    // Show schedule as a separate line only when not already inline via {schedule}.
    const showScheduleLine =
        !hasInlineSchedule &&
        scheduleText &&
        (warning.scheduledStart || warning.scheduledEnd);

    return (
        <Alert variant={variant} className={cn(className)}>
            <Icon className="h-4 w-4 shrink-0" />
            <AlertDescription className="block">
                {heading && (
                    <div
                        className={cn("block font-semibold", headingClassName)}
                    >
                        {renderWithLinks(heading)}
                    </div>
                )}
                {body ? (
                    <span className={bodyClassName}>
                        {renderWithLinks(body)}
                    </span>
                ) : null}
                {showScheduleLine && (
                    <span className="block mt-1 text-xs opacity-80">
                        {scheduleText}
                    </span>
                )}
            </AlertDescription>
        </Alert>
    );
}
