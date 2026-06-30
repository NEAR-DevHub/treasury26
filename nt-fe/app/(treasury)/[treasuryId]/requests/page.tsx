"use client";

import { useTranslations } from "next-intl";
import { PageCard } from "@/components/card";
import { ConfidentialState } from "@/components/confidential-state";
import { PageComponentLayout } from "@/components/page-component-layout";
import { TabsContent } from "@/components/underline-tabs";
import { useProposals } from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";
import { getProposals, ProposalStatus } from "@/lib/proposals-api";
import {
    useSearchParams,
    useRouter,
    usePathname,
    useParams,
} from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { ProposalsTable } from "@/features/proposals";
import { Button } from "@/components/button";
import { ArrowRightLeft, ArrowUpRight, ListFilter, Send } from "lucide-react";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useQueryClient } from "@tanstack/react-query";
import {
    ProposalFilters as ProposalFiltersComponent,
    FilterOption,
} from "@/features/proposals/components/proposal-filters";
import { convertUrlParamsToApiFilters } from "@/features/proposals/utils/filter-params-converter";
import { NumberBadge } from "@/components/number-badge";
import { TableSkeleton } from "@/components/table-skeleton";
import { ResponsiveInput } from "@/components/input";
import { useNear } from "@/stores/near-store";
import { AuthButton } from "@/components/auth-button";
import { EmptyState } from "@/components/empty-state";
import { ResponsiveTabs, TabItem } from "@/components/responsive-tabs";

// Constants
const SEARCH_DEBOUNCE_MS = 300;
const FILTER_PANEL_MAX_HEIGHT = "500px";

function useProposalFilterOptions(): FilterOption[] {
    const tFilters = useTranslations("requests.filters");
    return useMemo(
        () => [
            { id: "proposal_types", label: tFilters("requestsType") },
            {
                id: "created_date",
                label: tFilters("createdDate"),
                maxDate: new Date(),
            },
            { id: "recipients", label: tFilters("recipient") },
            { id: "token", label: tFilters("token") },
            { id: "proposers", label: tFilters("requester") },
            { id: "approvers", label: tFilters("approver") },
            { id: "my_vote", label: tFilters("myVoteStatus") },
        ],
        [tFilters],
    );
}

