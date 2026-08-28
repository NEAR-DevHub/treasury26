import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The tertiary frame a data table floats inside: the header sits on the frame
 * itself while the rows form a rounded, bordered white sheet.
 */
export function TableSheet({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "rounded-2xl border border-general-border bg-general-tertiary p-1",
                className,
            )}
        >
            {children}
        </div>
    );
}

/**
 * Borders and corner radii for one body cell of the sheet. The table must use
 * `border-separate` — with collapsed borders the radius on the outer cells
 * would be dropped.
 *
 * @param isLastRow whether this cell closes the sheet, which is not always the
 * last data row: a table with expandable rows should pass
 * `isLastRow && !isExpanded`, so the rounded bottom corners land on the
 * expansion row underneath rather than on the row that opened it.
 */
export function sheetCellClassName({
    isFirstRow,
    isLastRow,
    isFirstColumn,
    isLastColumn,
}: {
    isFirstRow: boolean;
    isLastRow: boolean;
    isFirstColumn: boolean;
    isLastColumn: boolean;
}) {
    return cn(
        "border-general-border border-b bg-card align-middle transition-colors group-hover:bg-general-tertiary",
        isFirstRow && "border-t",
        isFirstColumn && "border-l",
        isLastColumn && "border-r",
        isFirstRow && isFirstColumn && "rounded-tl-xl",
        isFirstRow && isLastColumn && "rounded-tr-xl",
        isLastRow && isFirstColumn && "rounded-bl-xl",
        isLastRow && isLastColumn && "rounded-br-xl",
    );
}
