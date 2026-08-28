import { sheetCellClassName } from "@/components/table-sheet";
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

/** Geometry for one body cell of the white row sheet. */
export function bodyCellClassName(
    columnIndex: number,
    isFirstRow: boolean,
    isLastRow: boolean,
) {
    return cn(
        "h-[66px]",
        sheetCellClassName({
            isFirstRow,
            isLastRow,
            isFirstColumn: columnIndex === 0,
            isLastColumn: columnIndex === CELL_PADDING.length - 1,
        }),
        CELL_PADDING[columnIndex],
    );
}

export { TableSheet } from "@/components/table-sheet";
