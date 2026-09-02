import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import type React from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

/**
 * Checks if a value should be considered "null" for display purposes
 */
export const isNullValue = (val: any): boolean =>
    val === undefined || val === null || val === "" || val === "null";

/**
 * A setting that changed: the reading it is replacing, struck through, then an
 * arrow and the reading that replaces it. The type comes from the row this
 * sits in, so only the "before" half is toned down — a value that had nothing
 * before it has nothing to strike out.
 */
export const renderDiff = (
    oldNode: React.ReactNode,
    newNode: React.ReactNode,
    isOldNull: boolean = false,
) => (
    <div className="flex flex-wrap items-center justify-end gap-2">
        <span
            className={cn(
                "text-general-secondary-foreground",
                !isOldNull && "line-through",
            )}
        >
            {oldNode}
        </span>
        <Icon icon={ArrowRight02Icon} className="size-4 shrink-0" />
        <span>{newNode}</span>
    </div>
);
