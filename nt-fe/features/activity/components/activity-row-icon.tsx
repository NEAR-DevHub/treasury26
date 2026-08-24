"use client";

import {
    ArrowDataTransferHorizontalIcon,
    ArrowDown02Icon,
    SentIcon,
} from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon";
import type { RecentActivity } from "@/lib/api";

/**
 * Neutral 36px badge that fronts every activity row. The design deliberately
 * keeps the badge monochrome — direction is carried by the glyph and the
 * amount colour, not by a tinted circle.
 */
export function ActivityRowIcon({ children }: { children: ReactNode }) {
    return (
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-general-border bg-general-secondary text-muted-foreground">
            {children}
        </div>
    );
}

/** Direction glyph: exchange, incoming, or outgoing. */
export function ActivityGlyph({ activity }: { activity: RecentActivity }) {
    if (activity.swap) return <Icon icon={ArrowDataTransferHorizontalIcon} />;
    return parseFloat(activity.amount) > 0 ? (
        <Icon icon={ArrowDown02Icon} />
    ) : (
        <Icon icon={SentIcon} />
    );
}
