"use client";

import {
    ArrowDown01Icon,
    ArrowRight01Icon,
    Cancel01Icon,
    CheckIcon,
} from "@hugeicons/core-free-icons";
import { endOfDay, startOfDay } from "date-fns";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { Input } from "@/components/input";
import { SheetHandle } from "@/components/mobile-shell/sheet-handle";
import { Dialog, DialogContent, DialogTitle } from "@/components/modal";
import { useOperationLabel } from "@/components/operation-select";
import { Checkbox } from "@/components/ui/checkbox";
import { DateTimePicker, useDatePresets } from "@/components/ui/datepicker";
import { ScrollArea } from "@/components/ui/scroll-area";
import { User } from "@/components/user";
import {
    type TokenOption,
    useBridgeTokenOptions,
    useFilteredTokenOptions,
} from "@/hooks/use-bridge-token-options";
import { useTreasury } from "@/hooks/use-treasury";
import { cn } from "@/lib/utils";
import { type UserListType, useDaoUsers } from "../hooks/use-dao-users";
import { useFilterParams } from "../hooks/use-filter-params";
import {
    type DateFilterData,
    hasFilterValue,
    type MyVoteFilterData,
    type ProposalTypeFilterData,
    parseFilterData,
    type TokenFilterData,
    type UserFilterData,
} from "../types/filter-types";
import {
    AMOUNT_OPERATIONS,
    CREATED_DATE_PRESETS,
    FILTER_OPERATIONS,
    type FilterOption,
    useMyVoteOptions,
    useProposalTypeOptions,
} from "./proposal-filters";

/** `proposal_types` and `my_vote` both serialise to `{ operation, selected }`. */
type ChecklistFilterData = ProposalTypeFilterData | MyVoteFilterData;

interface ChecklistOption {
    value: string;
    label: string;
}

/** The 44px row every list in this sheet is built from. */
const MENU_ROW_CLASS =
    "flex min-h-11 w-full shrink-0 items-center gap-2 rounded-lg px-4 py-2 text-left font-semibold text-general-secondary-foreground text-sm transition-colors active:bg-general-secondary";

/** The bordered, card-surfaced search field the filter editors share. */
const SEARCH_INPUT_CLASS =
    "h-9 rounded-lg border border-general-border bg-card! hover:bg-card! pl-9 text-sm placeholder:font-medium placeholder:text-general-muted-foreground focus-visible:border-general-border focus-visible:ring-0";
const SEARCH_ICON_CLASS = "left-2 size-5 text-general-muted-foreground";

/** The 40px-surfaced amount fields the token editor stacks under its heading. */
const AMOUNT_INPUT_CLASS =
    "h-10 rounded-lg border border-general-border bg-general-bg-tertiary! hover:bg-general-bg-tertiary! px-4 text-sm placeholder:font-medium placeholder:text-general-muted-foreground focus-visible:ring-0";

/**
 * The account list each user-shaped filter picks from: a recipient can be any
 * treasury member, while requesters and approvers are drawn from who has
 * actually proposed or voted.
 */
const USER_FILTER_LIST_TYPES = {
    recipients: "members",
    proposers: "proposers",
    approvers: "approvers",
} as const satisfies Record<string, UserListType>;

/**
 * The filters this sheet can edit — exactly those the desktop declares
 * comparisons for. Anything outside the map still shows up once applied, as a
 * read-only row, so it can be seen and reset.
 */
type EditableFilterId = keyof typeof FILTER_OPERATIONS;
type EditableFilterOption = FilterOption & { id: EditableFilterId };

