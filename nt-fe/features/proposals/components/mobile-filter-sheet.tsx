"use client";

import { ArrowRight01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { endOfDay, startOfDay } from "date-fns";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { Input } from "@/components/input";
import { SheetHandle } from "@/components/mobile-shell/sheet-handle";
import { Dialog, DialogContent, DialogTitle } from "@/components/modal";
import { Checkbox } from "@/components/ui/checkbox";
import { DateTimePicker, useDatePresets } from "@/components/ui/datepicker";
import { ScrollArea } from "@/components/ui/scroll-area";
import { User } from "@/components/user";
import {
    type TokenOption,
    useBridgeTokenOptions,
    useFilteredTokenOptions,
} from "@/hooks/use-bridge-token-options";
import { cn } from "@/lib/utils";
import { useFilterParams } from "../hooks/use-filter-params";
import {
    type DateFilterData,
    hasFilterValue,
    parseFilterData,
    type TokenFilterData,
    type UserFilterData,
} from "../types/filter-types";
import { CREATED_DATE_PRESETS, type FilterOption } from "./proposal-filters";

/** The bordered, card-surfaced search field the filter editors share. */
const SEARCH_INPUT_CLASS =
    "rounded-xl border border-general-border bg-card! hover:bg-card! pl-9 text-sm placeholder:font-medium placeholder:text-general-muted-foreground focus-visible:border-general-border focus-visible:ring-0";
const SEARCH_ICON_CLASS = "left-2 size-5 text-general-muted-foreground";

/**
 * Filters this sheet knows how to edit. The desktop pills cover more (proposal
 * types, my vote, …); rows for those are dropped rather than opening an empty
 * editor, so adding one here is all a new mobile surface needs.
 */
const EDITABLE_FILTER_IDS = ["created_date", "token", "from", "to"] as const;
type EditableFilterId = (typeof EDITABLE_FILTER_IDS)[number];
type EditableFilterOption = FilterOption & { id: EditableFilterId };

function isEditable(option: FilterOption): option is EditableFilterOption {
    return (EDITABLE_FILTER_IDS as readonly string[]).includes(option.id);
}

interface MobileFilterSheetProps {
    filterOptions: FilterOption[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

/**
 * The phone-sized counterpart to `ProposalFilters`. A popover row doesn't fit
 * on a 393px screen, so filters are picked by drilling from a list of names
 * into one full-width editor at a time. Every editor writes the same URL
 * parameter shape the desktop pills do, so the two stay interchangeable.
 */
export function MobileFilterSheet({
    filterOptions,
    open,
    onOpenChange,
}: MobileFilterSheetProps) {
    const tCommon = useTranslations("common");
    const tF = useTranslations("requests.filters");
    const { searchParams, setFilters } = useFilterParams();
    const [activeId, setActiveId] = useState<string | null>(null);

    const editableOptions = filterOptions.filter(isEditable);
    const activeOption =
        editableOptions.find((option) => option.id === activeId) ?? null;

    // Every applied filter counts, editable here or not, so the heading matches
    // the toolbar's "Filters (N)" and "Reset" clears everything it counted —
    // otherwise a filter set on desktop would be stuck on the phone.
    const setOptionIds = filterOptions
        .filter((option) => hasFilterValue(searchParams.get(option.id)))
        .map((option) => option.id);

    const closeSheet = () => {
        setActiveId(null);
        onOpenChange(false);
    };

    const applyFilter = (value: string | null) => {
        if (activeOption) setFilters({ [activeOption.id]: value });
        closeSheet();
    };

    const resetFilters = () => {
        setFilters(Object.fromEntries(setOptionIds.map((id) => [id, null])));
        closeSheet();
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) closeSheet();
            }}
        >
            <DialogContent
                className={cn(
                    activeOption
                        ? // `w-auto` lets the 8px side inset actually inset: the
                          // base sheet is `w-full`, which would overflow instead.
                          "inset-x-2 bottom-2 w-auto gap-0 rounded-3xl p-0 max-sm:pb-2"
                        : // Rows carry their own inset so their pressed
                          // background can bleed past the sheet's gutter.
                          "gap-0 px-0",
                )}
            >
                {activeOption ? (
                    <>
                        <FilterSheetHeader
                            title={activeOption.label}
                            onBack={() => setActiveId(null)}
                        />
                        <FilterSheetBody
                            option={activeOption}
                            value={searchParams.get(activeOption.id) ?? ""}
                            onApply={applyFilter}
                        />
                    </>
                ) : (
                    <>
                        <SheetHandle />
                        <DialogTitle className="px-4 pb-3 text-left font-semibold text-base leading-[1.2]">
                            {setOptionIds.length > 0
                                ? tCommon("filtersWithCount", {
                                      count: setOptionIds.length,
                                  })
                                : tCommon("filters")}
                        </DialogTitle>
                        <div className="flex flex-col pb-2 pl-2">
                            {editableOptions.map((option) => (
                                <button
                                    key={option.id}
                                    type="button"
                                    onClick={() => setActiveId(option.id)}
                                    className={cn(
                                        "flex h-10 shrink-0 items-center gap-2 rounded-xl px-3 text-left font-semibold text-sm transition-colors active:bg-general-secondary",
                                        // A filter that's narrowing results
                                        // reads at full contrast; the rest stay
                                        // muted so the set ones stand out.
                                        setOptionIds.includes(option.id)
                                            ? "text-general-foreground"
                                            : "text-general-secondary-foreground",
                                    )}
                                >
                                    <span className="min-w-0 flex-1 truncate">
                                        {option.label}
                                    </span>
                                    <Icon
                                        icon={ArrowRight01Icon}
                                        className="shrink-0 text-general-muted-foreground"
                                    />
                                </button>
                            ))}
                            {setOptionIds.length > 0 && (
                                <div className="p-3">
                                    <Button
                                        variant="secondary"
                                        className="h-10 w-full rounded-xl font-bold text-general-secondary-foreground text-sm"
                                        onClick={resetFilters}
                                    >
                                        {tF("reset")}
                                    </Button>
                                </div>
                            )}
                        </div>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

function FilterSheetHeader({
    title,
    onBack,
}: {
    title: string;
    onBack: () => void;
}) {
    const tCommon = useTranslations("common");
    return (
        <div className="flex shrink-0 items-center justify-between px-5 py-4">
            <DialogTitle className="text-left font-semibold text-base leading-[1.2]">
                {title}
            </DialogTitle>
            <button
                type="button"
                onClick={onBack}
                aria-label={tCommon("back")}
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-general-muted-foreground transition-colors active:bg-general-secondary"
            >
                <Icon icon={Cancel01Icon} className="size-[13.25px]" />
            </button>
        </div>
    );
}

function FilterSheetBody({
    option,
    value,
    onApply,
}: {
    option: EditableFilterOption;
    value: string;
    onApply: (value: string | null) => void;
}) {
    switch (option.id) {
        case "created_date":
            return (
                <CreatedDateSheet
                    value={value}
                    minDate={option.minDate}
                    maxDate={option.maxDate}
                    onApply={onApply}
                />
            );
        case "token":
            return <TokenSheet value={value} onApply={onApply} />;
        case "from":
        case "to":
            return (
                <UsersSheet
                    value={value}
                    options={option.options ?? []}
                    onApply={onApply}
                />
            );
    }
}

/** Full-width confirm that pins to the bottom of every multi-select editor. */
function DoneButton({ onClick }: { onClick: () => void }) {
    const tCommon = useTranslations("common");
    return (
        <div className="shrink-0 px-3 py-2">
            <Button className="h-10 w-full rounded-xl" onClick={onClick}>
                {tCommon("done")}
            </Button>
        </div>
    );
}

function CreatedDateSheet({
    value,
    minDate,
    maxDate,
    onApply,
}: {
    value: string;
    minDate?: Date;
    maxDate?: Date;
    onApply: (value: string | null) => void;
}) {
    const presets = useDatePresets(CREATED_DATE_PRESETS);
    const [range, setRange] = useState<DateRange | undefined>(() => {
        const parsed = parseFilterData<DateFilterData>(value)?.dateRange;
        if (!parsed?.from && !parsed?.to) return undefined;
        return {
            from: parsed.from ? new Date(parsed.from) : undefined,
            to: parsed.to ? new Date(parsed.to) : undefined,
        };
    });

    const handleDone = () => {
        if (!range?.from && !range?.to) {
            onApply(null);
            return;
        }
        onApply(
            JSON.stringify({
                operation: "Is",
                dateRange: {
                    from: range.from
                        ? startOfDay(range.from).toISOString()
                        : undefined,
                    to: range.to ? endOfDay(range.to).toISOString() : undefined,
                },
            } satisfies DateFilterData),
        );
    };

    return (
        <>
            <div className="min-h-0 flex-1 overflow-y-auto border-general-border border-t">
                <DateTimePicker
                    mode="range"
                    presets={presets}
                    value={range}
                    onChange={(next) =>
                        setRange(
                            next && "from" in next
                                ? next
                                : { from: undefined, to: undefined },
                        )
                    }
                    defaultMonth={range?.from ?? startOfDay(new Date())}
                    numberOfMonths={1}
                    min={minDate}
                    max={maxDate}
                />
            </div>
            <DoneButton onClick={handleDone} />
        </>
    );
}

function TokenSheet({
    value,
    onApply,
}: {
    value: string;
    onApply: (value: string | null) => void;
}) {
    const t = useTranslations("tokenSelect");
    const [search, setSearch] = useState("");
    const { tokens, isLoading } = useBridgeTokenOptions();
    const filteredTokens = useFilteredTokenOptions(tokens, search);
    const selectedId = parseFilterData<TokenFilterData>(value)?.token?.id;

    const selectToken = (token: TokenOption) =>
        onApply(JSON.stringify({ operation: "Is", token }));

    return (
        <>
            <div className="shrink-0 px-5 pb-3">
                <Input
                    search
                    placeholder={t("searchPlaceholder")}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    inputClassName={SEARCH_INPUT_CLASS}
                    searchIconClassName={SEARCH_ICON_CLASS}
                />
            </div>
            <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col px-1 pb-2">
                    {filteredTokens.map((token) => (
                        <button
                            key={token.id}
                            type="button"
                            onClick={() => selectToken(token)}
                            className={cn(
                                "flex cursor-pointer items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors active:bg-general-secondary",
                                token.id === selectedId &&
                                    "bg-general-secondary",
                            )}
                        >
                            <TokenAvatar token={token} />
                            <span className="flex min-w-0 flex-col">
                                <span className="truncate font-semibold text-base leading-[1.2]">
                                    {token.id.toUpperCase()}
                                </span>
                                <span className="truncate font-medium text-general-secondary-foreground text-sm leading-[1.5]">
                                    {token.name}
                                </span>
                            </span>
                        </button>
                    ))}
                    {!isLoading && filteredTokens.length === 0 && (
                        <p className="py-4 text-center text-muted-foreground text-sm">
                            {t("noTokensFound")}
                        </p>
                    )}
                </div>
            </ScrollArea>
        </>
    );
}

function TokenAvatar({ token }: { token: TokenOption }) {
    const isImage =
        token.icon?.startsWith("http") || token.icon?.startsWith("data:");

    return isImage ? (
        <img
            src={token.icon}
            alt={token.name}
            className="size-10 shrink-0 rounded-full border border-general-border object-contain"
        />
    ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-blue font-normal text-sm text-white">
            {token.icon}
        </span>
    );
}

function UsersSheet({
    value,
    options,
    onApply,
}: {
    value: string;
    options: Array<{ value: string; label: string }>;
    onApply: (value: string | null) => void;
}) {
    const tF = useTranslations("requests.filters");
    const [search, setSearch] = useState("");
    const initialSelected = useMemo(
        () => parseFilterData<UserFilterData>(value)?.users ?? [],
        [value],
    );
    const [selected, setSelected] = useState<string[]>(initialSelected);

    // Already-filtered accounts open at the top so a long list never hides the
    // current selection. The order is pinned to what arrived from the URL:
    // re-sorting on each tap would slide rows out from under the finger.
    const visibleOptions = useMemo(() => {
        const query = search.toLowerCase();
        return options
            .filter((option) => option.value.toLowerCase().includes(query))
            .sort((a, b) => {
                const aSelected = initialSelected.includes(a.value);
                const bSelected = initialSelected.includes(b.value);
                if (aSelected !== bSelected) return aSelected ? -1 : 1;
                return a.value.localeCompare(b.value);
            });
    }, [options, search, initialSelected]);

    const toggle = (accountId: string) =>
        setSelected((current) =>
            current.includes(accountId)
                ? current.filter((id) => id !== accountId)
                : [...current, accountId],
        );

    return (
        <>
            <div className="shrink-0 px-4 pb-3">
                <Input
                    search
                    placeholder={tF("searchByAddress")}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    inputClassName={SEARCH_INPUT_CLASS}
                    searchIconClassName={SEARCH_ICON_CLASS}
                />
            </div>
            <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col px-4 pb-2">
                    {visibleOptions.map((option) => (
                        <button
                            key={option.value}
                            type="button"
                            onClick={() => toggle(option.value)}
                            className="flex cursor-pointer items-center gap-2 py-2 text-left"
                        >
                            <Checkbox
                                checked={selected.includes(option.value)}
                                // The row owns the toggle; the box is decoration.
                                tabIndex={-1}
                                className="pointer-events-none shrink-0"
                            />
                            <span className="min-w-0">
                                <User
                                    accountId={option.value}
                                    withLink={false}
                                    size="lg"
                                    highlightQuery={search}
                                />
                            </span>
                        </button>
                    ))}
                    {visibleOptions.length === 0 && (
                        <p className="py-4 text-center text-muted-foreground text-sm">
                            {search
                                ? tF("noMembersFound", { query: search })
                                : tF("noMembersAvailable")}
                        </p>
                    )}
                </div>
            </ScrollArea>
            <DoneButton
                onClick={() =>
                    onApply(
                        selected.length
                            ? JSON.stringify({
                                  operation: "Is",
                                  users: selected,
                              } satisfies UserFilterData)
                            : null,
                    )
                }
            />
        </>
    );
}
