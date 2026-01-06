"use client";

import { PageCard } from "@/components/card";
import { PageComponentLayout } from "@/components/page-component-layout";
import { Tabs, TabsContent, TabsContents, TabsList, TabsTrigger } from "@/components/underline-tabs";
import { useProposals } from "@/hooks/use-proposals";
import { useTreasury } from "@/stores/treasury-store";
import { getProposals, ProposalStatus } from "@/lib/proposals-api";
import { useSearchParams, useRouter, usePathname, useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ProposalsTable } from "@/features/proposals";
import { Button } from "@/components/button";
import { Download } from "lucide-react";
import { useTreasuryPolicy, useTreasuryConfig } from "@/hooks/use-treasury-queries";
import { useQueryClient } from "@tanstack/react-query";
import { ProposalFilters as ProposalFiltersComponent } from "@/features/proposals/components/proposal-filters";
import { addDays } from "date-fns";

function ProposalsList({ status }: { status?: ProposalStatus[] }) {
  const { selectedTreasury } = useTreasury();
  const { data: policy } = useTreasuryPolicy(selectedTreasury);
  const { data: config } = useTreasuryConfig(selectedTreasury);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();

  const page = parseInt(searchParams.get("page") || "0", 10);
  const pageSize = 15;

  const filters = useMemo(() => {
    const f: any = {
      page,
      page_size: pageSize,
      sort_by: "CreationTime",
      sort_direction: "desc",
    };

    if (status) f.statuses = status;

    const typeParam = searchParams.get("proposal_types");
    if (typeParam) {
      f.proposal_types = [typeParam];
    }

    const proposerParam = searchParams.get("proposers");
    if (proposerParam) f.proposers = [proposerParam];

    const approverParam = searchParams.get("approvers");
    if (approverParam) f.approvers = [approverParam];

    const recipientParam = searchParams.get("recipients");
    if (recipientParam) f.recipients = [recipientParam];

    const tokenParam = searchParams.get("tokens");
    if (tokenParam) f.tokens = [tokenParam];

    const searchParam = searchParams.get("search");
    if (searchParam) f.search = searchParam;

    const dateParam = searchParams.get("created_date");
    if (dateParam) {
      const date = new Date(dateParam);
      f.created_date_from = date.toISOString().split('T')[0];
      // Add 1 day to the date
      f.created_date_to = addDays(date, 1).toISOString().split('T')[0];
    }

    return f;
  }, [page, pageSize, searchParams]);

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
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-muted-foreground">Loading proposals...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-destructive">Error loading proposals. Please try again.</p>
      </div>
    );
  }

  if (!data || (data.proposals.length === 0 && page === 0)) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-muted-foreground">No proposals found.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {policy && (
        <ProposalsTable
          proposals={data.proposals}
          policy={policy}
          config={config?.config}
          pageIndex={page}
          pageSize={pageSize}
          total={data.total}
          onPageChange={updatePage}
        />
      )}
    </div>
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


  const currentTab = searchParams.get("tab") || "pending";

  const handleTabChange = useCallback((value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", value);
    params.delete("page"); // Reset page when changing tabs
    router.push(`${pathname}?${params.toString()}`);
  }, [searchParams, router, pathname]);

  return (
    <PageComponentLayout title="Requests" description="View and manage all pending multisig requests">
      <PageCard>
        <Tabs value={currentTab} onValueChange={handleTabChange}>
          <div className="flex items-center justify-between mb-4">
            <TabsList className="w-fit border-none">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="pending" className="flex gap-1">Pending
                {proposals?.proposals && proposals.proposals.length > 0 &&
                  < span className="flex size-5 items-center justify-center rounded-[8px] px-2 py-[3px] bg-orange-500 text-xs font-semibold text-white">
                    {proposals?.proposals.length}
                  </span>
                }
              </TabsTrigger>
              <TabsTrigger value="executed">Executed</TabsTrigger>
              <TabsTrigger value="rejected">Rejected</TabsTrigger>
              <TabsTrigger value="expired">Expired</TabsTrigger>
            </TabsList>
            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" className="h-9">
                <Download className="h-4 w-4 mr-2" />
                Export
              </Button>
            </div>
          </div>
          <div className="mb-4">
            <ProposalFiltersComponent />
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