function isEditable(option: FilterOption): option is EditableFilterOption {
    return option.id in FILTER_OPERATIONS;
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

    // Clearing reaches the desktop-only filters too — the heading counts them,
    // so nothing disappears unannounced.
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
                    <FilterSheetBody
                        // Remounting per filter keeps each editor's draft state
                        // (selection, search, operation) scoped to its own visit.
                        key={activeOption.id}
                        option={activeOption}
                        label={activeOption.label}
                        value={searchParams.get(activeOption.id) ?? ""}
                        onApply={applyFilter}
                        onBack={() => setActiveId(null)}
                    />
                ) : (
                    <>
                        <SheetHandle />
                        <DialogTitle className="px-4 pt-1.5 pb-3 text-left font-semibold text-base leading-[1.2]">
                            {setOptionIds.length > 0
                                ? tCommon("filtersWithCount", {
                                      count: setOptionIds.length,
                                  })
                                : tCommon("filters")}
                        </DialogTitle>
                        <div className="flex flex-col pb-5 pl-2">
                            {filterOptions.map((option) => {
                                const isSet = setOptionIds.includes(option.id);

                                // Filters without a mobile editor are still
                                // listed once applied, so "Reset" isn't the
                                // user's only clue that they're narrowing the
                                // table.
                                if (!isEditable(option)) {
                                    return isSet ? (
                                        <div
                                            key={option.id}
                                            className="flex h-10 shrink-0 items-center gap-2 px-3 font-semibold text-general-foreground text-sm"
                                        >
                                            <span className="min-w-0 flex-1 truncate">
                                                {option.label}
                                            </span>
                                            <span className="shrink-0 font-medium text-general-muted-foreground text-xs">
                                                {tF("editOnDesktop")}
                                            </span>
                                        </div>
                                    ) : null;
                                }

                                return (
                                    <button
                                        key={option.id}
                                        type="button"
                                        onClick={() => setActiveId(option.id)}
                                        className={cn(
                                            "flex h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-left font-semibold text-sm transition-colors active:bg-general-secondary",
                                            // A filter that's narrowing results
                                            // reads at full contrast; the rest
                                            // stay muted so the set ones stand
                                            // out.
                                            isSet
                                                ? "text-general-foreground"
                                                : "text-general-secondary-foreground",
                                        )}
                                    >
                                        <span className="min-w-0 flex-1 truncate">
                                            {option.label}
                                        </span>
                                        <Icon
                                            icon={ArrowRight01Icon}
                                            className="shrink-0 text-general-secondary-foreground"
                                        />
                                    </button>
                                );
                            })}
                            <div className="p-3">
                                <Button
                                    variant="secondary"
                                    className="h-10 w-full rounded-lg font-bold text-general-secondary-foreground text-sm"
                                    disabled={setOptionIds.length === 0}
                                    onClick={resetFilters}
                                >
                                    {tF("reset")}
                                </Button>
                            </div>
                        </div>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

/**
 * A "<name>: <comparison>" heading plus the comparisons it drills into. The
 * filter itself always supplies one; the token editor adds a second for its
 * amount bound, which borrows the same heading while it's open.
 */
interface OperationPicker {
    label: string;
    operation: string;
    operations: readonly string[];
    onChange: (operation: string) => void;
}

/**
 * Which comparison list is currently taking over the sheet body, if any. Owned
 * by the editor rather than the frame so the body can open one of its own.
 */
function useOperationPicker() {
    const [active, setActive] = useState<OperationPicker | null>(null);

    return { active, open: setActive, close: () => setActive(null) };
}

type OperationPickerState = ReturnType<typeof useOperationPicker>;

/**
 * The chrome every filter editor shares. The heading names the filter and the
 * comparison it applies; tapping it swaps the body for the list of comparisons.
 * Filters with only one still print it — there is just nothing to drill into.
 */
function FilterSheetFrame({
    own,
    picker,
    onBack,
    children,
}: {
    own: OperationPicker;
    picker: OperationPickerState;
    onBack: () => void;
    children: React.ReactNode;
}) {
    const tCommon = useTranslations("common");
    const operationLabel = useOperationLabel();
    const heading = picker.active ?? own;
    const canDrillIn = heading.operations.length > 1;

    const title = (
        <DialogTitle asChild>
            <span className="truncate font-semibold text-base leading-[1.2]">
                {`${heading.label}: ${operationLabel(heading.operation)}`}
            </span>
        </DialogTitle>
    );

    return (
        <>
            <div className="flex shrink-0 items-center justify-between px-5 py-4">
                {/* The title only becomes a control where there is a second
                    comparison to switch to. */}
                {canDrillIn ? (
                    <button
                        type="button"
                        onClick={() =>
                            picker.active ? picker.close() : picker.open(own)
                        }
                        className="flex min-w-0 cursor-pointer items-center gap-1 text-left"
                    >
                        {title}
                        <Icon
                            icon={ArrowDown01Icon}
                            className="size-4 shrink-0"
                        />
                    </button>
                ) : (
                    title
                )}
                <button
                    type="button"
                    onClick={() => (picker.active ? picker.close() : onBack())}
                    aria-label={tCommon("back")}
                    className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm text-general-muted-foreground transition-colors active:bg-general-secondary"
                >
                    <Icon icon={Cancel01Icon} className="size-[13.25px]" />
                </button>
            </div>
            {picker.active ? (
                <OperationList
                    picker={picker.active}
                    onSelect={(operation) => {
                        picker.active?.onChange(operation);
                        picker.close();
                    }}
                />
            ) : (
                children
            )}
        </>
    );
}

/** The comparison list a heading drills into; picking one returns to the editor. */
function OperationList({
    picker,
    onSelect,
}: {
    picker: OperationPicker;
    onSelect: (operation: string) => void;
}) {
    const operationLabel = useOperationLabel();

    return (
        <div className="flex flex-col px-1 pb-3">
            {picker.operations.map((operation) => (
                <button
                    key={operation}
                    type="button"
                    onClick={() => onSelect(operation)}
                    className={cn(MENU_ROW_CLASS, "cursor-pointer")}
                >
                    <span className="min-w-0 flex-1 truncate">
                        {operationLabel(operation)}
                    </span>
                    {operation === picker.operation && (
                        <Icon
                            icon={CheckIcon}
                            className="size-5 shrink-0 text-general-foreground"
                        />
                    )}
                </button>
            ))}
        </div>
    );
}

interface FilterEditorProps {
    label: string;
    value: string;
    onApply: (value: string | null) => void;
    onBack: () => void;
}

function FilterSheetBody({
    option,
    ...editorProps
}: FilterEditorProps & { option: EditableFilterOption }) {
    switch (option.id) {
        case "proposal_types":
            return <ProposalTypesSheet id={option.id} {...editorProps} />;
        case "my_vote":
            return <MyVoteSheet id={option.id} {...editorProps} />;
        case "created_date":
            return (
                <CreatedDateSheet
                    id={option.id}
                    minDate={option.minDate}
                    maxDate={option.maxDate}
                    {...editorProps}
                />
            );
        case "token":
            return (
                <TokenSheet
                    id={option.id}
                    hideAmount={option.hideAmount}
                    {...editorProps}
                />
            );
        case "recipients":
        case "proposers":
        case "approvers":
            return (
                <DaoUsersSheet
                    id={option.id}
                    listType={USER_FILTER_LIST_TYPES[option.id]}
                    {...editorProps}
                />
            );
        case "from":
        case "to":
            return (
                <UsersSheet
                    id={option.id}
                    accountIds={(option.options ?? []).map(
                        (choice) => choice.value,
                    )}
                    {...editorProps}
                />
            );
    }
}

/** Full-width confirm that pins to the bottom of every editor. */
function DoneButton({
    onClick,
    disabled,
}: {
    onClick: () => void;
    disabled?: boolean;
}) {
    const tCommon = useTranslations("common");
    return (
        <div className="shrink-0 px-3 pt-2 pb-3">
            <Button
                className="h-10 w-full rounded-lg"
                disabled={disabled}
                onClick={onClick}
            >
                {tCommon("done")}
            </Button>
        </div>
    );
}

/** Seeds an editor's draft comparison from what the URL already carries. */
function useDraftOperation(value: string, id: EditableFilterId) {
    const operations = FILTER_OPERATIONS[id];
    const [operation, setOperation] = useState(
        () => parseFilterData(value)?.operation ?? operations[0],
    );

    return { operation, setOperation, operations };
}

/**
 * The editor behind every "pick some of these" filter (request type, my vote):
 * a flat checkbox list that writes the `{ operation, selected }` shape the
 * desktop pills use.
 */
function ChecklistSheet({
    id,
    label,
    value,
    options,
    onApply,
    onBack,
}: FilterEditorProps & {
    id: EditableFilterId;
    options: ChecklistOption[];
}) {
    const rowIdPrefix = useId();
    const picker = useOperationPicker();
    const { operation, setOperation, operations } = useDraftOperation(
        value,
        id,
    );
    const [selected, setSelected] = useState<string[]>(
        () => parseFilterData<ChecklistFilterData>(value)?.selected ?? [],
    );

    const toggle = (optionValue: string) =>
        setSelected((current) =>
            current.includes(optionValue)
                ? current.filter((item) => item !== optionValue)
                : [...current, optionValue],
        );

    return (
        <FilterSheetFrame
            own={{
                label,
                operation,
                operations,
                onChange: setOperation,
            }}
            picker={picker}
            onBack={onBack}
        >
            <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col px-1 pb-2">
                    {options.map((option) => (
                        <label
                            key={option.value}
                            htmlFor={`${rowIdPrefix}-${option.value}`}
                            className={cn(MENU_ROW_CLASS, "cursor-pointer")}
                        >
                            <Checkbox
                                id={`${rowIdPrefix}-${option.value}`}
                                checked={selected.includes(option.value)}
                                onCheckedChange={() => toggle(option.value)}
                                className="shrink-0"
                            />
                            {option.label}
                        </label>
                    ))}
                </div>
            </ScrollArea>
            <DoneButton
                onClick={() =>
                    onApply(
                        selected.length
                            ? JSON.stringify({
                                  operation,
                                  selected,
                              } satisfies ChecklistFilterData)
                            : null,
                    )
                }
            />
        </FilterSheetFrame>
    );
}

function ProposalTypesSheet(
    props: FilterEditorProps & { id: EditableFilterId },
) {
    const options = useProposalTypeOptions();

    return <ChecklistSheet options={options} {...props} />;
}

function MyVoteSheet(props: FilterEditorProps & { id: EditableFilterId }) {
    const options = useMyVoteOptions();

    return <ChecklistSheet options={options} {...props} />;
}

/** `UsersSheet` over the accounts this treasury actually has for the filter. */
function DaoUsersSheet({
    listType,
    ...props
}: FilterEditorProps & { id: EditableFilterId; listType: UserListType }) {
    const { treasuryId } = useTreasury();
    const { users } = useDaoUsers(treasuryId ?? null, listType);

    return <UsersSheet accountIds={users} {...props} />;
}

function CreatedDateSheet({
    id,
    label,
    value,
    minDate,
    maxDate,
    onApply,
    onBack,
}: FilterEditorProps & {
    id: EditableFilterId;
    minDate?: Date;
    maxDate?: Date;
}) {
    const presets = useDatePresets(CREATED_DATE_PRESETS);
    const picker = useOperationPicker();
    const { operation, setOperation, operations } = useDraftOperation(
        value,
        id,
    );
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
                operation,
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
        <FilterSheetFrame
            own={{ label, operation, operations, onChange: setOperation }}
            picker={picker}
            onBack={onBack}
        >
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
        </FilterSheetFrame>
    );
}

