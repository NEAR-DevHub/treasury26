"use client";

import { useTranslations } from "next-intl";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/table";
import { Checkbox } from "@/components/ui/checkbox";
import { NetworkList } from "@/components/network-list";
import { User } from "@/components/user";
import { FormattedDate } from "@/components/formatted-date";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/empty-state";
import { Pagination } from "@/components/pagination";
import { SearchX, Trash2, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/button";
import { useChains } from "../chains";
import type { AddressBookEntry } from "../types";

interface AddressBookTableProps {
    entries: AddressBookEntry[];
    selectedIds: Set<string>;
    onSelectionChange: (ids: Set<string>) => void;
    onDelete?: (entry: AddressBookEntry) => void;
    onSend?: (entry: AddressBookEntry) => void;
    pageIndex?: number;
    pageSize?: number;
    total?: number;
    onPageChange?: (page: number) => void;
}

export function AddressBookTable({
    entries,
    selectedIds,
    onSelectionChange,
    onDelete,
    onSend,
    pageIndex = 0,
    pageSize = 15,
    total = entries.length,
    onPageChange,
}: AddressBookTableProps) {
    const t = useTranslations("addressBookTable");
    const { data: chains = [] } = useChains();
    const totalPages = Math.ceil(total / pageSize);
    const selectedEntryCount = entries.filter((entry) =>
        selectedIds.has(entry.id),
    ).length;

    const allSelected =
        entries.length > 0 && selectedEntryCount === entries.length;
    const someSelected = selectedEntryCount > 0 && !allSelected;

    function toggleAll() {
        const next = new Set(selectedIds);

        if (allSelected) {
            entries.forEach((entry) => {
                next.delete(entry.id);
            });
        } else {
            entries.forEach((entry) => {
                next.add(entry.id);
            });
        }

        onSelectionChange(next);
    }

    function toggleOne(id: string) {
        const next = new Set(selectedIds);
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
        }
        onSelectionChange(next);
    }

    if (entries.length === 0) {
        return (
            <EmptyState
                icon={SearchX}
                title={t("emptyTitle")}
                description={t("emptyDescription")}
                className="py-16"
            />
        );
    }

    return (
        <div className="flex flex-col pb-3">
            <ScrollArea className="w-full">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-10 pl-4 ">
                                <Checkbox
                                    checked={
                                        someSelected
                                            ? "indeterminate"
                                            : allSelected
                                    }
                                    onCheckedChange={toggleAll}
                                    aria-label={t("selectAll")}
                                />
                            </TableHead>
                            <TableHead>{t("recipient")}</TableHead>
                            <TableHead className="w-90">
                                {t("network")}
                            </TableHead>
                            <TableHead className="w-30">
                                {t("addedBy")}
                            </TableHead>
                            <TableHead className="w-52">{t("note")}</TableHead>
                            <TableHead className="w-20">{t("added")}</TableHead>
                            <TableHead className="w-20" />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {entries.map((entry) => {
                            const entryChains = chains.filter((c) =>
                                entry.networks.includes(c.key),
                            );
                            const selected = selectedIds.has(entry.id);

                            return (
                                <TableRow
                                    key={entry.id}
                                    data-state={
                                        selected ? "selected" : undefined
                                    }
                                    className="group"
                                >
                                    {/* Checkbox */}
                                    <TableCell className="w-10 pl-4">
                                        <Checkbox
                                            checked={selected}
                                            onCheckedChange={() =>
                                                toggleOne(entry.id)
                                            }
                                            aria-label={t("selectEntry", {
                                                name: entry.name,
                                            })}
                                        />
                                    </TableCell>

                                    {/* Recipient */}
                                    <TableCell>
                                        <User
                                            accountId={entry.address}
                                            name={entry.name}
                                            withLink={false}
                                            useAddressBook
                                            size="md"
                                            withHoverCard
                                        />
                                    </TableCell>

                                    {/* Networks */}
                                    <TableCell>
                                        <NetworkList
                                            chains={entryChains}
                                            badgeVariant="secondary"
                                        />
                                    </TableCell>

                                    {/* Added By */}
                                    <TableCell>
                                        {entry.createdBy ? (
                                            <User
                                                accountId={entry.createdBy}
                                                size="sm"
                                                withHoverCard
                                                withLink={false}
                                            />
                                        ) : (
                                            <span className="text-muted-foreground text-sm">
                                                —
                                            </span>
                                        )}
                                    </TableCell>

                                    {/* Note */}
                                    <TableCell>
                                        <span className="text-sm text-foreground line-clamp-2">
                                            {entry.note || (
                                                <span className="text-muted-foreground">
                                                    —
                                                </span>
                                            )}
                                        </span>
                                    </TableCell>

                                    {/* Added date */}
                                    <TableCell>
                                        <FormattedDate
                                            date={entry.createdAt}
                                            relative
                                            className="text-sm text-foreground"
                                        />
                                    </TableCell>

                                    {/* Actions */}
                                    <TableCell className="w-20">
                                        <div className="flex items-center justify-end gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                                            {onDelete && (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-8 w-8"
                                                    tooltipContent={t("remove")}
                                                    onClick={() =>
                                                        onDelete(entry)
                                                    }
                                                >
                                                    <Trash2 className="size-4 text-destructive" />
                                                </Button>
                                            )}
                                            {onSend && (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-8 w-8"
                                                    tooltipContent={t("send")}
                                                    onClick={() =>
                                                        onSend(entry)
                                                    }
                                                >
                                                    <ArrowUpRight className="size-4 text-primary" />
                                                </Button>
                                            )}
                                        </div>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
                <ScrollBar orientation="horizontal" />
            </ScrollArea>

            {onPageChange && totalPages > 1 && (
                <div className="pr-2">
                    <Pagination
                        pageIndex={pageIndex}
                        totalPages={totalPages}
                        onPageChange={onPageChange}
                    />
                </div>
            )}
        </div>
    );
}
