import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Geometry shared by the activity table and its loading skeleton, so the
 * placeholders land on the same grid the real rows do.
 */

/** Shared geometry for the five columns, applied to header and body alike. */
export const CELL_PADDING = [
    "px-6",
    "px-4",
    "px-3",
    "px-3",
    "px-3 text-right",
] as const;

export const HEAD_CLASS =
    "h-10 text-sm font-semibold normal-case leading-[1.5]";

/** The transaction hash column is fixed so the four data columns can flex. */
export const HASH_COLUMN_CLASS = "w-[278px]";

/**
 * The table paints a white sheet floating on the card's tertiary surface: the
 * header sits on the surface itself while the rows form a rounded, bordered
 * block. `border-separate` keeps that block's corners round — with collapsed
 * borders the radius on the outer cells would be dropped.
 */
export function bodyCellClassName(
    columnIndex: number,
    isFirstRow: boolean,
    isLastRow: boolean,
) {
    return cn(
        "h-[66px] bg-card border-b border-general-border align-middle transition-colors group-hover:bg-general-tertiary",
        CELL_PADDING[columnIndex],
        isFirstRow && "border-t",
        columnIndex === 0 && "border-l",
        columnIndex === CELL_PADDING.length - 1 && "border-r",
        isFirstRow && columnIndex === 0 && "rounded-tl-xl",
        isFirstRow &&
            columnIndex === CELL_PADDING.length - 1 &&
            "rounded-tr-xl",
        isLastRow && columnIndex === 0 && "rounded-bl-xl",
        isLastRow && columnIndex === CELL_PADDING.length - 1 && "rounded-br-xl",
    );
}

/** The tertiary frame the white row sheet floats inside. */
export function TableSheet({ children }: { children: ReactNode }) {
    return (
        <div className="rounded-2xl border border-general-border bg-general-tertiary p-1">
            {children}
        </div>
    );
}