/**
 * Picking a token doesn't close the sheet: the design keeps it open on the
 * chosen token so the amount bound can be narrowed in the same visit, then
 * confirmed with one "Done".
 */
function TokenSheet({
    id,
    label,
    value,
    hideAmount,
    onApply,
    onBack,
}: FilterEditorProps & { id: EditableFilterId; hideAmount?: boolean }) {
    const t = useTranslations("tokenSelect");
    const tF = useTranslations("requests.filters");
    const operationLabel = useOperationLabel();
    const picker = useOperationPicker();
    const { operation, setOperation, operations } = useDraftOperation(
        value,
        id,
    );
    const parsed = parseFilterData<TokenFilterData>(value);
    const [token, setToken] = useState<TokenOption | undefined>(parsed?.token);
    const [amountOperation, setAmountOperation] = useState(
        parsed?.amountOperation ?? AMOUNT_OPERATIONS[0],
    );
    const [minAmount, setMinAmount] = useState(parsed?.minAmount ?? "");
    const [maxAmount, setMaxAmount] = useState(parsed?.maxAmount ?? "");
    const [search, setSearch] = useState("");
    const { tokens, isLoading } = useBridgeTokenOptions();
    const filteredTokens = useFilteredTokenOptions(tokens, search);

    // Only "Is" narrows by amount — see `convertUrlParamsToApiFilters`, which
    // drops the bounds entirely for "Is Not".
    const showsAmount = !hideAmount && operation === "Is";
    const isRange = amountOperation === "Between";

    const handleDone = () => {
        if (!token) {
            onApply(null);
            return;
        }
        onApply(
            JSON.stringify({
                operation,
                token,
                ...(showsAmount && {
                    amountOperation,
                    minAmount,
                    maxAmount: isRange ? maxAmount : "",
                }),
            } satisfies TokenFilterData),
        );
    };

    return (
        <FilterSheetFrame
            own={{ label, operation, operations, onChange: setOperation }}
            picker={picker}
            onBack={onBack}
        >
            {token ? (
                <>
                    <ScrollArea className="min-h-0 flex-1">
                        {/* Tapping the chosen token reopens the catalogue. */}
                        <div className="px-1">
                            <TokenRow
                                token={token}
                                onClick={() => setToken(undefined)}
                            />
                        </div>
                        {showsAmount && (
                            <>
                                <button
                                    type="button"
                                    onClick={() =>
                                        picker.open({
                                            label: tF("amount"),
                                            operation: amountOperation,
                                            operations: AMOUNT_OPERATIONS,
                                            onChange: setAmountOperation,
                                        })
                                    }
                                    className="flex w-full cursor-pointer items-center gap-1 px-4 py-3 text-left font-semibold text-base leading-[1.2]"
                                >
                                    {`${tF("amount")}: ${operationLabel(amountOperation)}`}
                                    <Icon
                                        icon={ArrowDown01Icon}
                                        className="size-4 shrink-0"
                                    />
                                </button>
                                <div className="flex flex-col gap-3 p-4">
                                    <Input
                                        type="number"
                                        inputMode="decimal"
                                        placeholder={
                                            isRange ? tF("from") : tF("amount")
                                        }
                                        value={minAmount}
                                        onChange={(event) =>
                                            setMinAmount(event.target.value)
                                        }
                                        inputClassName={AMOUNT_INPUT_CLASS}
                                    />
                                    {isRange && (
                                        <Input
                                            type="number"
                                            inputMode="decimal"
                                            placeholder={tF("to")}
                                            value={maxAmount}
                                            onChange={(event) =>
                                                setMaxAmount(event.target.value)
                                            }
                                            inputClassName={AMOUNT_INPUT_CLASS}
                                        />
                                    )}
                                </div>
                            </>
                        )}
                    </ScrollArea>
                    <DoneButton onClick={handleDone} />
                </>
            ) : (
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
                        <div className="flex flex-col gap-2 px-1 pb-2">
                            {filteredTokens.map((option) => (
                                <TokenRow
                                    key={option.id}
                                    token={option}
                                    onClick={() => setToken(option)}
                                />
                            ))}
                            {!isLoading && filteredTokens.length === 0 && (
                                <p className="py-4 text-center text-muted-foreground text-sm">
                                    {t("noTokensFound")}
                                </p>
                            )}
                        </div>
                    </ScrollArea>
                </>
            )}
        </FilterSheetFrame>
    );
}

