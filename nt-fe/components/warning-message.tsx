"use client";

import { AlertTriangle, Info } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/alert";
import { useFormatDate } from "@/components/formatted-date";
import { Tooltip } from "@/components/tooltip";
import {
    fillAction,
    useWarnings,
    type WarningSeverity,
} from "@/hooks/use-warnings";
import { cn } from "@/lib/utils";

const MARKDOWN_HEADING_PATTERN = /^#{1,6}\s+/;

type ParsedWarningMessage = {
    primary: string;
    secondary: string;
    hasHeading: boolean;
};

/** Split stored user_message into primary (### line or plain) and secondary body. */
function parseWarningMessage(message: string | null): ParsedWarningMessage {
    const trimmed = message?.trim();
    if (!trimmed) {
        return { primary: "", secondary: "", hasHeading: false };
    }

    const lines = trimmed.split("\n");
    const headingIdx = lines.findIndex((line) =>
        MARKDOWN_HEADING_PATTERN.test(line.trim()),
    );

    if (headingIdx < 0) {
        return { primary: trimmed, secondary: "", hasHeading: false };
    }

    return {
        primary: lines[headingIdx].replace(MARKDOWN_HEADING_PATTERN, "").trim(),
        secondary: lines
            .slice(headingIdx + 1)
            .join("\n")
            .trim(),
        hasHeading: true,
    };
}

export function parseWarningCopy(message: string | null): {
    heading: string | null;
    body: string;
} {
    const { primary, secondary, hasHeading } = parseWarningMessage(message);
    if (!primary && !secondary) {
        return { heading: null, body: "" };
    }

    if (hasHeading) {
        return { heading: primary || null, body: secondary };
    }

    return { heading: null, body: primary };
}

const LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)|(https?:\/\/[^\s]+)/g;

function renderWithLinks(text: string) {
    const parts: ReactNode[] = [];
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

export type WarningMessageVariant = "banner" | "inline" | "tooltip";

type WarningMessageBaseProps = {
    className?: string;
    headingClassName?: string;
    bodyClassName?: string;
    /** Banner only — stack icon above text (sidebar). Default: icon beside text. */
    iconPosition?: "start" | "top";
};

type WarningMessageFromSlot = WarningMessageBaseProps & {
    variant: WarningMessageVariant;
    slot: string;
    token?: string;
    network?: string;
    action?: string;
    message?: never;
    severity?: never;
    startsAt?: never;
    endsAt?: never;
};

type WarningMessageFromText = WarningMessageBaseProps & {
    variant: WarningMessageVariant;
    message?: string | null;
    slot?: never;
    token?: never;
    network?: never;
    action?: never;
    severity?: WarningSeverity;
    startsAt?: string | null;
    endsAt?: string | null;
};

export type WarningMessageProps =
    | WarningMessageFromSlot
    | WarningMessageFromText;

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
    startsAt: string | null,
    endsAt: string | null,
): string {
    const parts: string[] = [];
    if (startsAt) parts.push(`on ${formatDate(startsAt)}`);
    if (endsAt) parts.push(`until ${formatDate(endsAt)}`);
    return parts.join(" ");
}

