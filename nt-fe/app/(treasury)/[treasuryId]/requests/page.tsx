"use client";

import {
    ArrowLeftRightIcon,
    FilterIcon,
    SentIcon,
} from "@hugeicons/core-free-icons";
import { useQueryClient } from "@tanstack/react-query";
import {
    useParams,
    usePathname,
    useRouter,
    useSearchParams,
} from "next/navigation";
import { useTranslations } from "next-intl";
import {
    type ReactNode,
    useCallback,
    useEffect,
    useMemo,
    useState,
} from "react";
import { AuthButton } from "@/components/auth-button";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { Icon } from "@/components/icon";
import { ResponsiveInput } from "@/components/input";
import { NumberBadge } from "@/components/number-badge";
import { PageComponentLayout } from "@/components/page-component-layout";
import { ResponsiveTabs, type TabItem } from "@/components/responsive-tabs";
import { TabsContent } from "@/components/underline-tabs";
import { ProposalsTable } from "@/features/proposals";
import { MobileFilterSheet } from "@/features/proposals/components/mobile-filter-sheet";
import {
    type FilterOption,
    ProposalFilters as ProposalFiltersComponent,
} from "@/features/proposals/components/proposal-filters";
import {
    ProposalCardSkeleton,
    ProposalsTableSkeleton,
} from "@/features/proposals/components/proposals-skeleton";
import { hasFilterValue } from "@/features/proposals/types/filter-types";
import { convertUrlParamsToApiFilters } from "@/features/proposals/utils/filter-params-converter";
import { useProposals } from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { getProposals, type ProposalStatus } from "@/lib/proposals-api";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import { useResponsiveSidebar } from "@/stores/sidebar-store";

// Constants
const SEARCH_DEBOUNCE_MS = 300;
const FILTER_PANEL_MAX_HEIGHT = "500px";
/** How many card placeholders the phone list shows while a page loads. */
const SKELETON_CARDS = ["a", "b", "c", "d", "e", "f"];
/** The 40px #F2F2F2, 12px-radius square the design gives the toolbar controls. */
const ICON_BUTTON_CLASS =
    "size-10 rounded-lg bg-general-bg-secondary hover:bg-general-bg-secondary/80";

function useProposalFilterOptions(): FilterOption[] {
    const tFilters = useTranslations("requests.filters");
    const { isConfidential, isGuestTreasury } = useTreasury();
    const isConfidentialGuest = isConfidential && isGuestTreasury;
    return useMemo(
        () => [
            { id: "proposal_types", label: tFilters("requestsType") },
            {
                id: "created_date",
                label: tFilters("createdDate"),
                maxDate: new Date(),
            },
            // Recipient and token are hidden data for confidential guests
            ...(isConfidentialGuest
                ? []
                : [{ id: "recipients", label: tFilters("recipient") }]),
            { id: "proposers", label: tFilters("requester") },
            ...(isConfidentialGuest
                ? []
                : [{ id: "token", label: tFilters("token") }]),
            { id: "approvers", label: tFilters("approver") },
            { id: "my_vote", label: tFilters("myVoteStatus") },
        ],
        [tFilters, isConfidentialGuest],
    );
}

/**
 * The URL params the filter panel writes. The tab and the search box narrow the
 * table too, but neither is edited through the panel, so they're reported
 * separately rather than folded into the count.
 */
const FILTER_PARAM_IDS = [
    "proposers",
    "approvers",
    "recipients",
    "proposal_types",
    "token",
    "created_date",
    "my_vote",
] as const;

/**
 * One reading of "is this list filtered?" for the toolbar and the table alike:
 * `activeFilterCount` labels the Filters button, `isNarrowed` decides whether
 * an empty table means "nothing here" or "nothing matched".
 */
