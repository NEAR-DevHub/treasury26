"use client";

import { PageComponentLayout } from "@/components/page-component-layout";
import { PageCard } from "@/components/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/underline-tabs";
import { useRecentActivity } from "@/hooks/use-treasury-queries";
import { useSubscription } from "@/hooks/use-subscription";
import { useTreasury } from "@/hooks/use-treasury";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { ActivityTable } from "./components/activity-table";
import { ProposalFilters as GenericFilters, FilterOption } from "@/features/proposals/components/proposal-filters";
import { Button } from "@/components/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ListFilter } from "lucide-react";
import { MemberOnlyExportButton } from "../dashboard/components/member-only-export-button";
import { getHistoryDescription } from "@/lib/utils/plan-utils";
import { subMonths } from "date-fns";

// Constants
const PAGE_SIZE = 10;
const FILTER_PANEL_MAX_HEIGHT = '500px';

function ActivityList({ status }: { status?: "incoming" | "outgoing" }) {
    const { treasuryId } = useTreasury();
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();

    const page = parseInt(searchParams.get("page") || "0", 10);

    const updatePage = useCallback((newPage: number) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("page", newPage.toString());
        router.push(`${pathname}?${params.toString()}`);
    }, [searchParams, router, pathname]);

    // Parse filter parameters
    const minUsdValue = searchParams.get("min_usd_value")
        ? parseFloat(searchParams.get("min_usd_value")!)
        : undefined;

    // Parse date filter
    const createdDateFilter = searchParams.get("created_date");
    let startDate: string | undefined;
    let endDate: string | undefined;

    if (createdDateFilter) {
        try {
            const parsed = JSON.parse(createdDateFilter);
            if (parsed.dateRange) {
                startDate = parsed.dateRange.from;
                endDate = parsed.dateRange.to;
            }
        } catch (e) {
            console.error("Failed to parse created_date filter:", e);
        }
    }

    // Parse token filter
    const tokenFilter = searchParams.get("token");
    let tokenIds: string[] | undefined;

    if (tokenFilter) {
        try {
            const parsed = JSON.parse(tokenFilter);
            if (parsed.token && parsed.token.id) {
                tokenIds = [parsed.token.id];
            }
        } catch (e) {
            console.error("Failed to parse token filter:", e);
        }
    }

    const { data, isLoading } = useRecentActivity(
        treasuryId,
        PAGE_SIZE,
        page * PAGE_SIZE,
        minUsdValue,
        status,
        tokenIds,
        startDate,
        endDate,
    );

    return (
        <ActivityTable
            activities={data?.data ?? []}
            isLoading={isLoading}
            pageIndex={page}
            pageSize={PAGE_SIZE}
            total={data?.total ?? 0}
            onPageChange={updatePage}
        />
    );
}

export default function ActivityPage() {
    const { treasuryId } = useTreasury();
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const { data: subscriptionData } = useSubscription(treasuryId);
    const [isFiltersOpen, setIsFiltersOpen] = useState(false);
    const [hideSmallTransactions, setHideSmallTransactions] = useState(
        searchParams.get("min_usd_value") === "1"
    );

    const currentTab = searchParams.get("tab") || "all";

    // Calculate filter options with date restrictions based on plan
    const activityFilterOptions: FilterOption[] = useMemo(() => {
        const minDate = subscriptionData?.planConfig?.limits?.historyLookupMonths
            ? subMonths(new Date(), subscriptionData.planConfig.limits.historyLookupMonths)
            : undefined;

        return [
            {
                id: "created_date",
                label: "Created Date",
                minDate,
                maxDate: new Date()
            },
            {
                id: "token",
                label: "Token"
            },
        ];
    }, [subscriptionData?.planConfig?.limits?.historyLookupMonths]);

    const handleTabChange = useCallback((value: string) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("tab", value);
        params.delete("page"); // Reset page when changing tabs
        router.push(`${pathname}?${params.toString()}`);
    }, [searchParams, router, pathname]);

    const handleHideSmallTransactions = useCallback((checked: boolean) => {
        setHideSmallTransactions(checked);
        const params = new URLSearchParams(searchParams.toString());
        if (checked) {
            params.set("min_usd_value", "1");
        } else {
            params.delete("min_usd_value");
        }
        params.delete("page"); // Reset page when filter changes
        router.push(`${pathname}?${params.toString()}`);
    }, [searchParams, router, pathname]);

    // Check if any filters are active
    const hasActiveFilters = useMemo(() => {
        const filterParams = ['created_date', 'token', 'min_usd_value'];
        return filterParams.some(param => searchParams.has(param));
    }, [searchParams]);

    return (
        <PageComponentLayout
            title="Recent Transactions"
            description={getHistoryDescription(subscriptionData?.planConfig?.limits?.historyLookupMonths)}
            backButton={`/${treasuryId}/dashboard`}
        >
            <PageCard className="p-0">
                <Tabs value={currentTab} onValueChange={handleTabChange} className="gap-0">
                    <div className="flex flex-col md:flex-row gap-4 items-center md:justify-between border-b p-5 pb-3.5">
                        <TabsList className="w-fit border-none">
                            <TabsTrigger value="all">All</TabsTrigger>
                            <TabsTrigger value="outgoing">Sent</TabsTrigger>
                            <TabsTrigger value="incoming">Received</TabsTrigger>
                        </TabsList>
                        <div className="flex items-center gap-3">
                            <div className="flex items-center gap-2">
                                <Checkbox
                                    id="hide-small-transactions"
                                    checked={hideSmallTransactions}
                                    onCheckedChange={handleHideSmallTransactions}
                                />
                                <label
                                    htmlFor="hide-small-transactions"
                                    className="text-sm leading-none cursor-pointer whitespace-nowrap text-muted-foreground"
                                >
                                    Hide transactions &lt;1USD
                                </label>
                            </div>
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
                            <MemberOnlyExportButton />
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
                            <GenericFilters filterOptions={activityFilterOptions} />
                        </div>
                    </div>

                    <TabsContent value="all">
                        <ActivityList />
                    </TabsContent>
                    <TabsContent value="outgoing">
                        <ActivityList status="outgoing" />
                    </TabsContent>
                    <TabsContent value="incoming">
                        <ActivityList status="incoming" />
                    </TabsContent>
                </Tabs>
            </PageCard>
        </PageComponentLayout>
    );
}

