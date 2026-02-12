"use client";

import { PageCard } from "@/components/card";
import { PageComponentLayout } from "@/components/page-component-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/underline-tabs";
import { useProposals } from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";
import { getProposals, ProposalStatus } from "@/lib/proposals-api";
import { useSearchParams, useRouter, usePathname, useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { ProposalsTable } from "@/features/proposals";
import { Button } from "@/components/button";
import { ArrowRightLeft, ArrowUpRight, ListFilter } from "lucide-react";
import Link from "next/link";
import { useTreasuryPolicy, useTreasuryConfig } from "@/hooks/use-treasury-queries";
import { useQueryClient } from "@tanstack/react-query";
import { ProposalFilters as ProposalFiltersComponent, FilterOption } from "@/features/proposals/components/proposal-filters";
import { convertUrlParamsToApiFilters } from "@/features/proposals/utils/filter-params-converter";
import { NumberBadge } from "@/components/number-badge";
import { TableSkeleton } from "@/components/table-skeleton";
import { Input } from "@/components/input";
import { useNear } from "@/stores/near-store";
import { AuthButton } from "@/components/auth-button";

// Constants
const SEARCH_DEBOUNCE_MS = 300;
const FILTER_PANEL_MAX_HEIGHT = '500px';

const PROPOSAL_FILTER_OPTIONS: FilterOption[] = [
    { id: "proposal_types", label: "Requests Type" },
    { id: "created_date", label: "Created Date", maxDate: new Date() },
    { id: "recipients", label: "Recipient" },
    { id: "token", label: "Token" },
    { id: "proposers", label: "Requester" },
    { id: "approvers", label: "Approver" },
    { id: "my_vote", label: "My Vote Status" },
];

function ProposalsList({ status, onSelectionChange }: { status?: ProposalStatus[]; onSelectionChange?: (count: number) => void }) {
    const { treasuryId, config } = useTreasury();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const queryClient = useQueryClient();
    const { accountId } = useNear();

    const hasActiveFilters = useMemo(() => {
        const filterParams = ['proposers', 'approvers', 'recipients', 'proposal_types', 'token', 'created_date', 'my_vote', 'search'];
        return filterParams.some(param => searchParams.has(param));
    }, [searchParams]);

    const page = parseInt(searchParams.get("page") || "0", 10);
    const pageSize = 15;

    const filters = useMemo(() => {
        const urlFilters = convertUrlParamsToApiFilters(searchParams, accountId);
        const f: any = {
            ...urlFilters,
            page,
            page_size: pageSize,
            sort_by: "CreationTime",
            sort_direction: "desc",
        };

        // Add status filter if provided
        if (status) f.statuses = status;

        return f;
    }, [page, pageSize, searchParams, status, accountId]);

    const updatePage = useCallback((newPage: number) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("page", newPage.toString());
        router.push(`${pathname}?${params.toString()}`);
    }, [searchParams, router, pathname]);

    const { data, isLoading, error } = useProposals(treasuryId, filters);

    // Prefetch the next page
    useEffect(() => {
        if (treasuryId && data && data.proposals.length === pageSize && (page + 1) * pageSize < data.total) {
            const nextFilters = {
                ...filters,
                page: page + 1,
            };

            queryClient.prefetchQuery({
                queryKey: ["proposals", treasuryId, nextFilters],
                queryFn: () => getProposals(treasuryId, nextFilters),
            });
        }
    }, [data, page, treasuryId, filters, queryClient, pageSize]);

    if (isLoading) {
        return <TableSkeleton rows={12} columns={7} />;
    }

    if (error) {
        return (
            <div className="flex items-center justify-center py-8">
                <p className="text-destructive">Error loading proposals. Please try again.</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            {policy && (
                <ProposalsTable
                    proposals={data?.proposals ?? []}
                    policy={policy}
                    config={config}
                    withFilters={hasActiveFilters}
                    pageIndex={page}
                    pageSize={pageSize}
                    total={data?.total ?? 0}
                    onPageChange={updatePage}
                    onSelectionChange={onSelectionChange}
                />
            )}
        </div>
    );
}

function NoRequestsFound() {
    const { treasuryId: treasuryId } = useTreasury();
    const router = useRouter();
    return (
        <PageCard className="py-[100px] flex flex-col items-center justify-center w-full h-fit gap-4">
            <div className="flex flex-col items-center justify-center gap-0.5">
                <h1 className="font-semibold">Create your first request</h1>
                <p className="text-xs text-muted-foreground max-w-[300px] text-center">Requests for payments, exchanges, and other actions will appear here once created.</p>
            </div>
            <div className="flex gap-4 w-[300px]">
                <AuthButton
                    permissionKind="transfer"
                    onClick={() => router.push(`/${treasuryId}/payments`)}
                    permissionAction="AddProposal"
                    className="gap-1 w-1/2"
                >
                    <ArrowUpRight className="size-3.5" /> Send
                </AuthButton>
                <AuthButton
                    permissionKind="call"
                    onClick={() => router.push(`/${treasuryId}/exchange`)}
                    permissionAction="AddProposal"
                    className="gap-1 w-1/2"
                >
                    <ArrowRightLeft className="size-3.5" /> Exchange
                </AuthButton>
            </div>
        </PageCard>
    );
}

export default function RequestsPage() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const params = useParams();
    const treasuryId = params?.treasuryId as string | undefined;
    const { accountId } = useNear();
    const { data: proposals } = useProposals(treasuryId, {
        statuses: ["InProgress"],
        ...(accountId && {
            voter_votes: `${accountId}:No Voted`,
        }),
    });
    const [isFiltersOpen, setIsFiltersOpen] = useState(false);
    const { data: allProposals } = useProposals(treasuryId, {});
    const [searchValue, setSearchValue] = useState(searchParams.get("search") || "");
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const [selectedCount, setSelectedCount] = useState(0);

    const currentTab = searchParams.get("tab") || "pending";

    const handleTabChange = useCallback((value: string) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("tab", value);
        params.delete("page"); // Reset page when changing tabs
        router.push(`${pathname}?${params.toString()}`);
    }, [searchParams, router, pathname]);

    const handleSearchChange = useCallback((value: string) => {
        setSearchValue(value);

        // Clear existing timeout
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }

        // Debounce the URL update
        searchTimeoutRef.current = setTimeout(() => {
            const params = new URLSearchParams(searchParams.toString());
            if (value.trim()) {
                params.set("search", value.trim());
            } else {
                params.delete("search");
            }
            params.delete("page"); // Reset page when search changes
            router.push(`${pathname}?${params.toString()}`);
        }, SEARCH_DEBOUNCE_MS);
    }, [searchParams, router, pathname]);

    // Sync search value with URL params
    useEffect(() => {
        const urlSearch = searchParams.get("search") || "";
        setSearchValue(urlSearch);
    }, [searchParams]);

    // Cleanup timeout on unmount
    useEffect(() => {
        return () => {
            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
            }
        };
    }, []);

    // Check if any filters are active
    const hasActiveFilters = useMemo(() => {
        // Without search as we shouldn't show indicator for search
        const filterParams = ['proposers', 'approvers', 'recipients', 'proposal_types', 'token', 'created_date', 'my_vote'];
        return filterParams.some(param => searchParams.has(param));
    }, [searchParams]);
    const isSearchActive = useMemo(() => {
        return searchParams.has('search');
    }, [searchParams]);

    // Only show "No Requests Found" if there are no proposals AND no filters are active
    if (allProposals?.proposals?.length === 0 && !hasActiveFilters && !isSearchActive) {
        return (
            <PageComponentLayout title="Requests" description="View and manage all pending multisig requests">
                <NoRequestsFound />
            </PageComponentLayout>
        )
    }

    return (
        <PageComponentLayout title="Requests" description="View and manage all pending multisig requests">
            <PageCard className="p-0">
                <Tabs value={currentTab} onValueChange={handleTabChange} className="gap-0">
                    {selectedCount === 0 && (
                        <>
                            <div className="flex flex-col md:flex-row gap-4 items-center md:justify-between border-b p-5 pb-3.5">
                                <TabsList className="w-fit border-none">
                                    <TabsTrigger value="all">All</TabsTrigger>
                                    <TabsTrigger value="pending" className="flex gap-2.5">Pending
                                        {!!proposals?.proposals?.length && proposals?.proposals?.length > 0 && (
                                            <NumberBadge number={proposals?.proposals?.length} variant="secondary" />
                                        )}
                                    </TabsTrigger>
                                    <TabsTrigger value="executed">Executed</TabsTrigger>
                                    <TabsTrigger value="rejected">Rejected</TabsTrigger>
                                    <TabsTrigger value="expired">Expired</TabsTrigger>
                                </TabsList>
                                <div className="flex items-center gap-2">
                                    <Input
                                        type="text"
                                        placeholder="Search request by name or ID"
                                        className="w-64"
                                        search
                                        value={searchValue}
                                        onChange={(e) => handleSearchChange(e.target.value)}
                                    />
                                    <Button
                                        variant="secondary"
                                        className="flex gap-1.5 relative"
                                        onClick={() => setIsFiltersOpen(!isFiltersOpen)}
                                        aria-label={hasActiveFilters ? "Filter (active)" : "Filter"}
                                    >
                                        <ListFilter className="size-4" />
                                        Filter
                                        {hasActiveFilters && (
                                            <span
                                                className="absolute top-1 right-1.5 size-2 rounded-full bg-general-info-foreground"
                                                aria-hidden="true"
                                            />
                                        )}
                                    </Button>
                                </div>
                            </div>

                            <div
                                className="overflow-hidden transition-all duration-500 ease-in-out"
                                style={{
                                    maxHeight: isFiltersOpen ? FILTER_PANEL_MAX_HEIGHT : '0px',
                                    opacity: isFiltersOpen ? 1 : 0,
                                }}
                            >
                                <div className="py-3 px-4">
                                    <ProposalFiltersComponent filterOptions={PROPOSAL_FILTER_OPTIONS} />
                                </div>
                            </div>
                        </>
                    )}
                    <TabsContent value="all">
                        <ProposalsList onSelectionChange={setSelectedCount} />
                    </TabsContent>
                    <TabsContent value="pending">
                        <ProposalsList status={["InProgress"]} onSelectionChange={setSelectedCount} />
                    </TabsContent>
                    <TabsContent value="executed">
                        <ProposalsList status={["Approved"]} onSelectionChange={setSelectedCount} />
                    </TabsContent>
                    <TabsContent value="rejected">
                        <ProposalsList status={["Rejected", "Failed"]} onSelectionChange={setSelectedCount} />
                    </TabsContent>
                    <TabsContent value="expired">
                        <ProposalsList status={["Expired"]} onSelectionChange={setSelectedCount} />
                    </TabsContent>
                </Tabs>
            </PageCard>
        </PageComponentLayout >
    );
}
