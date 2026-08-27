import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
    bodyCellClassName,
    CELL_PADDING,
    HASH_COLUMN_CLASS,
    HEAD_CLASS,
    TableSheet,
} from "./activity-table-layout";

/** Enough rows to fill a laptop viewport without overshooting the fold. */
const DESKTOP_ROWS = 10;
/** The mobile list is short enough that a full page of placeholders is noise. */
const MOBILE_ROWS = 7;
/** Previous, five pages, next — the widest pagination the design allows. */
const PAGINATION_STEPS = 5;

/**
 * The design's placeholder object: a flat `#F2F2F2` block with an 8px radius,
 * which reads as a pill at the 16px line height the rows use.
 */
function Placeholder({ className }: { className?: string }) {
    return (
        <Skeleton
            className={cn("rounded-lg bg-general-bg-secondary", className)}
        />
    );
}

/** Type and Transaction lead with a round badge; the rest are text only. */
function DesktopCellContent({ columnIndex }: { columnIndex: number }) {
    switch (columnIndex) {
        case 0:
            return (
                <div className="flex items-center gap-2">
                    <Placeholder className="size-10 shrink-0 rounded-full" />
                    <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                        <Placeholder className="h-4 w-[111px] max-w-full" />
                        <Placeholder className="h-4 w-full" />
                    </div>
                </div>
            );
        case 1:
            return (
                <div className="flex items-center gap-2">
                    <Placeholder className="size-10 shrink-0 rounded-full" />
                    <Placeholder className="h-4 min-w-0 flex-1" />
                </div>
            );
        case CELL_PADDING.length - 1:
            return <Placeholder className="ml-auto h-4 w-[198px] max-w-full" />;
        default:
            return <Placeholder className="h-4 w-full" />;
    }
}

/**
 * Loading state for the activity page's table, shown both on first load and
 * while "Update treasury data" re-fetches. It mirrors the real table's grid so
 * the placeholders don't shift once the rows arrive.
 */
export function ActivityTableSkeleton() {
    return (
        <div className="space-y-2">
            {/* Mobile: the five columns collapse into a badge + two stacked lines. */}
            <div className="flex flex-col py-4 md:hidden">
                {Array.from({ length: MOBILE_ROWS }).map((_, index) => (
                    <div
                        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list
                        key={index}
                        className="flex h-16 items-center px-1"
                    >
                        <div className="px-2">
                            <Placeholder className="size-9 rounded-full" />
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-2">
                            <Placeholder className="h-4 w-[111px] max-w-full" />
                            <Placeholder className="h-4 w-full" />
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col items-end gap-0.5 px-2">
                            <Placeholder className="h-4 w-[111px] max-w-full" />
                            <Placeholder className="h-4 w-full" />
                        </div>
                    </div>
                ))}
            </div>

            <div className="hidden md:block">
                <TableSheet>
                    <Table className="table-fixed border-separate border-spacing-0">
                        <TableHeader className="border-0 bg-transparent">
                            <TableRow className="border-0 hover:bg-transparent">
                                {CELL_PADDING.map((padding, columnIndex) => {
                                    const isLastColumn =
                                        columnIndex === CELL_PADDING.length - 1;

                                    return (
                                        <TableHead
                                            // biome-ignore lint/suspicious/noArrayIndexKey
                                            key={columnIndex}
                                            className={cn(
                                                HEAD_CLASS,
                                                padding,
                                                isLastColumn &&
                                                    HASH_COLUMN_CLASS,
                                            )}
                                        >
                                            <Placeholder
                                                className={cn(
                                                    "h-4 w-[111px] max-w-full",
                                                    isLastColumn && "ml-auto",
                                                )}
                                            />
                                        </TableHead>
                                    );
                                })}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {Array.from({ length: DESKTOP_ROWS }).map(
                                (_, rowIndex) => (
                                    <TableRow
                                        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list
                                        key={rowIndex}
                                        className="border-0 hover:bg-transparent"
                                    >
                                        {CELL_PADDING.map((_, columnIndex) => (
                                            <TableCell
                                                // biome-ignore lint/suspicious/noArrayIndexKey
                                                key={columnIndex}
                                                className={bodyCellClassName(
                                                    columnIndex,
                                                    rowIndex === 0,
                                                    rowIndex ===
                                                        DESKTOP_ROWS - 1,
                                                )}
                                            >
                                                <DesktopCellContent
                                                    columnIndex={columnIndex}
                                                />
                                            </TableCell>
                                        ))}
                                    </TableRow>
                                ),
                            )}
                        </TableBody>
                    </Table>
                </TableSheet>
            </div>

            {/* Pagination keeps its own row so the table doesn't jump when it appears. */}
            <div className="hidden items-center justify-end gap-2 pt-1 pr-1.5 md:flex">
                <Placeholder className="h-8 w-20" />
                {Array.from({ length: PAGINATION_STEPS }).map((_, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list
                    <Placeholder key={index} className="size-8" />
                ))}
                <Placeholder className="h-8 w-20" />
            </div>
        </div>
    );
}
