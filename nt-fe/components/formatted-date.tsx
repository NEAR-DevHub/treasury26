"use client";

import { useLocale, useTranslations } from "next-intl";
import {
    formatUserDate,
    formatRelativeTime,
    formatProposalStatusDate,
    cn,
    type FormatUserDateOptions,
    type RelativeTimeLabels,
} from "@/lib/utils";
import { useUserPreferences } from "@/hooks/use-user-preferences";
import { Tooltip } from "@/components/tooltip";
import type { Proposal } from "@/lib/proposals-api";
import type { Policy } from "@/types/policy";
import { getProposalStatusDateInfo } from "@/features/proposals/utils/proposal-utils";

type BaseFormattedDateProps = Omit<
    FormatUserDateOptions,
    "timezone" | "timeFormat"
> & {
    /** Override user's timezone preference */
    timezone?: string | null;
    /** Override user's time format preference */
    timeFormat?: "12" | "24";
    /** Additional CSS classes */
    className?: string;
    /**
     * Wrap relative dates in a tooltip showing the full timestamp. Defaults to
     * true; turn it off inside an interactive parent, since the tooltip trigger
     * is a button and buttons may not nest.
     */
    withTooltip?: boolean;
};

type StandardDateProps = BaseFormattedDateProps & {
    /** The date to format */
    date: Date | string | number;
    proposal?: never;
    policy?: never;
    /** Use relative time format (e.g., "2 minutes ago", "Yesterday"). Defaults to false. */
    relative?: boolean;
};

type ProposalStatusDateProps = BaseFormattedDateProps & {
    date?: never;
    /** Proposal to derive the status-based date from */
    proposal: Proposal;
    /** Policy required for expiration calculation */
    policy: Policy;
    /** Use status-based relative time (e.g. "Expires in 2 hours"). Defaults to false. */
    relative?: boolean;
};

type FormattedDateProps = StandardDateProps | ProposalStatusDateProps;

/**
 * Component that displays a formatted date according to user preferences.
 * Automatically uses user's timezone and time format settings from preferences.
 *
 * When `proposal` + `policy` are provided, displays the status-relevant date:
 * - Pending → "Expires in X" (expiry date)
 * - Executed/Rejected/Failed/Expired/Removed → "Status X ago" (resolved date)
 * Full timestamp shown in tooltip on hover.
 */
export function FormattedDate(props: FormattedDateProps) {
    const preferences = useUserPreferences();
    const tDate = useTranslations("statusDate");
    const tRel = useTranslations("relativeTime");
    const locale = useLocale();
    const relativeLabels: RelativeTimeLabels = {
        justNow: tRel("justNow"),
        moments: tRel("moments"),
        locale,
    };

    const timezone =
        props.timezone !== undefined
            ? props.timezone
            : preferences.timezone?.name || null;
    const timeFormat = props.timeFormat || preferences.timeFormat;

    let displayText: string;
    let tooltipText: string | undefined;

    let urgentExpiry = false;

    if (props.proposal && props.policy) {
        const { date, isFuture, labelKey } = getProposalStatusDateInfo(
            props.proposal,
            props.policy,
        );
        const label = labelKey ? tDate(labelKey) : "";
        tooltipText = formatUserDate(date, { timezone, timeFormat });
        if (isFuture && date.getTime() - Date.now() < 6 * 60 * 60 * 1000) {
            urgentExpiry = true;
        }
        if (props.relative) {
            const relativeStr = formatProposalStatusDate(
                date,
                isFuture,
                relativeLabels,
            );
            displayText = label ? `${label} ${relativeStr}` : relativeStr;
        } else {
            displayText = tooltipText;
            tooltipText = undefined;
        }
    } else {
        const {
            date,
            relative = false,
            timezone: _tz,
            timeFormat: _tf,
            policy: _p,
            proposal: _pr,
            withTooltip: _wt,
            ...options
        } = props as StandardDateProps;
        tooltipText = formatUserDate(date, {
            timezone,
            timeFormat,
            ...options,
        });
        if (relative) {
            displayText = formatRelativeTime(date, relativeLabels);
        } else {
            displayText = tooltipText;
            tooltipText = undefined;
        }
    }

    const content = (
        <span
            className={cn(
                urgentExpiry && "text-general-warning-foreground",
                props.className,
            )}
        >
            {displayText}
        </span>
    );

    return tooltipText && props.withTooltip !== false ? (
        <Tooltip
            content={tooltipText}
            triggerProps={{ asChild: false, className: "py-px flex" }}
        >
            {content}
        </Tooltip>
    ) : (
        content
    );
}

/**
 * Hook that returns a formatting function with user preferences applied.
 * Useful when you need to format dates in non-render contexts.
 */
export function useFormatDate() {
    const preferences = useUserPreferences();

    return (
        date: Date | string | number,
        options: FormatUserDateOptions = {},
    ) => {
        return formatUserDate(date, {
            timezone: preferences.timezone?.name || null,
            timeFormat: preferences.timeFormat,
            ...options,
        });
    };
}
