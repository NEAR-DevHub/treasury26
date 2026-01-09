"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useCallback, useMemo, useState, useEffect } from "react";
import { Button } from "@/components/button";
import { Plus, X, Search, ChevronDown, Trash } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { DateTimePicker } from "@/components/ui/datepicker";
import { format } from "date-fns";
import { OperationSelect } from "@/components/operation-select";
import { TokenSelectPopover } from "@/components/token-select-popover";

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

const MY_VOTE_OPTIONS = ["Approve", "Reject", "Remove", "None"];

const TOKEN_OPERATIONS = ["Is", "Is Not"];
const AMOUNT_OPERATIONS = ["Between", "Equal", "More Than", "Less Than"];

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

    const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        updateFilters({ search: value || null });
    };

    const availableFilters = FILTER_OPTIONS.filter(
        (opt) => !activeFilters.includes(opt.id)
    );

    return (
        <div className={cn("flex flex-wrap items-center gap-3", className)}>
            <Button
                variant="outline"
                size="sm"
                onClick={resetFilters}
                className="h-9 rounded-md px-3 border-none bg-muted/50 hover:bg-muted font-medium"
            >
                Reset
            </Button>

            <div className="flex flex-wrap items-center gap-2">
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
                                className="h-8 gap-1.5 text-muted-foreground hover:text-foreground font-medium"
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

            <div className="relative ml-auto w-64">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    placeholder="Search requests..."
                    className="pl-9 h-9 bg-card border-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
                    value={searchParams.get("search") || ""}
                    onChange={handleSearchChange}
                />
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

    const tokenFilterData = useMemo(() => {
        if (id === "tokens" && value) {
            try {
                const parsed = JSON.parse(value);
                return parsed;
            } catch {
                // Fallback for old format
                return {
                    operation: "Is",
                    token: { id: value, name: value, symbol: value, icon: value.charAt(0) },
                };
            }
        }
        return null;
    }, [id, value]);

    const displayValue = useMemo(() => {
        if (!value) return "All";
        if (id === "created_date") {
            try {
                return format(new Date(value), "MMM d, yyyy");
            } catch {
                return value;
            }
        }
        if (id === "tokens" && tokenFilterData) {
            return null; // We'll render custom UI for tokens
        }
        return value;
    }, [id, value, tokenFilterData]);

    const renderFilterContent = () => {
        switch (id) {

            case "proposal_types":
                return (
                    <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
                        {PROPOSAL_TYPE_OPTIONS.map((opt) => (
                            <Button
                                key={opt}
                                variant="ghost"
                                size="sm"
                                className={cn(
                                    "justify-start font-normal h-8",
                                    value === opt && "bg-muted"
                                )}
                                onClick={() => {
                                    onUpdate(opt);
                                    setIsOpen(false);
                                }}
                            >
                                {opt}
                            </Button>
                        ))}
                    </div>
                );
            case "created_date":
                return (
                    <div className="p-2">
                        <DateTimePicker
                            value={value ? new Date(value) : undefined}
                            onChange={(date) => {
                                if (date) {
                                    onUpdate(date.toISOString());
                                }
                            }}
                            hideTime
                        />
                    </div>
                );
            case "tokens":
                return <TokenFilterContent value={value} onUpdate={onUpdate} setIsOpen={setIsOpen} onRemove={onRemove} />;
            case "my_vote":
                return (
                    <div className="flex flex-col gap-1">
                        {MY_VOTE_OPTIONS.map((opt) => (
                            <Button
                                key={opt}
                                variant="ghost"
                                size="sm"
                                className={cn(
                                    "justify-start font-normal h-8",
                                    value === opt && "bg-muted"
                                )}
                                onClick={() => {
                                    onUpdate(opt);
                                    setIsOpen(false);
                                }}
                            >
                                {opt}
                            </Button>
                        ))}
                    </div>
                );
            default:
                return (
                    <div className="p-2">
                        <Input
                            autoFocus
                            placeholder={`Enter ${label.toLowerCase()}...`}
                            defaultValue={value}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    onUpdate(e.currentTarget.value);
                                    setIsOpen(false);
                                }
                            }}
                            className="h-8 text-sm"
                        />
                    </div>
                );
        }
    };

    const renderTokenDisplay = () => {
        if (!tokenFilterData || !tokenFilterData.token) return null;

        const { operation, token, amountOperation, minAmount, maxAmount } = tokenFilterData;

        // Build amount display
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
                    <img
                        src={token.icon}
                        alt={token.symbol}
                        className="w-4 h-4 rounded-full object-contain"
                    />
                ) : (
                    <div className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[8px] font-bold bg-gradient-cyan-blue">
                        <span>{token.icon}</span>
                    </div>
                )}
                {amountDisplay && <span className="text-sm text-foreground">{amountDisplay}</span>}
                <span className="text-sm text-foreground">{token.symbol}</span>
            </div>
        );
    };

    return (
        <div className="flex items-center">
            <Popover open={isOpen} onOpenChange={setIsOpen}>
                <PopoverTrigger asChild className="[&_button]:bg-secondary">
                    {label === "Created Date" ? (
                        <DateTimePicker
                            value={value ? new Date(value) : undefined}
                            classNames={{ trigger: "border-border" }}
                            onChange={(date) => {
                                if (date) {
                                    onUpdate(date.toISOString());
                                }
                            }}
                            hideTime
                        />
                    ) : (
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-9 bg-secondary hover:bg-secondary px-3 font-normal gap-1.5"
                        >
                            <span className="text-muted-foreground">{label}{tokenFilterData && tokenFilterData.operation === "Is Not" ? " is not" : ""}:</span>
                            {tokenFilterData ? (
                                renderTokenDisplay()
                            ) : (
                                <span className="font-medium">{displayValue}</span>
                            )}
                            <ChevronDown className="h-3 w-3 text-muted-foreground ml-1" />
                        </Button>
                    )}
                </PopoverTrigger>
                <PopoverContent className="w-56 p-1" align="start">
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

function TokenFilterContent({ value, onUpdate, setIsOpen, onRemove }: TokenFilterContentProps) {
    const [operation, setOperation] = useState<string>("Is");
    const [selectedToken, setSelectedToken] = useState<TokenOption | null>(null);
    const [amountOperation, setAmountOperation] = useState<string>("Between");
    const [minAmount, setMinAmount] = useState<string>("");
    const [maxAmount, setMaxAmount] = useState<string>("");

    // Parse the value from URL params on mount
    useEffect(() => {
        if (value) {
            try {
                const parsed = JSON.parse(value);
                setOperation(parsed.operation || "Is");
                setSelectedToken(parsed.token || null);
                setAmountOperation(parsed.amountOperation || "Equal");
                setMinAmount(parsed.minAmount || "");
                setMaxAmount(parsed.maxAmount || "");
            } catch {
                // If parsing fails, treat it as old format (just token symbol)
                setSelectedToken({ id: value, name: value, symbol: value, icon: value.charAt(0) });
            }
        }
    }, [value]);

    // Update the filter value whenever any field changes
    useEffect(() => {
        if (selectedToken) {
            const filterValue = JSON.stringify({
                operation,
                token: selectedToken,
                amountOperation: operation === "Is" ? amountOperation : undefined,
                minAmount: operation === "Is" ? minAmount : undefined,
                maxAmount: operation === "Is" ? maxAmount : undefined,
            });
            onUpdate(filterValue);
        }
    }, [operation, selectedToken, amountOperation, minAmount, maxAmount, onUpdate]);

    const handleClear = () => {
        setSelectedToken(null);
        setMinAmount("");
        setMaxAmount("");
        onUpdate("");
    };

    const handleDelete = () => {
        onRemove();
        setIsOpen(false);
    };

    return (
        <div className="p-3 space-y-3 max-w-80">
            <div className="flex items-center gap-2">
                <span className="text-xs font-medium">Token</span>
                <OperationSelect
                    operations={TOKEN_OPERATIONS}
                    selectedOperation={operation}
                    onOperationChange={setOperation}
                />
                <div className="flex items-center gap-0 flex-1 ml-auto">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleClear}
                        className="ml-auto text-muted-foreground hover:text-foreground h-7 px-2"
                    >
                        Clear
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleDelete}
                        className="text-muted-foreground hover:text-foreground h-7 w-7"
                    >
                        <Trash className="size-3.5" />
                    </Button>
                </div>
            </div>

            <TokenSelectPopover
                selectedToken={selectedToken}
                onTokenChange={setSelectedToken}
                className="w-full"
            />

            {operation === "Is" && selectedToken && (
                <div className="space-y-3 pt-2 border-t">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">Amount</span>
                        <OperationSelect
                            operations={AMOUNT_OPERATIONS}
                            selectedOperation={amountOperation}
                            onOperationChange={setAmountOperation}
                        />
                    </div>

                    {amountOperation === "Between" ? (
                        <div className="flex-col flex items-center gap-2">
                            <Input
                                type="number"
                                placeholder="Min"
                                value={minAmount}
                                onChange={(e) => setMinAmount(e.target.value)}
                                className="h-8 text-sm"
                            />
                            <span className="text-sm text-muted-foreground">to</span>
                            <Input
                                type="number"
                                placeholder="Max"
                                value={maxAmount}
                                onChange={(e) => setMaxAmount(e.target.value)}
                                className="h-8 text-sm"
                            />
                        </div>
                    ) : (
                        <Input
                            type="number"
                            placeholder="Amount"
                            value={minAmount}
                            onChange={(e) => setMinAmount(e.target.value)}
                            className="h-8 text-sm"
                        />
                    )}
                    <p className="text-xs text-muted-foreground">
                        Empty amount means any
                    </p>
                </div>
            )}
        </div>
    );
}