function TokenRow({
    token,
    onClick,
}: {
    token: TokenOption;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex cursor-pointer items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors active:bg-general-secondary"
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
    id,
    label,
    value,
    accountIds,
    onApply,
    onBack,
}: FilterEditorProps & { id: EditableFilterId; accountIds: string[] }) {
    const tF = useTranslations("requests.filters");
    const rowIdPrefix = useId();
    const picker = useOperationPicker();
    const { operation, setOperation, operations } = useDraftOperation(
        value,
        id,
    );
    const [search, setSearch] = useState("");
    const initialSelected = useMemo(
        () => parseFilterData<UserFilterData>(value)?.users ?? [],
        [value],
    );
    const [selected, setSelected] = useState<string[]>(initialSelected);

    // Already-filtered accounts open at the top so a long list never hides the
    // current selection. The order is pinned to what arrived from the URL:
    // re-sorting on each tap would slide rows out from under the finger.
    const visibleAccountIds = useMemo(() => {
        const query = search.toLowerCase();
        return accountIds
            .filter((accountId) => accountId.toLowerCase().includes(query))
            .sort((a, b) => {
                const aSelected = initialSelected.includes(a);
                const bSelected = initialSelected.includes(b);
                if (aSelected !== bSelected) return aSelected ? -1 : 1;
                return a.localeCompare(b);
            });
    }, [accountIds, search, initialSelected]);

    const toggle = (accountId: string) =>
        setSelected((current) =>
            current.includes(accountId)
                ? current.filter((id) => id !== accountId)
                : [...current, accountId],
        );

    return (
        <FilterSheetFrame
            own={{ label, operation, operations, onChange: setOperation }}
            picker={picker}
            onBack={onBack}
        >
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
                    {visibleAccountIds.map((accountId) => (
                        <label
                            key={accountId}
                            htmlFor={`${rowIdPrefix}-${accountId}`}
                            className="flex cursor-pointer items-center gap-2 py-2"
                        >
                            <Checkbox
                                id={`${rowIdPrefix}-${accountId}`}
                                checked={selected.includes(accountId)}
                                onCheckedChange={() => toggle(accountId)}
                                className="shrink-0"
                            />
                            <span className="min-w-0">
                                <User
                                    accountId={accountId}
                                    withLink={false}
                                    size="lg"
                                    highlightQuery={search}
                                />
                            </span>
                        </label>
                    ))}
                    {visibleAccountIds.length === 0 && (
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
                                  operation,
                                  users: selected,
                              } satisfies UserFilterData)
                            : null,
                    )
                }
            />
        </FilterSheetFrame>
    );
}
