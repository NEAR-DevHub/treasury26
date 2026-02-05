"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/button";
import { Plus, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Input } from "@/components/input";
import { DateTimePicker } from "@/components/ui/datepicker";
import { endOfDay, format, isSameDay, startOfDay, subDays, subMonths } from "date-fns";
import { OperationSelect } from "@/components/operation-select";
import { TokenSelectPopover } from "@/components/token-select-popover";
import { Checkbox } from "@/components/ui/checkbox";
import { BaseFilterPopover } from "./base-filter-popover";
import { useFilterState } from "../hooks/use-filter-state";
import { parseFilterData } from "../types/filter-types";
import { TooltipUser, User } from "@/components/user";
import { useRecentAddresses } from "@/hooks/use-recent-addresses";
import { useTreasury } from "@/hooks/use-treasury";
import { CheckboxFilterContent } from "./checkbox-filter-content";
import { useDaoUsers, UserListType } from "../hooks/use-dao-users";
import { ScrollArea } from "@/components/ui/scroll-area";

const PROPOSAL_TYPE_OPTIONS = [
    "Payments",
    "Exchange",
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
const USER_OPERATIONS = ["Is", "Is Not"];

interface TokenOption {
    id: string;
    name: string;
    symbol: string;
    icon: string;
}

export interface FilterOption {
    id: string;
    label: string;
    minDate?: Date;
    maxDate?: Date;
}

interface ProposalFiltersProps {
    className?: string;
    filterOptions: FilterOption[];
}

export function ProposalFilters({ className, filterOptions }: ProposalFiltersProps) {
    const searchParams = useSearchParams();
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

    const updateFilters = useCallback(
        (updates: Record<string, string | null>) => {
            const params = new URLSearchParams(searchParams.toString());
            Object.entries(updates).forEach(([key, value]) => {
                if (value === null) {
                    params.delete(key);
                } else {
                    params.set(key, value);
                }
            });
            params.delete("page"); // Reset page when filters change
            router.push(`${pathname}?${params.toString()}`);
        },
        [searchParams, router, pathname]
    );

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
        (opt) => !activeFilters.includes(opt.id)
    );

    return (
        <div className={cn("flex items-center gap-3", className)}>
            <Button
                variant="outline"
                size="sm"
                onClick={resetFilters}
                className="h-9 rounded-md px-3 border-none bg-muted/50 hover:bg-muted font-medium"
            >
                Reset
            </Button>

            <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide">
                {activeFilters.map((filterId) => {
                    const filterOption = filterOptions.find((o) => o.id === filterId);
                    return (
                        <FilterPill
                            key={filterId}
                            id={filterId}
                            label={filterOption?.label || ""}
                            value={searchParams.get(filterId) || ""}
                            onRemove={() => removeFilter(filterId)}
                            onUpdate={(val) => updateFilters({ [filterId]: val })}
                            minDate={filterOption?.minDate}
                            maxDate={filterOption?.maxDate}
                        />
                    );
                })}

                {availableFilters.length > 0 && (
                    <Popover open={isAddFilterOpen} onOpenChange={setIsAddFilterOpen}>
                        <PopoverTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 gap-1.5 text-muted-foreground hover:text-foreground font-medium shrink-0"
                            >
                                <Plus className="h-4 w-4" />
                                Add Filter
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-fit p-0 min-w-36" align="start">
                            <div className="flex flex-col">
                                {availableFilters.map((filter) => (
                                    <Button
                                        key={filter.id}
                                        variant="ghost"
                                        className="justify-start px-2 font-normal not-first:rounded-t-none not-last:rounded-b-none"
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
}

function FilterPill({ id, label, value, onRemove, onUpdate, minDate, maxDate }: FilterPillProps) {
    const [isOpen, setIsOpen] = useState(false);

    // Single unified parsing - no backward compatibility
    const filterData = useMemo(() => {
        return parseFilterData(value);
    }, [value]);

    const displayValue = useMemo(() => {
        if (!value || filterData) return 'ALL'; // Use custom rendering for all filter types
        return value;
    }, [value, filterData]);

    const renderFilterContent = () => {
        switch (id) {
            case "recipients":
                return <UserFilterContent value={value} onUpdate={onUpdate} setIsOpen={setIsOpen} onRemove={onRemove} label={label} />;
            case "proposers":
                return <UserFilterContent value={value} onUpdate={onUpdate} setIsOpen={setIsOpen} onRemove={onRemove} label={label} />;
            case "approvers":
                return <UserFilterContent value={value} onUpdate={onUpdate} setIsOpen={setIsOpen} onRemove={onRemove} label={label} />;
            case "proposal_types":
                return <ProposalTypeFilterContent value={value} onUpdate={onUpdate} setIsOpen={setIsOpen} onRemove={onRemove} />;
            case "created_date":
                return <CreatedDateFilterContent value={value} onUpdate={onUpdate} setIsOpen={setIsOpen} onRemove={onRemove} minDate={minDate} maxDate={maxDate} />;
            case "token":
                return <TokenFilterContent value={value} onUpdate={onUpdate} setIsOpen={setIsOpen} onRemove={onRemove} />;
            case "my_vote":
                return <MyVoteFilterContent value={value} onUpdate={onUpdate} setIsOpen={setIsOpen} onRemove={onRemove} />;
        }
    };

    const getOperationSuffix = () => {
        if (!filterData?.operation) return "";
        const op = filterData.operation;
        if (op === "Is Not") return " is not";
        if (op === "Before") return " before";
        if (op === "After") return " after";
        if (op === "Contains") return " contains";
        return "";
    };

    const renderFilterDisplay = () => {
        if (!filterData) return <span className="font-medium">{displayValue}</span>;

        // Token filter display
        if (id === "token" && (filterData as any).token) {
            const { operation, token, amountOperation, minAmount, maxAmount } = filterData as any;
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
                <div className="flex items-center gap-1.5">
                    {token.icon?.startsWith("http") || token.icon?.startsWith("data:") ? (
                        <img src={token.icon} alt={token.symbol} className="w-4 h-4 rounded-full object-contain" />
                    ) : (
                        <div className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[8px] font-bold bg-gradient-cyan-blue">
                            <span>{token.icon}</span>
                        </div>
                    )}
                    {amountDisplay && <span className="text-sm text-foreground">{amountDisplay}</span>}
                    <span className="text-sm text-foreground">{token.symbol}</span>
                </div>
            );
        }

        // My Vote filter display
        if (id === "my_vote" && (filterData as any).selected) {
            const selected = (filterData as any).selected as string[];
            if (selected.length === 0) return 'ALL';
            return <span className="font-medium text-sm">{selected.join(", ")}</span>;
        }

        // Proposal Type filter display
        if (id === "proposal_types" && (filterData as any).selected) {
            const selected = (filterData as any).selected as string[];
            if (selected.length === 0) return 'ALL';
            return <span className="font-medium text-sm">{selected.join(", ")}</span>;
        }

        // Date filter display
        if (id === "created_date" && (filterData as any).dateRange) {
            try {
                const { from, to } = (filterData as any).dateRange;
                if (!from && !to) return 'ALL';
                if (from && to && !isSameDay(new Date(from), new Date(to))) {
                    return <span className="font-medium text-sm">{format(new Date(from), "MMM d, yyyy")} - {format(new Date(to), "MMM d, yyyy")}</span>;
                } else if (from) {
                    return <span className="font-medium text-sm">{format(new Date(from), "MMM d, yyyy")}</span>;
                }
            } catch {
                return <span className="font-medium text-sm">Invalid date</span>;
            }
        }

        // User filter display (recipients, proposers, approvers)
        if ((id === "recipients" || id === "proposers" || id === "approvers") && (filterData as any).users) {
            const users = (filterData as any).users as string[];
            if (users.length === 0) return 'ALL';
            return (
                <div className="flex items-center">
                    {users.slice(0, 3).map((accountId, index) => (
                        <TooltipUser key={accountId} accountId={accountId}>
                            <div className="cursor-pointer" style={{ marginLeft: index > 0 ? '-6px' : '0' }}>
                                <User accountId={accountId} iconOnly withName={false} />
                            </div>
                        </TooltipUser>
                    ))}
                    {users.length > 3 && (
                        <span className="text-xs text-muted-foreground ml-1">+{users.length - 3}</span>
                    )}
                </div>
            );
        }

        return <span className="font-medium">{displayValue}</span>;
    };

    return (
        <div className="flex items-center shrink-0">
            <Popover open={isOpen} onOpenChange={setIsOpen}>
                <PopoverTrigger asChild className="[&_button]:bg-secondary">
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-9 bg-secondary hover:bg-secondary px-3 font-normal gap-1.5"
                    >
                        <span className="text-muted-foreground">
                            {label}{getOperationSuffix()}:
                        </span>
                        {renderFilterDisplay()}
                        <ChevronDown className="h-3 w-3 text-muted-foreground ml-1" />
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="p-0 max-w-96 w-fit" align="start">
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
}

interface TokenData {
    token: TokenOption;
    amountOperation?: string;
    minAmount?: string;
    maxAmount?: string;
}

function TokenFilterContent({ value, onUpdate, setIsOpen, onRemove }: TokenFilterContentProps) {
    const { operation, setOperation, data, setData, handleClear } = useFilterState<TokenData>({
        value,
        onUpdate,
        parseData: (parsed) => ({
            token: parsed.token,
            amountOperation: parsed.amountOperation || "Between",
            minAmount: parsed.minAmount || "",
            maxAmount: parsed.maxAmount || ""
        }),
        serializeData: (op, d) => ({
            operation: op,
            token: d.token,
            ...(op === "Is" && {
                amountOperation: d.amountOperation,
                minAmount: d.minAmount,
                maxAmount: d.maxAmount
            })
        })
    });

    const handleDelete = () => {
        onRemove();
        setIsOpen(false);
    };

    const updateData = (updates: Partial<TokenData>) => {
        setData({
            token: updates.token ?? data?.token as any,
            amountOperation: updates.amountOperation ?? data?.amountOperation ?? "Between",
            minAmount: updates.minAmount ?? data?.minAmount ?? "",
            maxAmount: updates.maxAmount ?? data?.maxAmount ?? ""
        });
    };

    return (
        <BaseFilterPopover
            filterLabel="Token"
            operation={operation}
            operations={TOKEN_OPERATIONS}
            onOperationChange={setOperation}
            onClear={handleClear}
            onDelete={handleDelete}
            className="max-w-80 pb-1"
        >
            <div className="px-2">
                <TokenSelectPopover
                    selectedToken={data?.token || null}
                    onTokenChange={(token) => updateData({ token })}
                    className="w-full"
                />
            </div>

            {data?.token && operation === "Is" && (
                <>
                    <div className="py-2 px-2 flex items-baseline gap-1">
                        <span className="text-xs  text-muted-foreground">Amount</span>
                        <OperationSelect
                            operations={AMOUNT_OPERATIONS}
                            selectedOperation={data.amountOperation || "Between"}
                            onOperationChange={(op) => updateData({ amountOperation: op })}
                        />
                    </div>


                    <div className="px-2 py-1">
                        {data.amountOperation === "Between" ? (
                            <div className="flex-col flex gap-2">
                                <div className="flex flex-col gap-1">
                                    <span className="text-sm text-foreground font-medium">From</span>
                                    <Input
                                        type="number"
                                        placeholder="Min"
                                        value={data.minAmount || ""}
                                        onChange={(e) => updateData({ minAmount: e.target.value })}
                                        className="h-8 text-sm"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className="text-sm text-foreground font-medium">To</span>
                                    <Input
                                        type="number"
                                        placeholder="Max"
                                        value={data.maxAmount || ""}
                                        onChange={(e) => updateData({ maxAmount: e.target.value })}
                                        className="h-8 text-sm"
                                    />
                                </div>
                            </div>
                        ) : (
                            <Input
                                type="number"
                                placeholder="Amount"
                                value={data.minAmount || ""}
                                onChange={(e) => updateData({ minAmount: e.target.value })}
                                className="h-8 text-sm"
                            />
                        )}
                    </div>
                </>
            )
            }
        </BaseFilterPopover >
    );
}

// My Vote filter using unified CheckboxFilterContent
function MyVoteFilterContent({ value, onUpdate, setIsOpen, onRemove }: {
    value: string;
    onUpdate: (value: string) => void;
    setIsOpen: (isOpen: boolean) => void;
    onRemove: () => void;
}) {
    return (
        <CheckboxFilterContent
            value={value}
            onUpdate={onUpdate}
            setIsOpen={setIsOpen}
            onRemove={onRemove}
            filterLabel="My Vote Status"
            operations={MY_VOTE_OPERATIONS}
            options={MY_VOTE_OPTIONS.map(vote => ({ value: vote, label: vote }))}
        />
    );
}

// Proposal Type filter using unified CheckboxFilterContent
function ProposalTypeFilterContent({ value, onUpdate, setIsOpen, onRemove }: {
    value: string;
    onUpdate: (value: string) => void;
    setIsOpen: (isOpen: boolean) => void;
    onRemove: () => void;
}) {
    return (
        <CheckboxFilterContent
            value={value}
            onUpdate={onUpdate}
            setIsOpen={setIsOpen}
            onRemove={onRemove}
            filterLabel="Request Type"
            operations={PROPOSAL_TYPE_OPERATIONS}
            options={PROPOSAL_TYPE_OPTIONS.map(type => ({ value: type, label: type }))}
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

function CreatedDateFilterContent({ value, onUpdate, setIsOpen, onRemove, minDate, maxDate }: CreatedDateFilterContentProps) {
    const { operation, setOperation, data, setData, handleClear } = useFilterState<DateData>({
        value,
        onUpdate,
        parseData: (parsed) => ({
            dateRange: parsed.dateRange ? {
                from: parsed.dateRange.from ? new Date(parsed.dateRange.from) : undefined,
                to: parsed.dateRange.to ? new Date(parsed.dateRange.to) : undefined
            } : {
                from: undefined,
                to: undefined
            }
        }),
        serializeData: (op, d) => ({
            operation: op,
            dateRange: d.dateRange ? {
                from: d.dateRange.from?.toISOString(),
                to: d.dateRange.to?.toISOString()
            } : undefined
        })
    });

    const handleDelete = () => {
        onRemove();
        setIsOpen(false);
    };

    const commonTimeFilters = useMemo(
        () => [
            {
                label: 'Today',
                value: {
                    from: startOfDay(new Date()),
                    to: endOfDay(new Date()),
                },
            },
            {
                label: 'Yesterday',
                value: {
                    from: subDays(startOfDay(new Date()), 1),
                    to: subDays(endOfDay(new Date()), 1),
                },
            },
            {
                label: 'Last 3 days',
                value: {
                    from: subDays(startOfDay(new Date()), 3),
                    to: endOfDay(new Date()),
                },
            },
            {
                label: 'Last 7 days',
                value: {
                    from: subDays(startOfDay(new Date()), 7),
                    to: endOfDay(new Date()),
                },
            },
            {
                label: 'Last 14 days',
                value: {
                    from: subDays(startOfDay(new Date()), 14),
                    to: endOfDay(new Date()),
                },
            },
            {
                label: 'Last month',
                value: {
                    from: subMonths(startOfDay(new Date()), 1),
                    to: endOfDay(new Date()),
                },
            },
            {
                label: 'Last 3 months',
                value: {
                    from: subMonths(startOfDay(new Date()), 3),
                    to: endOfDay(new Date()),
                },
            },
            {
                label: 'Last 6 months',
                value: {
                    from: subMonths(startOfDay(new Date()), 6),
                    to: endOfDay(new Date()),
                },
            },
        ],
        [],
    );

    const defaultMonth = useMemo(() => {
        if (data?.dateRange?.from) {
            return data.dateRange.from;
        }
        return startOfDay(new Date());
    }, [data?.dateRange?.from]);

    return (
        <BaseFilterPopover
            filterLabel="Created Date"
            operation={operation}
            operations={DATE_OPERATIONS}
            onOperationChange={setOperation}
            onClear={handleClear}
            onDelete={handleDelete}
            className="flex w-96 pb-1"
        >
            <div className="flex max-w-md w-full">
                <div className="h-full w-full flex items-center justify-center">
                    <DateTimePicker
                        mode="range"
                        presets={commonTimeFilters}
                        value={data?.dateRange ? { from: data?.dateRange.from, to: data?.dateRange.to } : undefined}
                        onChange={(range) => {
                            if (range && typeof range === 'object' && 'from' in range) {
                                setData({
                                    dateRange: {
                                        from: range.from ? startOfDay(range.from) : undefined,
                                        to: range.to ? endOfDay(range.to) : undefined
                                    }
                                });
                            } else {
                                setData({ dateRange: { from: undefined, to: undefined } });
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
}

interface UserData {
    users: string[];
}

function UserFilterContent({ value, onUpdate, setIsOpen, onRemove, label }: UserFilterContentProps) {
    const { treasuryId } = useTreasury();
    const { recentAddresses, addRecentAddress } = useRecentAddresses();
    const [searchQuery, setSearchQuery] = useState("");

    const { operation, setOperation, data, setData, handleClear } = useFilterState<UserData>({
        value,
        onUpdate,
        parseData: (parsed) => ({
            users: parsed.users || []
        }),
        serializeData: (op, d) => ({
            operation: op,
            users: d.users
        })
    });

    // Determine which user list type to fetch based on label
    const userListType: UserListType = useMemo(() => {
        if (label === "Requester") return "proposers";
        if (label === "Approver") return "approvers";
        return "members";
    }, [label]);

    // Fetch the appropriate user list using the unified hook
    const { users: fetchedUsers, isLoading: isLoadingMembers } = useDaoUsers(treasuryId ?? null, userListType);

    // Use fetched users as suggestions
    const memberSuggestions = useMemo(() => {
        return fetchedUsers;
    }, [fetchedUsers]);

    // Combine DAO members with custom addresses and recent addresses, then filter and sort
    const filteredMembers = useMemo(() => {
        const query = searchQuery.toLowerCase();
        const selectedUsers = data?.users || [];

        // Combine DAO members with selected users and recent addresses that aren't already in DAO members
        const allUsers = new Set([
            ...memberSuggestions,
            ...selectedUsers.filter(user => !memberSuggestions.includes(user)),
            ...recentAddresses.filter(addr => !memberSuggestions.includes(addr))
        ]);

        // Filter based on search query, then sort with checked users at top
        return Array.from(allUsers)
            .filter(accountId => accountId.toLowerCase().includes(query))
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
            setData({ users: currentUsers.filter(u => u !== accountId) });
        } else {
            setData({ users: [...currentUsers, accountId] });
            addRecentAddress(accountId);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" && searchQuery.trim()) {
            e.preventDefault();
            const accountId = searchQuery.trim();
            if (!data?.users.includes(accountId)) {
                setData({ users: [...(data?.users || []), accountId] });
                // Save to recent addresses
                addRecentAddress(accountId);
            }
            setSearchQuery("");
        }
    };

    return (
        <BaseFilterPopover
            filterLabel={label}
            operation={operation}
            operations={USER_OPERATIONS}
            onOperationChange={setOperation}
            onClear={handleClear}
            onDelete={handleDelete}
            className="w-64"
        >
            <div className="flex flex-col">
                <div className="px-2 py-1.5">
                    <Input
                        autoFocus
                        placeholder="Search by address"
                        search
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        className="h-8 text-sm"
                    />
                </div>

                {/* Loading state */}
                {isLoadingMembers ? (
                    <div className="text-xs text-muted-foreground text-center py-2">
                        Loading members...
                    </div>
                ) : (
                    <ScrollArea className="h-60 [&>[data-radix-scroll-area-viewport]>div]:block!" type="always" >
                        {filteredMembers.length > 0 && (
                            <div className="flex flex-col">
                                {filteredMembers.map((accountId) => {
                                    const isSelected = data?.users?.includes(accountId) || false;
                                    return (
                                        <label
                                            key={accountId}
                                            className="flex px-2 items-center gap-2 cursor-pointer hover:bg-muted/50 py-1.5 rounded-md"
                                        >
                                            <Checkbox
                                                checked={isSelected}
                                                onCheckedChange={() => handleToggleUser(accountId)}
                                                className="shrink-0"
                                            />
                                            <div className="min-w-0">
                                                <User accountId={accountId} iconOnly={false} withLink={false} size="sm" />
                                            </div>
                                        </label>
                                    );
                                })}
                            </div>
                        )}

                        {searchQuery && filteredMembers.length === 0 && (
                            <p className="text-xs text-muted-foreground text-center py-2">
                                No members found. Press Enter to add "{searchQuery}"
                            </p>
                        )}

                        {!searchQuery && filteredMembers.length === 0 && (
                            <p className="text-xs text-muted-foreground text-center py-2">
                                No members available
                            </p>
                        )}
                    </ScrollArea>
                )}
            </div>
        </BaseFilterPopover>
    );
}

