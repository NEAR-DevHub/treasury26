"use client";

import { Add01Icon, ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { endOfDay, format, isSameDay, startOfDay } from "date-fns";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { Input } from "@/components/input";
import { OperationSelect } from "@/components/operation-select";
import { TokenSelectPopover } from "@/components/token-select-popover";
import { Checkbox } from "@/components/ui/checkbox";
import {
    type DatePresetKey,
    DateTimePicker,
    useDatePresets,
} from "@/components/ui/datepicker";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { User } from "@/components/user";
import { useRecentAddresses } from "@/hooks/use-recent-addresses";
import { useTreasury } from "@/hooks/use-treasury";
import { cn } from "@/lib/utils";
import { type UserListType, useDaoUsers } from "../hooks/use-dao-users";
import { useFilterParams } from "../hooks/use-filter-params";
import { useFilterState } from "../hooks/use-filter-state";
import { hasFilterValue, parseFilterData } from "../types/filter-types";
import { BaseFilterPopover } from "./base-filter-popover";
import { CheckboxFilterContent } from "./checkbox-filter-content";

const PROPOSAL_TYPE_OPTIONS = [
    "Payments",
    "Exchange",
    "Earn",
    "Vesting",
    "Function Call",
    "Change Policy",
    "Settings",
];

// When a treasury is confidential and the viewer is not a member, the subtype
// of confidential proposals (payment vs exchange) cannot be revealed. Collapse
// Payments + Exchange into a single "Confidential" option.
const CONFIDENTIAL_GUEST_PROPOSAL_TYPE_OPTIONS = [
    "Confidential",
    "Earn",
    "Vesting",
    "Function Call",
    "Change Policy",
    "Settings",
];

const MY_VOTE_OPTIONS = ["Approved", "Rejected", "No Voted"];
const MY_VOTE_OPERATIONS = ["Is"];

const TOKEN_OPERATIONS = ["Is", "Is Not"];
const AMOUNT_OPERATIONS = ["Between", "Equal", "More Than", "Less Than"];

const PROPOSAL_TYPE_OPERATIONS = ["Is", "Is Not"];
const DATE_OPERATIONS = ["Is"];
export const CREATED_DATE_PRESETS: readonly DatePresetKey[] = [
    "today",
    "yesterday",
    "last7Days",
    "last14Days",
    "lastMonth",
    "last3Months",
    "last6Months",
];
const USER_OPERATIONS = ["Is", "Is Not"];
const FROM_OPERATIONS = ["Is", "Is Not"];

/** Shared chrome for the filter row's buttons (Reset, the active filter pills,
 * Add filter): 12px radius, and a label that darkens on hover. */
const FILTER_BUTTON_CLASS =
    "text-muted-foreground hover:text-general-unofficial-ghost-foreground h-9 shrink-0 rounded-lg px-3 leading-none font-bold";
/** The #F2F2F2 surface those buttons sit on; the dark theme keeps `secondary`. */
const FILTER_BUTTON_SURFACE_CLASS =
    "bg-[#F2F2F2] hover:bg-[#F2F2F2] dark:bg-secondary dark:hover:bg-secondary/80";

interface TokenOption {
    id: string;
    name: string;
    icon?: string;
    gradient?: string;
}

export interface FilterOption {
    id: string;
    label: string;
    minDate?: Date;
    maxDate?: Date;
    hideAmount?: boolean; // Hide amount fields for this filter (for token filter)
    options?: Array<{ value: string; label: string }>;
}

interface ProposalFiltersProps {
    className?: string;
    filterOptions: FilterOption[];
}

export function ProposalFilters({
    className,
    filterOptions,
}: ProposalFiltersProps) {
    const tF = useTranslations("requests.filters");
    const { searchParams, setFilters: updateFilters } = useFilterParams();
    const router = useRouter();
    const pathname = usePathname();
    const [isAddFilterOpen, setIsAddFilterOpen] = useState(false);

    const activeFilters = useMemo(() => {
        const filters: string[] = [];
        filterOptions.forEach((opt) => {
            if (searchParams.has(opt.id)) {
                filters.push(opt.id);
            }
        });
        return filters;
    }, [searchParams, filterOptions]);

    const resetFilters = () => {
        const params = new URLSearchParams();
        const tab = searchParams.get("tab");
        if (tab) params.set("tab", tab);
        router.push(`${pathname}?${params.toString()}`);
    };

    const removeFilter = (id: string) => {
        updateFilters({ [id]: null });
    };

    const availableFilters = filterOptions.filter(
        (opt) => !activeFilters.includes(opt.id),
    );

    return (
        <div className={cn("flex items-center gap-2", className)}>
            <Button
                variant="secondary"
                size="sm"
                onClick={resetFilters}
                className={cn(FILTER_BUTTON_CLASS, FILTER_BUTTON_SURFACE_CLASS)}
            >
                {tF("reset")}
            </Button>

            <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide">
                {activeFilters.map((filterId) => {
                    const filterOption = filterOptions.find(
                        (o) => o.id === filterId,
                    );
                    return (
                        <FilterPill
                            key={filterId}
                            id={filterId}
                            label={filterOption?.label || ""}
                            value={searchParams.get(filterId) || ""}
                            onRemove={() => removeFilter(filterId)}
                            onUpdate={(val) =>
                                updateFilters({ [filterId]: val })
                            }
                            minDate={filterOption?.minDate}
                            maxDate={filterOption?.maxDate}
                            hideAmount={filterOption?.hideAmount}
                            options={filterOption?.options}
                        />
                    );
                })}

                {availableFilters.length > 0 && (
                    <Popover
                        open={isAddFilterOpen}
                        onOpenChange={setIsAddFilterOpen}
                    >
                        <PopoverTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className={cn(FILTER_BUTTON_CLASS, "gap-1.5")}
                            >
                                <Icon
                                    icon={Add01Icon}
                                    className="size-[13.25px]"
                                />
                                {tF("addFilter")}
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent
                            className="border-general-border w-fit min-w-[123px] rounded-xl p-1.5"
                            align="start"
                        >
                            <div className="flex flex-col gap-0.5">
                                {availableFilters.map((filter) => (
                                    <Button
                                        key={filter.id}
                                        variant="ghost"
                                        size="sm"
                                        className="text-muted-foreground h-8 justify-start px-4 font-semibold"
                                        onClick={() => {
                                            updateFilters({ [filter.id]: "" });
                                            setIsAddFilterOpen(false);
                                        }}
                                    >
                                        {filter.label}
                                    </Button>
                                ))}
                            </div>
                        </PopoverContent>
                    </Popover>
                )}
            </div>
        </div>
    );
}

interface FilterPillProps {
    id: string;
    label: string;
    value: string;
    onRemove: () => void;
    onUpdate: (value: string) => void;
    minDate?: Date;
    maxDate?: Date;
    hideAmount?: boolean;
    options?: Array<{ value: string; label: string }>;
}

function FilterPill({
    id,
    label,
    value,
    onRemove,
    onUpdate,
    minDate,
    maxDate,
    hideAmount,
    options,
}: FilterPillProps) {
    const tF = useTranslations("requests.filters");
    const [isOpen, setIsOpen] = useState(false);

    // Single unified parsing - no backward compatibility
    const filterData = useMemo(() => {
        return parseFilterData(value);
    }, [value]);

    /** A freshly added filter carries no value yet: it shows as a bare label
     * ("Token") until something is picked, and filters nothing in the meantime. */
    const hasValue = useMemo(() => hasFilterValue(value), [value]);

    /** Overlapping avatar stack used by the user-shaped pills (from/to and
     * recipients/proposers/approvers). */
    const renderUserStack = (users: string[], visible: number) => (
        <span className="flex items-center">
            {users.slice(0, visible).map((accountId) => (
                <span
                    key={accountId}
                    className="border-general-border bg-card inline-flex rounded-full border not-first:-ml-[7px]"
                >
                    <User
                        accountId={accountId}
                        variant="avatar"
                        size="sm"
                        withLink={false}
                    />
                </span>
            ))}
            {users.length > visible && (
                <span className="ml-1">+{users.length - visible}</span>
            )}
        </span>
    );

    const renderFilterContent = () => {
        switch (id) {
            case "recipients":
                return (
                    <UserFilterContent
                        value={value}
                        onUpdate={onUpdate}
                        setIsOpen={setIsOpen}
                        onRemove={onRemove}
                        label={label}
                    />
                );
            case "proposers":
                return (
                    <UserFilterContent
                        value={value}
                        onUpdate={onUpdate}
                        setIsOpen={setIsOpen}
                        onRemove={onRemove}
                        label={label}
                    />
                );
            case "approvers":
                return (
                    <UserFilterContent
                        value={value}
                        onUpdate={onUpdate}
                        setIsOpen={setIsOpen}
                        onRemove={onRemove}
                        label={label}
                    />
                );
            case "proposal_types":
                return (
                    <ProposalTypeFilterContent
                        value={value}
                        onUpdate={onUpdate}
                        setIsOpen={setIsOpen}
                        onRemove={onRemove}
                    />
                );
            case "created_date":
                return (
                    <CreatedDateFilterContent
                        value={value}
                        onUpdate={onUpdate}
                        setIsOpen={setIsOpen}
                        onRemove={onRemove}
                        minDate={minDate}
                        maxDate={maxDate}
                    />
                );
            case "token":
                return (
                    <TokenFilterContent
                        value={value}
                        onUpdate={onUpdate}
                        setIsOpen={setIsOpen}
                        onRemove={onRemove}
                        hideAmount={hideAmount}
                    />
                );
            case "my_vote":
                return (
                    <MyVoteFilterContent
                        value={value}
                        onUpdate={onUpdate}
                        setIsOpen={setIsOpen}
                        onRemove={onRemove}
                    />
                );
            case "from":
                return (
                    <UserFilterContent
                        value={value}
                        onUpdate={onUpdate}
                        setIsOpen={setIsOpen}
                        onRemove={onRemove}
                        label={tF("from")}
                        operations={FROM_OPERATIONS}
                        suggestedUsers={(options || []).map(
                            (option) => option.value,
                        )}
                    />
                );
            case "to":
                return (
                    <UserFilterContent
                        value={value}
                        onUpdate={onUpdate}
                        setIsOpen={setIsOpen}
                        onRemove={onRemove}
                        label={tF("to")}
                        operations={FROM_OPERATIONS}
                        suggestedUsers={(options || []).map(
                            (option) => option.value,
                        )}
                    />
                );
        }
    };

    const getOperationSuffix = () => {
        if (!filterData?.operation) return "";
        const op = filterData.operation;
        if (op === "Is Not") return tF("operationIsNot");
        if (op === "Before") return tF("operationBefore");
        if (op === "After") return tF("operationAfter");
        if (op === "Contains") return tF("operationContains");
        return "";
    };

    /** Only rendered once `hasValue` is true, so every branch here has
     * something concrete to show. */
    const renderFilterDisplay = () => {
        if (!filterData) return null;

        // Token filter display
        if (id === "token" && (filterData as any).token) {
            const { operation, token, amountOperation, minAmount, maxAmount } =
                filterData as any;
            let amountDisplay = "";
            if (operation === "Is" && (minAmount || maxAmount)) {
                if (amountOperation === "Between" && minAmount && maxAmount) {
                    amountDisplay = ` ${minAmount}-${maxAmount}`;
                } else if (amountOperation === "Equal" && minAmount) {
                    amountDisplay = ` = ${minAmount}`;
                } else if (amountOperation === "More Than" && minAmount) {
                    amountDisplay = ` > ${minAmount}`;
                } else if (amountOperation === "Less Than" && minAmount) {
                    amountDisplay = ` < ${minAmount}`;
                }
            }

            return (
                <span>
                    {amountDisplay && `${amountDisplay} `}
                    {(token.id ?? token.name ?? "").toUpperCase()}
                </span>
            );
        }

        // My Vote filter display
        if (id === "my_vote" && (filterData as any).selected) {
            const selected = (filterData as any).selected as string[];
            return (
                <span>
                    {selected
                        .map((v) =>
                            tF(
                                `voteStatus.${v}` as
                                    | "voteStatus.Approved"
                                    | "voteStatus.Rejected"
                                    | "voteStatus.No Voted",
                            ),
                        )
                        .join(", ")}
                </span>
            );
        }

        if (id === "from" || id === "to") {
            const users = (filterData as any).users;
            if (Array.isArray(users)) return renderUserStack(users, 3);
            return <span>{users}</span>;
        }

        // Proposal Type filter display
        if (id === "proposal_types" && (filterData as any).selected) {
            const selected = (filterData as any).selected as string[];
            return (
                <span>
                    {selected
                        .map((v) =>
                            tF(
                                `proposalTypes.${v}` as
                                    | "proposalTypes.Payments"
                                    | "proposalTypes.Exchange"
                                    | "proposalTypes.Earn"
                                    | "proposalTypes.Vesting"
                                    | "proposalTypes.Function Call"
                                    | "proposalTypes.Change Policy"
                                    | "proposalTypes.Settings"
                                    | "proposalTypes.Confidential",
                            ),
                        )
                        .join(", ")}
                </span>
            );
        }

        // Date filter display
        if (id === "created_date" && (filterData as any).dateRange) {
            try {
                const { from, to } = (filterData as any).dateRange;
                if (from && to && !isSameDay(new Date(from), new Date(to))) {
                    return (
                        <span>
                            {format(new Date(from), "MMM d, yyyy")} -{" "}
                            {format(new Date(to), "MMM d, yyyy")}
                        </span>
                    );
                } else if (from) {
                    return <span>{format(new Date(from), "MMM d, yyyy")}</span>;
                }
            } catch {
                return <span>{tF("invalidDate")}</span>;
            }
        }

        // User filter display (recipients, proposers, approvers)
        if (
            (id === "recipients" || id === "proposers" || id === "approvers") &&
            (filterData as any).users
        ) {
            const users = (filterData as any).users as string[];
            return renderUserStack(users, 3);
        }

        return null;
    };

    return (
        <div className="flex items-center shrink-0">
            <Popover open={isOpen} onOpenChange={setIsOpen}>
                <PopoverTrigger asChild>
                    <Button
                        variant="secondary"
                        size="sm"
                        className={cn(
                            FILTER_BUTTON_CLASS,
                            FILTER_BUTTON_SURFACE_CLASS,
                            "gap-1.5",
                        )}
                    >
                        {hasValue ? (
                            <>
                                <span>
                                    {label}
                                    {getOperationSuffix()}:
                                </span>
                                {renderFilterDisplay()}
                            </>
                        ) : (
                            <span>{label}</span>
                        )}
                        <Icon
                            icon={ArrowDown01Icon}
                            className="size-[13.25px]"
                        />
                    </Button>
                </PopoverTrigger>
                <PopoverContent
                    className="border-general-border w-fit max-w-none rounded-xl p-1.5"
                    align="start"
                >
                    {renderFilterContent()}
                </PopoverContent>
            </Popover>
        </div>
    );
}

interface TokenFilterContentProps {
    value: string;
    onUpdate: (value: string) => void;
    setIsOpen: (isOpen: boolean) => void;
    onRemove: () => void;
    hideAmount?: boolean;
}

interface TokenData {
    token: TokenOption;
    amountOperation?: string;
    minAmount?: string;
    maxAmount?: string;
}

function TokenFilterContent({
    value,
    onUpdate,
    setIsOpen,
    onRemove,
    hideAmount,
}: TokenFilterContentProps) {
    const tF = useTranslations("requests.filters");
    const { operation, setOperation, data, setData } =
        useFilterState<TokenData>({
            value,
            onUpdate,
            parseData: (parsed) => ({
                token: parsed.token,
                amountOperation: parsed.amountOperation || "Between",
                minAmount: parsed.minAmount || "",
                maxAmount: parsed.maxAmount || "",
            }),
            serializeData: (op, d) => ({
                operation: op,
                token: d.token,
                ...(op === "Is" &&
                    !hideAmount && {
                        amountOperation: d.amountOperation,
                        minAmount: d.minAmount,
                        maxAmount: d.maxAmount,
                    }),
            }),
        });

    const handleDelete = () => {
        onRemove();
        setIsOpen(false);
    };

    const updateData = (updates: Partial<TokenData>) => {
        setData({
            token: updates.token ?? (data?.token as any),
            amountOperation:
                updates.amountOperation ?? data?.amountOperation ?? "Between",
            minAmount: updates.minAmount ?? data?.minAmount ?? "",
            maxAmount: updates.maxAmount ?? data?.maxAmount ?? "",
        });
    };

    return (
        <BaseFilterPopover
            filterLabel={tF("token")}
            operation={operation}
            operations={TOKEN_OPERATIONS}
            onOperationChange={setOperation}
            onDelete={handleDelete}
            className="w-[248px]"
        >
            <TokenSelectPopover
                selectedToken={data?.token || null}
                onTokenChange={(token) => updateData({ token })}
                className="w-full"
            />

            {!hideAmount && data?.token && operation === "Is" && (
                <>
                    <div className="py-2 px-2 flex items-baseline gap-1">
                        <span className="text-xs  text-muted-foreground">
                            {tF("amount")}
                        </span>
                        <OperationSelect
                            operations={AMOUNT_OPERATIONS}
                            selectedOperation={
                                data.amountOperation || "Between"
                            }
                            onOperationChange={(op) =>
                                updateData({ amountOperation: op })
                            }
                        />
                    </div>

                    <div className="px-2 py-1">
                        {data.amountOperation === "Between" ? (
                            <div className="flex-col flex gap-2">
                                <div className="flex flex-col gap-1">
                                    <span className="text-sm text-foreground font-medium">
                                        {tF("from")}
                                    </span>
                                    <Input
                                        type="number"
                                        placeholder={tF("min")}
                                        value={data.minAmount || ""}
                                        onChange={(e) =>
                                            updateData({
                                                minAmount: e.target.value,
                                            })
                                        }
                                        className="h-8 text-sm"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className="text-sm text-foreground font-medium">
                                        {tF("to")}
                                    </span>
                                    <Input
                                        type="number"
                                        placeholder={tF("max")}
                                        value={data.maxAmount || ""}
                                        onChange={(e) =>
                                            updateData({
                                                maxAmount: e.target.value,
                                            })
                                        }
                                        className="h-8 text-sm"
                                    />
                                </div>
                            </div>
                        ) : (
                            <Input
                                type="number"
                                placeholder={tF("amount")}
                                value={data.minAmount || ""}
                                onChange={(e) =>
                                    updateData({ minAmount: e.target.value })
                                }
                                className="h-8 text-sm"
                            />
                        )}
                    </div>
                </>
            )}
        </BaseFilterPopover>
    );
}

// My Vote filter using unified CheckboxFilterContent
function MyVoteFilterContent({
    value,
    onUpdate,
    setIsOpen,
    onRemove,
}: {
    value: string;
    onUpdate: (value: string) => void;
    setIsOpen: (isOpen: boolean) => void;
    onRemove: () => void;
}) {
    const tF = useTranslations("requests.filters");
    return (
        <CheckboxFilterContent
            value={value}
            onUpdate={onUpdate}
            setIsOpen={setIsOpen}
            onRemove={onRemove}
            filterLabel={tF("myVoteStatus")}
            operations={MY_VOTE_OPERATIONS}
            options={MY_VOTE_OPTIONS.map((vote) => ({
                value: vote,
                label: tF(
                    `voteStatus.${vote}` as
                        | "voteStatus.Approved"
                        | "voteStatus.Rejected"
                        | "voteStatus.No Voted",
                ),
            }))}
        />
    );
}

// Proposal Type filter using unified CheckboxFilterContent
function ProposalTypeFilterContent({
    value,
    onUpdate,
    setIsOpen,
    onRemove,
}: {
    value: string;
    onUpdate: (value: string) => void;
    setIsOpen: (isOpen: boolean) => void;
    onRemove: () => void;
}) {
    const tF = useTranslations("requests.filters");
    const { isConfidential, isGuestTreasury } = useTreasury();
    const options =
        isConfidential && isGuestTreasury
            ? CONFIDENTIAL_GUEST_PROPOSAL_TYPE_OPTIONS
            : PROPOSAL_TYPE_OPTIONS;
    return (
        <CheckboxFilterContent
            value={value}
            onUpdate={onUpdate}
            setIsOpen={setIsOpen}
            onRemove={onRemove}
            filterLabel={tF("requestsType")}
            operations={PROPOSAL_TYPE_OPERATIONS}
            options={options.map((type) => ({
                value: type,
                label: tF(
                    `proposalTypes.${type}` as
                        | "proposalTypes.Payments"
                        | "proposalTypes.Exchange"
                        | "proposalTypes.Earn"
                        | "proposalTypes.Vesting"
                        | "proposalTypes.Function Call"
                        | "proposalTypes.Change Policy"
                        | "proposalTypes.Settings"
                        | "proposalTypes.Confidential",
                ),
            }))}
        />
    );
}

interface CreatedDateFilterContentProps {
    value: string;
    onUpdate: (value: string) => void;
    setIsOpen: (isOpen: boolean) => void;
    onRemove: () => void;
    minDate?: Date;
    maxDate?: Date;
}

interface DateData {
    dateRange: {
        from: Date | undefined;
        to?: Date | undefined;
    };
}

function CreatedDateFilterContent({
    value,
    onUpdate,
    setIsOpen,
    onRemove,
    minDate,
    maxDate,
}: CreatedDateFilterContentProps) {
    const tF = useTranslations("requests.filters");
    const { operation, setOperation, data, setData, handleClear } =
        useFilterState<DateData>({
            value,
            onUpdate,
            parseData: (parsed) => ({
                dateRange: parsed.dateRange
                    ? {
                          from: parsed.dateRange.from
                              ? new Date(parsed.dateRange.from)
                              : undefined,
                          to: parsed.dateRange.to
                              ? new Date(parsed.dateRange.to)
                              : undefined,
                      }
                    : {
                          from: undefined,
                          to: undefined,
                      },
            }),
            serializeData: (op, d) => ({
                operation: op,
                dateRange: d.dateRange
                    ? {
                          from: d.dateRange.from?.toISOString(),
                          to: d.dateRange.to?.toISOString(),
                      }
                    : undefined,
            }),
        });

    const handleDelete = () => {
        onRemove();
        setIsOpen(false);
    };

    const defaultMonth = useMemo(() => {
        if (data?.dateRange?.from) {
            return data.dateRange.from;
        }
        return startOfDay(new Date());
    }, [data?.dateRange?.from]);

    const presets = useDatePresets(CREATED_DATE_PRESETS);

    return (
        <BaseFilterPopover
            filterLabel={tF("createdDate")}
            operation={operation}
            operations={DATE_OPERATIONS}
            onOperationChange={setOperation}
            onClear={handleClear}
            onDelete={handleDelete}
            className="w-[432px]"
        >
            <div className="flex w-full">
                <div className="flex h-full w-full items-start justify-center">
                    <DateTimePicker
                        mode="range"
                        presets={presets}
                        value={
                            data?.dateRange
                                ? {
                                      from: data?.dateRange.from,
                                      to: data?.dateRange.to,
                                  }
                                : undefined
                        }
                        onChange={(range) => {
                            if (
                                range &&
                                typeof range === "object" &&
                                "from" in range
                            ) {
                                setData({
                                    dateRange: {
                                        from: range.from
                                            ? startOfDay(range.from)
                                            : undefined,
                                        to: range.to
                                            ? endOfDay(range.to)
                                            : undefined,
                                    },
                                });
                            } else {
                                setData({
                                    dateRange: {
                                        from: undefined,
                                        to: undefined,
                                    },
                                });
                            }
                        }}
                        defaultMonth={defaultMonth}
                        numberOfMonths={1}
                        min={minDate}
                        max={maxDate}
                    />
                </div>
            </div>
        </BaseFilterPopover>
    );
}

interface UserFilterContentProps {
    value: string;
    onUpdate: (value: string) => void;
    setIsOpen: (isOpen: boolean) => void;
    onRemove: () => void;
    label: string;
    operations?: string[];
    suggestedUsers?: string[];
}

interface UserData {
    users: string[];
}

function UserFilterContent({
    value,
    onUpdate,
    setIsOpen,
    onRemove,
    label,
    operations = USER_OPERATIONS,
    suggestedUsers,
}: UserFilterContentProps) {
    const tF = useTranslations("requests.filters");
    const { treasuryId } = useTreasury();
    const { recentAddresses, addRecentAddress } = useRecentAddresses();
    const [searchQuery, setSearchQuery] = useState("");

    const { operation, setOperation, data, setData } = useFilterState<UserData>(
        {
            value,
            onUpdate,
            parseData: (parsed) => ({
                users: Array.isArray(parsed.users) ? parsed.users : [],
            }),
            serializeData: (op, d) => ({
                operation: op,
                users: d.users,
            }),
        },
    );

    // Determine which user list type to fetch based on label
    const userListType: UserListType = useMemo(() => {
        if (label === "Requester") return "proposers";
        if (label === "Approver") return "approvers";
        return "members";
    }, [label]);

    const shouldUseSuggestedUsers = !!suggestedUsers;

    // Fetch the appropriate user list using the unified hook
    const { users: fetchedUsers, isLoading: isLoadingMembers } = useDaoUsers(
        shouldUseSuggestedUsers ? null : (treasuryId ?? null),
        userListType,
    );

    // Use fetched users as suggestions
    const memberSuggestions = useMemo(() => {
        return suggestedUsers ?? fetchedUsers;
    }, [suggestedUsers, fetchedUsers]);

    // Combine DAO members with custom addresses and recent addresses, then filter and sort
    const filteredMembers = useMemo(() => {
        const query = searchQuery.toLowerCase();
        const selectedUsers = data?.users || [];

        // Combine DAO members with selected users and recent addresses that aren't already in DAO members
        const allUsers = new Set([
            ...memberSuggestions,
            ...selectedUsers.filter(
                (user) => !memberSuggestions.includes(user),
            ),
            ...recentAddresses.filter(
                (addr) => !memberSuggestions.includes(addr),
            ),
        ]);

        // Filter based on search query, then sort with checked users at top
        return Array.from(allUsers)
            .filter((accountId) => accountId.toLowerCase().includes(query))
            .sort((a, b) => {
                const aSelected = selectedUsers.includes(a);
                const bSelected = selectedUsers.includes(b);

                // 1. Checked users always at the top
                if (aSelected && !bSelected) return -1;
                if (!aSelected && bSelected) return 1;

                // 2. All unchecked users sorted alphabetically together
                return a.toLowerCase().localeCompare(b.toLowerCase());
            });
    }, [memberSuggestions, searchQuery, data?.users, recentAddresses]);

    const handleDelete = () => {
        onRemove();
        setIsOpen(false);
    };

    const handleToggleUser = (accountId: string) => {
        const currentUsers = data?.users || [];
        if (currentUsers.includes(accountId)) {
            setData({ users: currentUsers.filter((u) => u !== accountId) });
        } else {
            const nextValues = [...currentUsers, accountId];
            setData({ users: nextValues });
            addRecentAddress(accountId);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" && searchQuery.trim()) {
            e.preventDefault();
            const accountId = searchQuery.trim();
            const currentValues = data?.users || [];
            if (!currentValues.includes(accountId)) {
                const nextValues = [...currentValues, accountId];
                setData({ users: nextValues });
                addRecentAddress(accountId);
            }
            setSearchQuery("");
        }
    };

    return (
        <BaseFilterPopover
            filterLabel={label}
            operation={operation}
            operations={operations}
            onOperationChange={setOperation}
            onDelete={handleDelete}
            className="w-[268px]"
        >
            <div className="flex flex-col">
                <div className="pb-3">
                    <Input
                        autoFocus
                        placeholder={tF("searchByAddress")}
                        search
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        className="h-9"
                        inputClassName="rounded-xl border border-general-border bg-card! hover:bg-card! pl-9 text-sm placeholder:font-medium placeholder:text-general-muted-foreground focus-visible:border-general-border focus-visible:ring-0"
                        searchIconClassName="left-2 size-5 text-general-muted-foreground"
                    />
                </div>

                {/* Loading state */}
                {!shouldUseSuggestedUsers && isLoadingMembers ? (
                    <div className="text-xs text-muted-foreground text-center py-2">
                        {tF("loadingMembers")}
                    </div>
                ) : (
                    <ScrollArea
                        className="h-80 [&>[data-radix-scroll-area-viewport]>div]:block!"
                        type="always"
                    >
                        {filteredMembers.length > 0 && (
                            <div className="flex flex-col">
                                {filteredMembers.map((accountId) => {
                                    const isSelected =
                                        data?.users?.includes(accountId) ||
                                        false;
                                    return (
                                        <label
                                            key={accountId}
                                            className="hover:bg-muted/50 flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2"
                                        >
                                            <Checkbox
                                                checked={isSelected}
                                                onCheckedChange={() =>
                                                    handleToggleUser(accountId)
                                                }
                                                className="shrink-0"
                                            />
                                            <div className="min-w-0">
                                                <User
                                                    accountId={accountId}
                                                    withLink={false}
                                                    size="lg"
                                                    highlightQuery={searchQuery}
                                                />
                                            </div>
                                        </label>
                                    );
                                })}
                            </div>
                        )}

                        {searchQuery && filteredMembers.length === 0 && (
                            <p className="text-xs text-muted-foreground text-center py-2">
                                {tF("noMembersFound", { query: searchQuery })}
                            </p>
                        )}

                        {!searchQuery && filteredMembers.length === 0 && (
                            <p className="text-xs text-muted-foreground text-center py-2">
                                {tF("noMembersAvailable")}
                            </p>
                        )}
                    </ScrollArea>
                )}
            </div>
        </BaseFilterPopover>
    );
}