function useActiveFilters(status?: ProposalStatus) {
    const searchParams = useSearchParams();

    return useMemo(() => {
        // A filter that has been added but has no value picked yet isn't
        // narrowing anything, so it isn't counted.
        const activeFilterCount = FILTER_PARAM_IDS.filter((param) =>
            hasFilterValue(searchParams.get(param)),
        ).length;

        return {
            activeFilterCount,
            hasActiveFilters: activeFilterCount > 0,
            isNarrowed:
                activeFilterCount > 0 ||
                Boolean(searchParams.get("search")?.trim()) ||
                (status !== undefined && status !== "InProgress"),
        };
    }, [searchParams, status]);
}

function ProposalsList({
    status,
    onSelectionChange,
}: {
    status?: ProposalStatus;
    onSelectionChange?: (count: number) => void;
}) {
    const { treasuryId, config } = useTreasury();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const queryClient = useQueryClient();
    const { accountId } = useNear();

    const { isNarrowed } = useActiveFilters(status);

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
    }, [data, page, treasuryId, filters, queryClient, pageSize]);

    if (isLoading) {
        return (
            <>
                <div className="flex flex-col gap-3 lg:hidden">
                    {SKELETON_CARDS.map((key) => (
                        <ProposalCardSkeleton key={key} />
                    ))}
                </div>
                <ProposalsTableSkeleton className="hidden lg:block" />
            </>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            {policy && (
                <ProposalsTable
                    proposals={data?.proposals ?? []}
                    policy={policy}
                    config={config}
                    withFilters={isNarrowed}
                    searchQuery={searchParams.get("search") || ""}
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

/**
 * The shell header shows the treasury on a phone, not the page, so the page
 * names itself above its content.
 */
function MobilePageHeading({ children }: { children: ReactNode }) {
    return (
        <h1 className="mt-3 mb-5 text-xl font-semibold leading-[1.2] tracking-tight lg:hidden">
            {children}
        </h1>
    );
}

function NoRequestsFound() {
    const tEmpty = useTranslations("requests.empty");
    const { treasuryId } = useTreasury();
    const router = useRouter();
    return (
        <PageCard className="py-[100px] flex flex-col items-center justify-center w-full h-fit gap-4">
            <EmptyState
                icon={SentIcon}
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
                    <Icon icon={SentIcon} /> {tEmpty("send")}
                </AuthButton>
                <AuthButton
                    permissionKind="call"
                    onClick={() => router.push(`/${treasuryId}/exchange`)}
                    permissionAction="AddProposal"
                    className="gap-1 w-full shrink"
                >
                    <Icon icon={ArrowLeftRightIcon} /> {tEmpty("exchange")}
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
    const { data: proposals } = useProposals(treasuryId, {
        statuses: ["InProgress"],
        ...(accountId && {
            voter_votes: `${accountId}:No Voted`,
        }),
    });
    // The same source `ProposalsTable` reads, so the filter sheet and the row
    // click agree on where "mobile" ends.
    const { isMobile } = useResponsiveSidebar();
    const [isFiltersOpen, setIsFiltersOpen] = useState(false);
    const [isMobileFiltersOpen, setIsMobileFiltersOpen] = useState(false);
    // An open search owns the whole phone toolbar, so the tab picker and the
    // filters button step aside for it.
    const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
    const { data: allProposals } = useProposals(treasuryId, {});
    const [searchValue, setSearchValue] = useState(
        searchParams.get("search") || "",
    );
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
            const params = new URLSearchParams(searchParams.toString());
            if (value.trim()) {
                params.set("search", value.trim());
            } else {
                params.delete("search");
            }
            params.delete("page");
            router.push(`${pathname}?${params.toString()}`);
        },
        [searchParams, router, pathname],
    );

    // Sync search value with URL params
    useEffect(() => {
        const urlSearch = searchParams.get("search") || "";
        setSearchValue(urlSearch);
    }, [searchParams]);

    const { activeFilterCount, hasActiveFilters } = useActiveFilters();

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
                    <NumberBadge
                        number={pendingCount}
                        variant="outline"
                        shape="pill"
                    />
                ) : undefined,
        },
        { value: "Approved", label: tReq("tabs.executed") },
        { value: "Rejected", label: tReq("tabs.rejected") },
        { value: "Expired", label: tReq("tabs.expired") },
        { value: "Failed", label: tReq("tabs.failed") },
    ];

    // Only show "No Requests Found" if there are no proposals AND no filters are active
    if (
        allProposals?.proposals?.length === 0 &&
        !hasActiveFilters &&
        !isSearchActive
    ) {
        return (
            <PageComponentLayout title={t("title")}>
                <MobilePageHeading>{t("title")}</MobilePageHeading>
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

    const filtersLabel = hasActiveFilters
        ? tCommon("filtersWithCount", { count: activeFilterCount })
        : tCommon("filters");

    const actions = (
        // Full width on a phone so the expanded search can take over the row.
        <div className="flex w-full items-center justify-end gap-2 md:w-auto">
            <ResponsiveInput
                type="text"
                placeholder={tReq("searchPlaceholder")}
                mobilePlaceholder={tReq("searchPlaceholderShort")}
                className="h-10 md:w-[290px] md:shrink-0"
                buttonClassName={ICON_BUTTON_CLASS}
                mobileCloseButton
                onSearchActiveChange={setIsMobileSearchOpen}
                inputClassName="rounded-lg border border-general-border bg-card! hover:bg-card! pl-9 text-sm placeholder:font-medium placeholder:text-sm placeholder:text-general-muted-foreground dark:placeholder:text-muted-foreground focus-visible:border-general-border focus-visible:ring-0"
                searchIconClassName="left-2 size-5 text-general-muted-foreground dark:text-muted-foreground"
                search
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                onDebouncedChange={handleSearchChange}
                debounceMs={SEARCH_DEBOUNCE_MS}
            />

            <Button
                variant="secondary"
                size="icon"
                className={cn(
                    ICON_BUTTON_CLASS,
                    "md:h-10 md:w-auto md:gap-2 md:px-4 md:text-sm",
                    isMobileSearchOpen && "hidden md:inline-flex",
                    // Active state is the design's gray-900 (#171717) surface.
                    hasActiveFilters
                        ? "bg-general-foreground text-background hover:bg-general-foreground/90"
                        : "text-muted-foreground",
                )}
                // A popover row of filter pills has nowhere to go on a phone,
                // so mobile drills into the same filters through a sheet.
                onClick={() =>
                    isMobile
                        ? setIsMobileFiltersOpen(true)
                        : setIsFiltersOpen(!isFiltersOpen)
                }
                aria-label={filtersLabel}
            >
                <Icon icon={FilterIcon} className="md:size-[13.25px]" />
                <span className="hidden md:inline">{filtersLabel}</span>
            </Button>
        </div>
    );

    // Mobile edits the same filters through `MobileFilterSheet`, so the inline
    // panel is desktop-only rather than merely collapsed. `lg` is where
    // `isMobile` flips, so the panel is never shown without a way to open it.
    const filterPanel = selectedCount === 0 && (
        <div
            className="hidden overflow-hidden transition-all duration-500 ease-in-out lg:block"
            style={{
                maxHeight: isFiltersOpen ? FILTER_PANEL_MAX_HEIGHT : "0px",
                opacity: isFiltersOpen ? 1 : 0,
            }}
        >
            <ProposalFiltersComponent filterOptions={filterOptions} />
        </div>
    );

    return (
        <PageComponentLayout title={t("title")}>
            <MobilePageHeading>{t("title")}</MobilePageHeading>
            <ResponsiveTabs
                tabs={tabs}
                value={currentTab}
                onValueChange={handleTabChange}
                actions={actions}
                hideTabSelect={isMobileSearchOpen}
                hideHeader={selectedCount > 0}
                variant="plain"
                className="gap-5 md:gap-4"
            >
                {filterPanel}
                {tabContents}
            </ResponsiveTabs>
            <MobileFilterSheet
                filterOptions={filterOptions}
                open={isMobileFiltersOpen}
                onOpenChange={setIsMobileFiltersOpen}
            />
        </PageComponentLayout>
    );
}
