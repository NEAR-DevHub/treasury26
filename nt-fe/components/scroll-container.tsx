import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Shared thin scrollbar styles — transparent track, muted thumb.
 *
 * Prefer `ScrollContainer` whenever you can wrap the scrollable content.
 * Use this class only when the host element must own overflow itself
 * (e.g. Radix `SelectContent`, whose viewport can't be replaced by a wrapper).
 */
export const scrollbarClassName =
    "scrollbar-thin scrollbar-track-transparent scrollbar-thumb-muted-foreground/40";

type ScrollOrientation = "vertical" | "horizontal" | "both";

export interface ScrollContainerProps extends React.ComponentProps<"div"> {
    /** Scroll axis. Defaults to vertical. */
    orientation?: ScrollOrientation;
}

/**
 * Drop-in scrollable container with the app-standard thin scrollbar.
 * Prefer this over raw `overflow-y-auto` so scrollbars stay consistent.
 */
export function ScrollContainer({
    className,
    orientation = "vertical",
    ...props
}: ScrollContainerProps) {
    return (
        <div
            data-slot="scroll-container"
            className={cn(
                orientation === "vertical" &&
                    "overflow-y-auto overflow-x-hidden",
                orientation === "horizontal" &&
                    "overflow-x-auto overflow-y-hidden",
                orientation === "both" && "overflow-auto",
                scrollbarClassName,
                className,
            )}
            {...props}
        />
    );
}
