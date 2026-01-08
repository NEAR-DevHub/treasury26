"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/button";
import { Plus, X, Search, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { DateTimePicker } from "@/components/ui/datepicker";
import { format } from "date-fns";

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
    "Payment Request",
    "Batch Payment Request",
    "Exchange",
    "Function Call",
    "Change Policy",
    "Update General Settings",
    "Earn NEAR",
    "Unstake NEAR",
    "Vesting",
    "Withdraw Earnings",
    "Members",
    "Upgrade",
    "Set Staking Contract",
    "Bounty",
    "Vote",
    "Factory Info Update",
];

const MY_VOTE_OPTIONS = ["Approve", "Reject", "Remove", "None"];

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
                                className="h-9 gap-1.5 text-muted-foreground hover:text-foreground font-medium"
                            >
                                <Plus className="h-4 w-4" />
                                Add Filter
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-56 p-1" align="start">
                            <div className="flex flex-col">
                                {availableFilters.map((filter) => (
                                    <Button
                                        key={filter.id}
                                        variant="ghost"
                                        size="sm"
                                        className="justify-start font-normal h-9"
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

    const displayValue = useMemo(() => {
        if (!value) return "All";
        if (id === "created_date") {
            try {
                return format(new Date(value), "MMM d, yyyy");
            } catch {
                return value;
            }
        }
        return value;
    }, [id, value]);

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

    return (
        <div className="flex items-center">
            <Popover open={isOpen} onOpenChange={setIsOpen}>
                <PopoverTrigger asChild>
                    {label === "Created Date" ? (
                        <DateTimePicker
                            value={value ? new Date(value) : undefined}
                            classNames={{ trigger: "border-r-0 rounded-r-none border-border" }}
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
                            className="h-9 rounded-l-md rounded-r-none border-r-0 bg-card hover:bg-card px-3 font-normal gap-1"
                        >
                            <span className="text-muted-foreground">{label}:</span>
                            <span className="font-medium">{displayValue}</span>
                            <ChevronDown className="h-3 w-3 text-muted-foreground ml-1" />
                        </Button>)}
                </PopoverTrigger>
                <PopoverContent className="w-56 p-1" align="start">
                    {renderFilterContent()}
                </PopoverContent>
            </Popover>
            <Button
                variant="outline"
                size="sm"
                onClick={onRemove}
                className="h-9 w-8 rounded-l-none rounded-r-md bg-card hover:bg-card border-l-0 px-0 flex items-center justify-center text-muted-foreground hover:text-foreground"
            >
                <X className="h-3.5 w-3.5" />
            </Button>
        </div>
    );
}

