"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/button";
import { Plus, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { DateTimePicker } from "@/components/ui/datepicker";
import { format } from "date-fns";
import { OperationSelect } from "@/components/operation-select";
import { TokenSelectPopover } from "@/components/token-select-popover";
import { Checkbox } from "@/components/ui/checkbox";
import { BaseFilterPopover } from "./base-filter-popover";
import { useFilterState } from "../hooks/use-filter-state";
import { parseFilterData } from "../types/filter-types";
import { TooltipUser, User } from "@/components/user";
import { useTreasuryMembers } from "@/hooks/use-treasury-members";
import { useRecentAddresses } from "@/hooks/use-recent-addresses";
import { useTreasury } from "@/stores/treasury-store";

const FILTER_OPTIONS = [
    { id: "proposal_types", label: "Requests Type" },
    { id: "created_date", label: "Created Date" },
    { id: "recipients", label: "Recipient" },
    { id: "tokens", label: "Token" },
    { id: "proposers", label: "Requester" },
    { id: "approvers", label: "Approver" },
    { id: "my_vote", label: "My Vote Status" },
];


const PROPOSAL_TYPE_OPTIONS = [
    "Transfer",
    "FunctionCall",
    "AddMemberToRole",
    "RemoveMemberFromRole",
    "ChangeConfig",
    "ChangePolicy",
    "AddBounty",
    "BountyDone",
    "Vote",
    "FactoryUpdateSelf",
];

const MY_VOTE_OPTIONS = ["Approved", "Rejected", "No Voted"];
const MY_VOTE_OPERATIONS = ["Is", "Is Not"];

const TOKEN_OPERATIONS = ["Is", "Is Not"];
const AMOUNT_OPERATIONS = ["Between", "Equal", "More Than", "Less Than"];

const PROPOSAL_TYPE_OPERATIONS = ["Is", "Is Not"];
const DATE_OPERATIONS = ["Is", "Is Not", "Before", "After"];
const TEXT_OPERATIONS = ["Is", "Is Not", "Contains"];
const USER_OPERATIONS = ["Is", "Is Not"];

interface TokenOption {
    id: string;
    name: string;
    symbol: string;
    icon: string;
}

interface ProposalFiltersProps {
    className?: string;
}

export function ProposalFilters({ className }: ProposalFiltersProps) {
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const [isAddFilterOpen, setIsAddFilterOpen] = useState(false);

    const activeFilters = useMemo(() => {
        const filters: string[] = [];
        FILTER_OPTIONS.forEach((opt) => {
            if (searchParams.has(opt.id)) {
                filters.push(opt.id);
            }
        });
        return filters;
    }, [searchParams]);

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

    const availableFilters = FILTER_OPTIONS.filter(
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
                {activeFilters.map((filterId) => (
                    <FilterPill
                        key={filterId}
                        id={filterId}
                        label={FILTER_OPTIONS.find((o) => o.id === filterId)?.label || ""}
                        value={searchParams.get(filterId) || ""}
                        onRemove={() => removeFilter(filterId)}
                        onUpdate={(val) => updateFilters({ [filterId]: val })}
                    />
                ))}

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
}

function FilterPill({ id, label, value, onRemove, onUpdate }: FilterPillProps) {
    const [isOpen, setIsOpen] = useState(false);

    // Single unified parsing - no backward compatibility
    const filterData = useMemo(() => {
        return parseFilterData(value);
    }, [value]);

    const displayValue = useMemo(() => {
        if (!value || filterData) return null; // Use custom rendering for all filter types
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
                return <CreatedDateFilterContent value={value} onUpdate={onUpdate} setIsOpen={setIsOpen} onRemove={onRemove} />;
            case "tokens":
                return <TokenFilterContent value={value} onUpdate={onUpdate} setIsOpen={setIsOpen} onRemove={onRemove} />;
            case "my_vote":
                return <MyVoteFilterContent value={value} onUpdate={onUpdate} setIsOpen={setIsOpen} onRemove={onRemove} />;
            default:
                return <TextFilterContent value={value} onUpdate={onUpdate} setIsOpen={setIsOpen} onRemove={onRemove} label={label} />;
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
        if (id === "tokens" && (filterData as any).token) {
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
        if (id === "my_vote" && (filterData as any).votes) {
            return <span className="font-medium text-sm">{(filterData as any).votes.join(", ")}</span>;
        }

        // Proposal Type filter display
        if (id === "proposal_types" && (filterData as any).type) {
            return <span className="font-medium text-sm">{(filterData as any).type}</span>;
        }

        // Date filter display
        if (id === "created_date" && (filterData as any).date) {
            try {
                return <span className="font-medium text-sm">{format(new Date((filterData as any).date), "MMM d, yyyy")}</span>;
            } catch {
                return <span className="font-medium text-sm">{(filterData as any).date}</span>;
            }
        }

        // Text filter display
        if ((filterData as any).text) {
            return <span className="font-medium text-sm">{(filterData as any).text}</span>;
        }

        // User filter display (recipients, proposers, approvers)
        if ((id === "recipients" || id === "proposers" || id === "approvers") && (filterData as any).users) {
            const users = (filterData as any).users as string[];
            if (users.length === 0) return null;

            return (
                <div className="flex items-center">
                    {users.map((accountId, index) => (
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
        <div className="flex items-center">
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
                <PopoverContent className="p-1 max-w-80 w-fit" align="start">
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
        if (data) {
            setData({ ...data, ...updates });
        }
    };

    return (
        <BaseFilterPopover
            filterLabel="Token"
            operation={operation}
            operations={TOKEN_OPERATIONS}
            onOperationChange={setOperation}
            onClear={handleClear}
            onDelete={handleDelete}
            className="max-w-80"
        >
            <TokenSelectPopover
                selectedToken={data?.token || null}
                onTokenChange={(token) => updateData({ token })}
                className="w-full"
            />

            {operation === "Is" && data?.token && (
                <div className="space-y-3 pt-2 border-t">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">Amount</span>
                        <OperationSelect
                            operations={AMOUNT_OPERATIONS}
                            selectedOperation={data.amountOperation || "Between"}
                            onOperationChange={(op) => updateData({ amountOperation: op })}
                        />
                    </div>

                    {data.amountOperation === "Between" ? (
                        <div className="flex-col flex items-center gap-2">
                            <Input
                                type="number"
                                placeholder="Min"
                                value={data.minAmount || ""}
                                onChange={(e) => updateData({ minAmount: e.target.value })}
                                className="h-8 text-sm"
                            />
                            <span className="text-sm text-muted-foreground">to</span>
                            <Input
                                type="number"
                                placeholder="Max"
                                value={data.maxAmount || ""}
                                onChange={(e) => updateData({ maxAmount: e.target.value })}
                                className="h-8 text-sm"
                            />
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
                    <p className="text-xs text-muted-foreground">
                        Empty amount means any
                    </p>
                </div>
            )}
        </BaseFilterPopover>
    );
}

interface MyVoteFilterContentProps {
    value: string;
    onUpdate: (value: string) => void;
    setIsOpen: (isOpen: boolean) => void;
    onRemove: () => void;
}

interface MyVoteData {
    votes: string[];
}

function MyVoteFilterContent({ value, onUpdate, setIsOpen, onRemove }: MyVoteFilterContentProps) {
    const { operation, setOperation, data, setData, handleClear } = useFilterState<MyVoteData>({
        value,
        onUpdate,
        parseData: (parsed) => ({
            votes: parsed.votes || []
        }),
        serializeData: (op, d) => ({
            operation: op,
            votes: d.votes
        })
    });

    const handleDelete = () => {
        onRemove();
        setIsOpen(false);
    };

    const handleToggleVote = (vote: string) => {
        const currentVotes = data?.votes || [];
        if (currentVotes.includes(vote)) {
            setData({ votes: currentVotes.filter(v => v !== vote) });
        } else {
            setData({ votes: [...currentVotes, vote] });
        }
    };

    return (
        <BaseFilterPopover
            filterLabel="My Vote Status"
            operation={operation}
            operations={MY_VOTE_OPERATIONS}
            onOperationChange={setOperation}
            onClear={handleClear}
            onDelete={handleDelete}
        >
            <div className="space-y-2">
                {MY_VOTE_OPTIONS.map((vote) => (
                    <label
                        key={vote}
                        className="flex items-center gap-2 cursor-pointer hover:bg-muted/50 p-2 rounded-md"
                    >
                        <Checkbox
                            checked={data?.votes.includes(vote) || false}
                            onCheckedChange={() => handleToggleVote(vote)}
                        />
                        <span className="text-sm">{vote}</span>
                    </label>
                ))}
            </div>
        </BaseFilterPopover>
    );
}

interface ProposalTypeFilterContentProps {
    value: string;
    onUpdate: (value: string) => void;
    setIsOpen: (isOpen: boolean) => void;
    onRemove: () => void;
}

interface ProposalTypeData {
    type: string;
}

function ProposalTypeFilterContent({ value, onUpdate, setIsOpen, onRemove }: ProposalTypeFilterContentProps) {
    const { operation, setOperation, data, setData, handleClear } = useFilterState<ProposalTypeData>({
        value,
        onUpdate,
        parseData: (parsed) => ({
            type: parsed.type || ""
        }),
        serializeData: (op, d) => ({
            operation: op,
            type: d.type
        })
    });

    const handleDelete = () => {
        onRemove();
        setIsOpen(false);
    };

    const handleSelectType = (type: string) => {
        setData({ type });
        setIsOpen(false);
    };

    return (
        <BaseFilterPopover
            filterLabel="Request Type"
            operation={operation}
            operations={PROPOSAL_TYPE_OPERATIONS}
            onOperationChange={setOperation}
            onClear={handleClear}
            onDelete={handleDelete}
        >
            <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
                {PROPOSAL_TYPE_OPTIONS.map((opt) => (
                    <Button
                        key={opt}
                        variant="ghost"
                        size="sm"
                        className={cn(
                            "justify-start font-normal h-8",
                            data?.type === opt && "bg-muted"
                        )}
                        onClick={() => handleSelectType(opt)}
                    >
                        {opt}
                    </Button>
                ))}
            </div>
        </BaseFilterPopover>
    );
}

interface CreatedDateFilterContentProps {
    value: string;
    onUpdate: (value: string) => void;
    setIsOpen: (isOpen: boolean) => void;
    onRemove: () => void;
}

interface DateData {
    date: Date | undefined;
}

function CreatedDateFilterContent({ value, onUpdate, setIsOpen, onRemove }: CreatedDateFilterContentProps) {
    const { operation, setOperation, data, setData, handleClear } = useFilterState<DateData>({
        value,
        onUpdate,
        parseData: (parsed) => ({
            date: parsed.date ? new Date(parsed.date) : undefined
        }),
        serializeData: (op, d) => ({
            operation: op,
            date: d.date?.toISOString()
        })
    });

    const handleDelete = () => {
        onRemove();
        setIsOpen(false);
    };

    const handleDateChange = (date: Date | undefined) => {
        setData({ date });
    };

    return (
        <BaseFilterPopover
            filterLabel="Created Date"
            operation={operation}
            operations={DATE_OPERATIONS}
            onOperationChange={setOperation}
            onClear={handleClear}
            onDelete={handleDelete}
        >
            <DateTimePicker
                value={data?.date}
                onChange={handleDateChange}
                hideTime
            />
        </BaseFilterPopover>
    );
}

interface TextFilterContentProps {
    value: string;
    onUpdate: (value: string) => void;
    setIsOpen: (isOpen: boolean) => void;
    onRemove: () => void;
    label: string;
}

interface TextData {
    text: string;
}

function TextFilterContent({ value, onUpdate, setIsOpen, onRemove, label }: TextFilterContentProps) {
    const { operation, setOperation, data, setData, handleClear } = useFilterState<TextData>({
        value,
        onUpdate,
        parseData: (parsed) => ({
            text: parsed.text || ""
        }),
        serializeData: (op, d) => ({
            operation: op,
            text: d.text
        })
    });

    const handleDelete = () => {
        onRemove();
        setIsOpen(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            setIsOpen(false);
        }
    };

    return (
        <BaseFilterPopover
            filterLabel={label}
            operation={operation}
            operations={TEXT_OPERATIONS}
            onOperationChange={setOperation}
            onClear={handleClear}
            onDelete={handleDelete}
        >
            <Input
                autoFocus
                placeholder={`Enter ${label.toLowerCase()}...`}
                value={data?.text || ""}
                onChange={(e) => setData({ text: e.target.value })}
                onKeyDown={handleKeyDown}
                className="h-8 text-sm"
            />
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
    const { selectedTreasury } = useTreasury();
    const { members: daoMembers, isLoading: isLoadingMembers } = useTreasuryMembers(selectedTreasury);
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

    // Extract unique member account IDs
    const memberSuggestions = useMemo(() => {
        return daoMembers.map(m => m.accountId);
    }, [daoMembers]);

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
            <div className="space-y-2">
                <Input
                    autoFocus
                    placeholder="Search by address"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className="h-8 text-sm"
                />

                {/* Loading state */}
                {isLoadingMembers ? (
                    <div className="text-xs text-muted-foreground text-center py-2">
                        Loading members...
                    </div>
                ) : (
                    <>
                        {/* Single unified list of all members */}
                        {filteredMembers.length > 0 && (
                            <div className="space-y-1 max-w-full truncate overflow-y-auto">
                                {filteredMembers.map((accountId) => {
                                    const isSelected = data?.users?.includes(accountId) || false;
                                    return (
                                        <label
                                            key={accountId}
                                            className="flex items-center gap-2 cursor-pointer hover:bg-muted/50 p-2 rounded-md"
                                        >
                                            <Checkbox
                                                checked={isSelected}
                                                onCheckedChange={() => handleToggleUser(accountId)}
                                            />
                                            <User accountId={accountId} iconOnly={false} withLink={false} size="sm" />
                                        </label>
                                    );
                                })}
                            </div>
                        )}

                        {/* No results with search query */}
                        {searchQuery && filteredMembers.length === 0 && (
                            <p className="text-xs text-muted-foreground text-center py-2">
                                No members found. Press Enter to add "{searchQuery}"
                            </p>
                        )}

                        {/* Empty state */}
                        {!searchQuery && filteredMembers.length === 0 && (
                            <p className="text-xs text-muted-foreground text-center py-2">
                                No members available
                            </p>
                        )}
                    </>
                )}
            </div>
        </BaseFilterPopover>
    );
}

