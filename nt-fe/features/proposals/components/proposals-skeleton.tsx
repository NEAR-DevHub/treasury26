"use client";

import { useTranslations } from "next-intl";
import { emptyRowFadeMaskStyle } from "@/components/empty-state";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/table";
import { sheetCellClassName, TableSheet } from "@/components/table-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { COLUMN_CLASS, COLUMN_IDS, HEAD_CLASS } from "./proposals-table-layout";

/** Enough rows to fill a laptop viewport without overshooting the fold. */
const TABLE_ROWS = 10;

/**
 * The design's placeholder object: a flat `#F2F2F2` block with an 8px radius,
 * which reads as a pill at the line heights the rows use.
 */
function Placeholder({ className }: { className?: string }) {
    return (
        <Skeleton
            className={cn("rounded-lg bg-general-bg-secondary", className)}
        />
    );
}

/** Request and Transaction both lead with a rounded badge over two lines. */
function BadgeCellSkeleton() {
    return (
        <div className="flex items-center gap-2">
            <Placeholder className="size-9 shrink-0 rounded-2xl" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Placeholder className="h-4 w-[75px] max-w-full" />
                <Placeholder className="h-3 w-full" />
            </div>
        </div>
    );
}

function TableCellSkeleton({ columnId }: { columnId: string }) {
    switch (columnId) {
        case "select":
            return <Placeholder className="size-4 rounded-sm" />;
        case "id":
        case "transaction":
            return <BadgeCellSkeleton />;
        case "proposer":
        case "voting":
            return <Placeholder className="h-3 w-[124px] max-w-full" />;
        case "status":
            return <Placeholder className="h-3 w-[71px] max-w-full" />;
        // The expand column only ever holds a chevron, which the design leaves
        // out of the loading state.
        default:
            return null;
    }
}

/**
 * Loading state for the requests table. The column headers are known before the
 * page arrives, so only the cells are placeheld — and they sit on the real
 * table's grid, so nothing shifts once the rows land.
 */
export function ProposalsTableSkeleton({
    className,
    rows = TABLE_ROWS,
}: {
    className?: string;
    /** Fewer rows when the skeleton is backdrop rather than loading state. */
    rows?: number;
}) {
    const tT = useTranslations("requests.table");

    const headers: Record<string, string> = {
        id: tT("request"),
        transaction: tT("transaction"),
        proposer: tT("requester"),
        voting: tT("voting"),
        status: tT("status"),
    };

    return (
        <TableSheet className={className}>
            <Table className="border-separate border-spacing-0 md:table-fixed">
                <TableHeader className="border-0 bg-transparent">
                    <TableRow className="border-0 hover:bg-transparent">
                        {COLUMN_IDS.map((columnId) => (
                            <TableHead
                                key={columnId}
                                className={cn(
                                    HEAD_CLASS,
                                    COLUMN_CLASS[columnId],
                                )}
                            >
                                {columnId === "select" ? (
                                    <Placeholder className="size-4 rounded-sm" />
                                ) : (
                                    headers[columnId]
                                )}
                            </TableHead>
                        ))}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {Array.from({ length: rows }).map((_, rowIndex) => (
                        <TableRow
                            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list
                            key={rowIndex}
                            className="border-0 hover:bg-transparent"
                        >
                            {COLUMN_IDS.map((columnId, columnIndex) => (
                                <TableCell
                                    key={columnId}
                                    className={cn(
                                        "h-[66px]",
                                        sheetCellClassName({
                                            isFirstRow: rowIndex === 0,
                                            isLastRow: rowIndex === rows - 1,
                                            isFirstColumn: columnIndex === 0,
                                            isLastColumn:
                                                columnIndex ===
                                                COLUMN_IDS.length - 1,
                                        }),
                                        COLUMN_CLASS[columnId],
                                    )}
                                >
                                    <TableCellSkeleton columnId={columnId} />
                                </TableCell>
                            ))}
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </TableSheet>
    );
}

/**
 * Loading state for one request card — the phone's stand-in for a table row.
 * The card keeps its real height so the list doesn't jump when it resolves.
 */
export function ProposalCardSkeleton() {
    return (
        <div className="flex w-full flex-col rounded-3xl border border-general-border bg-card px-3">
            <div className="flex w-full items-start gap-2 py-3">
                <Placeholder className="size-9 shrink-0 rounded-full" />
                <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
                    <Placeholder className="h-4 w-[95px] max-w-full" />
                    <Placeholder className="h-4 w-[114px] max-w-full" />
                    <Placeholder className="h-6 w-[188px] max-w-full" />
                </div>
            </div>

            <span className="h-px w-full bg-general-border" />

            <div className="flex w-full items-center justify-between py-4">
                <Placeholder className="h-6 w-[60px]" />
                <Placeholder className="h-6 w-[72px]" />
            </div>
        </div>
    );
}

/**
 * The design fills an empty requests list with its own skeleton, faded out, so
 * the page keeps the shape it will have once requests arrive. Meant to be
 * handed to `EmptyState`, which floats the message on top of it.
 */
export function ProposalsEmptyBackdrop() {
    return (
        <div style={emptyRowFadeMaskStyle}>
            <div className="flex flex-col gap-3 lg:hidden">
                <ProposalCardSkeleton />
                <ProposalCardSkeleton />
            </div>
            <ProposalsTableSkeleton className="hidden lg:block" rows={3} />
        </div>
    );
}