function ProposalsList({
    status,
    onSelectionChange,
}: {
    status?: ProposalStatus;
    onSelectionChange?: (count: number) => void;
}) {
    const { treasuryId, config, isConfidential, isGuestTreasury } =
        useTreasury();
    const isConfidentialGuest = isConfidential && isGuestTreasury;
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const queryClient = useQueryClient();
    const { accountId } = useNear();

    const hasActiveFilters = useMemo(() => {
        const filterParams = [
            "proposers",
            "approvers",
            "recipients",
            "proposal_types",
            "token",
            "created_date",
            "my_vote",
            "search",
        ];
        return (
            filterParams.some((param) => searchParams.has(param)) ||
            (status !== "InProgress" && status !== undefined)
        );
    }, [searchParams]);

    const page = parseInt(searchParams.get("page") || "0", 10);
    const pageSize = 15;

    const filters = useMemo(() => {
        const urlFilters = convertUrlParamsToApiFilters(
            searchParams,
            accountId,
        );
        const f: any = {
            ...urlFilters,
            page,
            page_size: pageSize,
            sort_by: "CreationTime",
            sort_direction: "desc",
        };

        // Add status filter if provided
        if (status) f.statuses = [status];

        return f;
    }, [page, pageSize, searchParams, status, accountId]);

    const updatePage = useCallback(
        (newPage: number) => {
            const params = new URLSearchParams(searchParams.toString());
            params.set("page", newPage.toString());
            router.push(`${pathname}?${params.toString()}`);
        },
        [searchParams, router, pathname],
    );

    const { data, isLoading } = useProposals(treasuryId, filters);

    // Prefetch the next page
    useEffect(() => {
        if (
            !isConfidentialGuest &&
            treasuryId &&
            data &&
            data.proposals.length === pageSize &&
            (page + 1) * pageSize < data.total
        ) {
            const nextFilters = {
                ...filters,
                page: page + 1,
            };

            queryClient.prefetchQuery({
                queryKey: ["proposals", treasuryId, nextFilters],
                queryFn: () => getProposals(treasuryId, nextFilters),
            });
        }
    }, [
        data,
        page,
        treasuryId,
        filters,
        queryClient,
        pageSize,
        isConfidentialGuest,
    ]);

    if (isConfidentialGuest) {
        return (
            <ConfidentialState
                skeleton={<TableSkeleton rows={12} columns={7} />}
            />
        );
    }

    if (isLoading) {
        return <TableSkeleton rows={12} columns={7} />;
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
    const tEmpty = useTranslations("requests.empty");
    const { treasuryId: treasuryId } = useTreasury();
    const router = useRouter();
    return (
        <PageCard className="py-[100px] flex flex-col items-center justify-center w-full h-fit gap-4">
            <EmptyState
                icon={Send}
                title={tEmpty("title")}
                description={tEmpty("description")}
                className="py-0"
            />
            <div className="flex gap-4 w-[300px]">
                <AuthButton
                    permissionKind="transfer"
                    onClick={() => router.push(`/${treasuryId}/payments`)}
                    permissionAction="AddProposal"
                    className="gap-1 w-full shrink"
                >
                    <ArrowUpRight className="size-3.5" /> {tEmpty("send")}
                </AuthButton>
                <AuthButton
                    permissionKind="call"
                    onClick={() => router.push(`/${treasuryId}/exchange`)}
                    permissionAction="AddProposal"
                    className="gap-1 w-full shrink"
                >
                    <ArrowRightLeft className="size-3.5" /> {tEmpty("exchange")}
                </AuthButton>
            </div>
        </PageCard>
    );
}

export default function RequestsPage() {
    const t = useTranslations("pages.requests");
    const tReq = useTranslations("requests");
    const tCommon = useTranslations("common");
    const filterOptions = useProposalFilterOptions();
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const params = useParams();
    const treasuryId = params?.treasuryId as string | undefined;
    const { accountId } = useNear();
    const { isConfidential, isGuestTreasury } = useTreasury();
    const isConfidentialGuest = isConfidential && isGuestTreasury;
    const { data: proposals } = useProposals(treasuryId, {
        statuses: ["InProgress"],
        ...(accountId && {
            voter_votes: `${accountId}:No Voted`,
        }),
    });
    const [isFiltersOpen, setIsFiltersOpen] = useState(false);
    const { data: allProposals } = useProposals(treasuryId, {});
    const [searchValue, setSearchValue] = useState(
        searchParams.get("search") || "",
    );
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const [selectedCount, setSelectedCount] = useState(0);

    const currentTab = searchParams.get("tab") || "InProgress";

    const handleTabChange = useCallback(
        (value: string) => {
            const params = new URLSearchParams(searchParams.toString());
            params.set("tab", value);
            params.delete("page");
            router.push(`${pathname}?${params.toString()}`);
        },
        [searchParams, router, pathname],
    );

    const handleSearchChange = useCallback(
        (value: string) => {
            setSearchValue(value);

            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
            }

            searchTimeoutRef.current = setTimeout(() => {
                const params = new URLSearchParams(searchParams.toString());
                if (value.trim()) {
                    params.set("search", value.trim());
                } else {
                    params.delete("search");
                }
                params.delete("page");
                router.push(`${pathname}?${params.toString()}`);
            }, SEARCH_DEBOUNCE_MS);
        },
        [searchParams, router, pathname],
    );

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

    const hasActiveFilters = useMemo(() => {
        const filterParams = [
            "proposers",
            "approvers",
            "recipients",
            "proposal_types",
            "token",
            "created_date",
            "my_vote",
        ];
        return filterParams.some((param) => searchParams.has(param));
    }, [searchParams]);

    const isSearchActive = useMemo(() => {
        return searchParams.has("search");
    }, [searchParams]);

    const pendingCount = proposals?.proposals?.length;

    const tabs: TabItem[] = [
        { value: "All", label: tReq("tabs.all") },
        {
            value: "InProgress",
            label: tReq("tabs.pending"),
            trigger:
                !!pendingCount && pendingCount > 0 ? (
                    <NumberBadge number={pendingCount} variant="secondary" />
                ) : undefined,
        },
        { value: "Approved", label: tReq("tabs.executed") },
        { value: "Rejected", label: tReq("tabs.rejected") },
        { value: "Expired", label: tReq("tabs.expired") },
        { value: "Failed", label: tReq("tabs.failed") },
    ];

    if (isConfidentialGuest) {
        return (
            <PageComponentLayout
                title={t("title")}
                description={t("description")}
            >
                <PageCard>
                    <ConfidentialState
                        skeleton={<TableSkeleton rows={12} columns={7} />}
                    />
                </PageCard>
            </PageComponentLayout>
        );
    }

    // Only show "No Requests Found" if there are no proposals AND no filters are active
    if (
        allProposals?.proposals?.length === 0 &&
        !hasActiveFilters &&
        !isSearchActive
    ) {
        return (
            <PageComponentLayout
                title={t("title")}
                description={t("description")}
            >
                <NoRequestsFound />
            </PageComponentLayout>
        );
    }

    const tabContents = tabs.map(({ value }) => (
        <TabsContent key={value} value={value}>
            <ProposalsList
                status={value === "All" ? undefined : (value as ProposalStatus)}
                onSelectionChange={setSelectedCount}
            />
        </TabsContent>
    ));

    const actions = (
        <div className="flex items-center justify-end w-full gap-2">
            <ResponsiveInput
                type="text"
                placeholder={tReq("searchPlaceholder")}
                mobilePlaceholder={tReq("searchPlaceholderShort")}
                className="max-w-72 w-full"
                search
                value={searchValue}
                onChange={(e) => handleSearchChange(e.target.value)}
            />

            <Button
                variant="secondary"
                size="icon"
                className="relative md:w-auto md:px-3 md:gap-1.5"
                onClick={() => setIsFiltersOpen(!isFiltersOpen)}
                aria-label={
                    hasActiveFilters
                        ? tCommon("filterActive")
                        : tCommon("filter")
                }
            >
                <ListFilter className="size-4" />
                <span className="hidden md:inline">{tCommon("filter")}</span>
                {hasActiveFilters && (
                    <span
                        className="absolute top-1 right-1.5 size-2 rounded-full bg-general-info-foreground"
                        aria-hidden="true"
                    />
                )}
            </Button>
        </div>
    );

    const filterPanel = selectedCount === 0 && (
        <div
            className="overflow-hidden transition-all duration-500 ease-in-out"
            style={{
                maxHeight: isFiltersOpen ? FILTER_PANEL_MAX_HEIGHT : "0px",
                opacity: isFiltersOpen ? 1 : 0,
            }}
        >
            <div className="py-3 px-4">
                <ProposalFiltersComponent filterOptions={filterOptions} />
            </div>
        </div>
    );

    return (
        <PageComponentLayout title={t("title")} description={t("description")}>
            <PageCard className="p-0">
                <ResponsiveTabs
                    tabs={tabs}
                    value={currentTab}
                    onValueChange={handleTabChange}
                    actions={actions}
                    hideHeader={selectedCount > 0}
                >
                    {filterPanel}
                    {tabContents}
                </ResponsiveTabs>
            </PageCard>
        </PageComponentLayout>
    );
}