function useResolvedWarning(props: WarningMessageProps) {
    const { getWarning, actionBySlot } = useWarnings();
    const formatDate = useFormatDate();
    const slot = "slot" in props ? props.slot : undefined;
    const token = "slot" in props ? props.token : undefined;
    const network = "slot" in props ? props.network : undefined;
    const action = "slot" in props ? props.action : undefined;
    const messageProp = "slot" in props ? undefined : props.message;
    const severityProp = "slot" in props ? undefined : props.severity;
    const startsAtProp = "slot" in props ? undefined : props.startsAt;
    const endsAtProp = "slot" in props ? undefined : props.endsAt;

    return useMemo(() => {
        if (slot) {
            const warning = getWarning(slot, token, network);
            if (!warning?.message) {
                return null;
            }

            let message = fillAction(
                warning.message,
                action ?? warning.slot ?? slot,
                actionBySlot,
            );

            const scheduleText = formatScheduleText(
                formatDate,
                warning.startsAt,
                warning.endsAt,
            );
            const hasInlineSchedule = message.includes("{schedule}");
            if (hasInlineSchedule) {
                message = message.replace(/\{schedule\}/g, scheduleText || "");
            }

            return {
                message,
                severity: warning.severity,
                startsAt: warning.startsAt,
                endsAt: warning.endsAt,
                hasInlineSchedule,
                scheduleText,
            };
        }

        const message = messageProp?.trim();
        if (!message) {
            return null;
        }

        return {
            message,
            severity: severityProp ?? "warning",
            startsAt: startsAtProp ?? null,
            endsAt: endsAtProp ?? null,
            hasInlineSchedule: false,
            scheduleText: formatScheduleText(
                formatDate,
                startsAtProp ?? null,
                endsAtProp ?? null,
            ),
        };
    }, [
        slot,
        token,
        network,
        action,
        messageProp,
        severityProp,
        startsAtProp,
        endsAtProp,
        getWarning,
        actionBySlot,
        formatDate,
    ]);
}

function TooltipContent({ message }: { message: string }) {
    const { heading, body } = parseWarningCopy(message);

    if (!heading && !body) {
        return null;
    }

    if (heading && body) {
        return (
            <span className="block space-y-1 text-left">
                <span className="block font-semibold">{heading}</span>
                <span className="block font-normal opacity-90">{body}</span>
            </span>
        );
    }

    return <span className="block text-left">{heading ?? body}</span>;
}

/**
 * Renders a warning from a slot or raw message.
 * - `banner` — heading + body in an alert (slot banners, page notices)
 * - `inline` — heading inline + body in an info tooltip (token/amount fields)
 * - `tooltip` — heading + body for disabled-button tooltips
 */
export function WarningMessage(props: WarningMessageProps) {
    const resolved = useResolvedWarning(props);
    if (!resolved) {
        return null;
    }

    const {
        variant,
        className,
        headingClassName,
        bodyClassName,
        iconPosition,
    } = props;
    const {
        message,
        severity,
        startsAt,
        endsAt,
        hasInlineSchedule,
        scheduleText,
    } = resolved;

    if (variant === "tooltip") {
        return <TooltipContent message={message} />;
    }

    if (variant === "inline") {
        const { heading, body } = parseWarningCopy(message);
        const inlineText = heading || body || null;
        const tooltipText = heading && body ? body : null;
        if (!inlineText) {
            return null;
        }

        return (
            <p
                className={cn(
                    "text-general-warning-foreground inline-flex items-center gap-1 w-full min-w-0",
                    className,
                )}
            >
                <span className="truncate">{inlineText}</span>
                {tooltipText && (
                    <Tooltip content={tooltipText}>
                        <Info className="size-3 shrink-0" />
                    </Tooltip>
                )}
            </p>
        );
    }

    const { heading, body } = parseWarningCopy(message);
    if (!heading && !body) {
        return null;
    }

    const showScheduleLine =
        !hasInlineSchedule && scheduleText && (startsAt || endsAt);
    const alertVariant = getAlertVariant(severity);
    const Icon = severity === "info" ? Info : AlertTriangle;

    return (
        <Alert
            variant={alertVariant}
            className={cn(
                iconPosition === "top" && "flex-col! gap-2",
                className,
            )}
        >
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

/** Slot-scoped banner — shorthand for `<WarningMessage variant="banner" slot="…" />`. */
export function SlotWarning(props: Omit<WarningMessageFromSlot, "variant">) {
    return <WarningMessage variant="banner" {...props} />;
}

export function hasInlineWarning(message?: string | null): boolean {
    const { heading, body } = parseWarningCopy(message ?? null);
    return Boolean(heading || body);
}
