"use client";

import { PageCard } from "@/components/card";
import { PageComponentLayout } from "@/components/page-component-layout";
import { Tabs, TabsContent, TabsContents, TabsList, TabsTrigger } from "@/components/underline-tabs";
import { useProposals } from "@/hooks/use-proposals";
import { useTreasury } from "@/stores/treasury-store";
import { getProposals, ProposalStatus } from "@/lib/proposals-api";
import { useSearchParams, useRouter, usePathname, useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { ProposalsTable } from "@/features/proposals";
import { Button } from "@/components/button";
import { ArrowRightLeft, ArrowUpRight, ListFilter } from "lucide-react";
import Link from "next/link";
import { useTreasuryPolicy, useTreasuryConfig } from "@/hooks/use-treasury-queries";
import { useQueryClient } from "@tanstack/react-query";
import { ProposalFilters as ProposalFiltersComponent } from "@/features/proposals/components/proposal-filters";
import { convertUrlParamsToApiFilters } from "@/features/proposals/utils/filter-params-converter";
import { NumberBadge } from "@/components/number-badge";
import { TableSkeleton } from "@/components/table-skeleton";
import { Input } from "@/components/ui/input";
import { useNear } from "@/stores/near-store";

function ProposalsList({ status }: { status?: ProposalStatus[] }) {
  const { selectedTreasury } = useTreasury();
  const { data: policy } = useTreasuryPolicy(selectedTreasury);
  const { data: config } = useTreasuryConfig(selectedTreasury);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { accountId } = useNear();

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

  const { data, isLoading, error } = useProposals(selectedTreasury, filters);

  // Prefetch the next page
  useEffect(() => {
    if (selectedTreasury && data && data.proposals.length === pageSize && (page + 1) * pageSize < data.total) {
      const nextFilters = {
        ...filters,
        page: page + 1,
      };

      queryClient.prefetchQuery({
        queryKey: ["proposals", selectedTreasury, nextFilters],
        queryFn: () => getProposals(selectedTreasury, nextFilters),
      });
    }
  }, [data, page, selectedTreasury, filters, queryClient, pageSize]);

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
          pageIndex={page}
          pageSize={pageSize}
          total={data?.total ?? 0}
          onPageChange={updatePage}
        />
      )}
    </div>
  );
}

function NoRequestsFound() {
  const { selectedTreasury: treasuryId } = useTreasury();
  return (
    <PageCard className="py-[100px] flex flex-col items-center justify-center w-full h-fit gap-4">
      <div className="flex flex-col items-center justify-center gap-0.5">
        <h1 className="font-semibold">Create your first request</h1>
        <p className="text-xs text-muted-foreground max-w-[300px] text-center">Requests for payments, exchanges, and other actions will appear here once created.</p>
      </div>
      <div className="flex gap-4 w-[300px]">
        <Link href={`/${treasuryId}/payments`} className="w-1/2">
          <Button className="gap-1 w-full">
            <ArrowUpRight className="size-3.5" /> Send
          </Button>
        </Link>
        <Link href={`/${treasuryId}/exchange`} className="w-1/2">
          <Button className="gap-1 w-full">
            <ArrowRightLeft className="size-3.5" /> Exchange
          </Button>
        </Link>
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
  const { data: proposals } = useProposals(treasuryId, {
    statuses: ["InProgress"],
  })
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  const { data: allProposals } = useProposals(treasuryId, {});
  const [searchValue, setSearchValue] = useState(searchParams.get("search") || "");
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);


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
    }, 300);
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
    const filterParams = ['proposers', 'approvers', 'recipients', 'proposal_types', 'tokens', 'created_date', 'my_vote', 'search'];
    return filterParams.some(param => searchParams.has(param));
  }, [searchParams]);

  // Only show "No Requests Found" if there are no proposals AND no filters are active
  if (allProposals?.proposals?.length === 0 && !hasActiveFilters) {
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
          <div className="flex flex-col md:flex-row gap-4 items-center justify-between border-b p-5 pb-3.5">
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
                value={searchValue}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
              <Button variant="secondary" className="flex gap-1.5" onClick={() => setIsFiltersOpen(!isFiltersOpen)}>
                <ListFilter className="size-4" />
                Filter
              </Button>
            </div>
          </div>

          <div
            className="overflow-hidden transition-all duration-500 ease-in-out"
            style={{
              maxHeight: isFiltersOpen ? '100px' : '0px',
              opacity: isFiltersOpen ? 1 : 0,
            }}
          >
            <div className="py-3 px-4">
              <ProposalFiltersComponent />
            </div>
          </div>
          <TabsContents>
            <TabsContent value="all">
              <ProposalsList />
            </TabsContent>
            <TabsContent value="pending">
              <ProposalsList status={["InProgress"]} />
            </TabsContent>
            <TabsContent value="executed">
              <ProposalsList status={["Approved"]} />
            </TabsContent>
            <TabsContent value="rejected">
              <ProposalsList status={["Rejected", "Failed"]} />
            </TabsContent>
            <TabsContent value="expired">
              <ProposalsList status={["Expired"]} />
            </TabsContent>
          </TabsContents>
        </Tabs>
      </PageCard>
    </PageComponentLayout >
  );
}
