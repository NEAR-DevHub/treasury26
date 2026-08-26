"use client";

import { FilterIcon } from "@hugeicons/core-free-icons";
import { subMonths } from "date-fns";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { ResponsiveInput } from "@/components/input";
import { PageComponentLayout } from "@/components/page-component-layout";
import {
    ResponsiveTabs,
    type TabItem,
    TabsContent,
} from "@/components/responsive-tabs";
import { ActivityTable } from "@/features/activity";
import { HistoryRefreshButton } from "@/features/activity/components/history-refresh-button";
import {
    type FilterOption,
    ProposalFilters as GenericFilters,
} from "@/features/proposals/components/proposal-filters";
import { hasFilterValue } from "@/features/proposals/types/filter-types";
import { useSubscription } from "@/hooks/use-subscription";
import { useTreasury } from "@/hooks/use-treasury";
import {
    useRecentActivity,
    useRecentActivityRecipients,
    useRecentActivitySenders,
} from "@/hooks/use-treasury-queries";
import { cn } from "@/lib/utils";

// Constants
const PAGE_SIZE = 15;
const FILTER_PANEL_MAX_HEIGHT = "500px";

/** Backend activity statuses the tabs can filter by ("all" filters by nothing). */
type ActivityStatus = "outgoing" | "incoming" | "exchange";
type ActivityTab = TabItem & { value: "all" | ActivityStatus };

function getSelectedAccountsFromFilter(filterValue: string | null): string[] {
    if (!filterValue) return [];
    try {
        const parsed = JSON.parse(filterValue);
        if (!Array.isArray(parsed.users)) return [];
        return parsed.users.filter(Boolean);
    } catch {
        return [];
    }
}

function ActivityList({ status }: { status?: ActivityStatus }) {
    const { treasuryId } = useTreasury();
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();

    const page = parseInt(searchParams.get("page") || "0", 10);

    const updatePage = useCallback(
        (newPage: number) => {
            const params = new URLSearchParams(searchParams.toString());
            params.set("page", newPage.toString());
            router.push(`${pathname}?${params.toString()}`);
        },
        [searchParams, router, pathname],
    );

    // Parse filter parameters
    const minUsdValue = searchParams.get("min_usd_value")
        ? parseFloat(searchParams.get("min_usd_value")!)
        : undefined;
    const txHash = searchParams.get("tx_hash") || undefined;

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
    let tokenSymbol: string | undefined;
    let tokenSymbolNot: string | undefined;

    if (tokenFilter) {
        try {
            const parsed = JSON.parse(tokenFilter);
            // The token filter stores data as: { operation: "Is" | "Is Not", token: { id, symbol, name, icon } }
            if (parsed.token) {
                const symbol = parsed.token.id;

                if (!symbol) {
                    console.error(
                        "Token filter is missing 'symbol' field:",
                        parsed.token,
                    );
                } else {
                    if (parsed.operation === "Is") {
                        tokenSymbol = symbol;
                    } else if (parsed.operation === "Is Not") {
                        tokenSymbolNot = symbol;
                    }
                }
            }
        } catch (e) {
            console.error("Failed to parse token filter:", e);
        }
    }

    // Parse "From" filter
    const fromFilter = searchParams.get("from");
    let fromAccount: string[] | undefined;
    let fromAccountNot: string[] | undefined;
    if (fromFilter) {
        try {
            const parsed = JSON.parse(fromFilter);
            const selectedValues = Array.isArray(parsed.users)
                ? parsed.users.filter(Boolean)
                : [];
            if (parsed.operation === "Is" && selectedValues.length > 0) {
                fromAccount = selectedValues;
            } else if (
                parsed.operation === "Is Not" &&
                selectedValues.length > 0
            ) {
                fromAccountNot = selectedValues;
            }
        } catch (e) {
            console.error("Failed to parse from filter:", e);
        }
    }
    const toFilter = searchParams.get("to");
    let toAccount: string[] | undefined;
    let toAccountNot: string[] | undefined;
    if (toFilter) {
        try {
            const parsed = JSON.parse(toFilter);
            const selectedValues = Array.isArray(parsed.users)
                ? parsed.users.filter(Boolean)
                : [];
            if (parsed.operation === "Is" && selectedValues.length > 0) {
                toAccount = selectedValues;
            } else if (
                parsed.operation === "Is Not" &&
                selectedValues.length > 0
            ) {
                toAccountNot = selectedValues;
            }
        } catch (e) {
            console.error("Failed to parse to filter:", e);
        }
    }

    const { data, isLoading } = useRecentActivity(
        treasuryId,
        PAGE_SIZE,
        page * PAGE_SIZE,
        minUsdValue,
        status,
        tokenSymbol,
        tokenSymbolNot,
        txHash,
        fromAccount,
        fromAccountNot,
        toAccount,
        toAccountNot,
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
    const t = useTranslations("pages.activity");
    const tActivity = useTranslations("activity");
    const tCommon = useTranslations("common");
    const { treasuryId } = useTreasury();
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const { data: subscriptionData } = useSubscription(treasuryId);
    const [isFiltersOpen, setIsFiltersOpen] = useState(false);
    const txHashValue = searchParams.get("tx_hash") || "";
    const [txHashInput, setTxHashInput] = useState(txHashValue);

    const currentTab = searchParams.get("tab") || "all";
    const { data: senderOptionsData } = useRecentActivitySenders(
        treasuryId,
        currentTab === "all" ? undefined : currentTab,
    );
    const { data: recipientOptionsData } = useRecentActivityRecipients(
        treasuryId,
        currentTab === "all" ? undefined : currentTab,
    );
    const selectedFromAccounts = useMemo(
        () => getSelectedAccountsFromFilter(searchParams.get("from")),
        [searchParams],
    );
    const selectedToAccounts = useMemo(
        () => getSelectedAccountsFromFilter(searchParams.get("to")),
        [searchParams],
    );
    // Keep currently selected URL values visible in the dropdown when changing tabs:
    // tab-specific options may not include those values, but users still need to see/edit
    // their active filters without losing context.
    const senderOptions = useMemo(
        () =>
            Array.from(
                new Set([
                    ...(senderOptionsData || []),
                    ...selectedFromAccounts,
                ]),
            ),
        [senderOptionsData, selectedFromAccounts],
    );
    const recipientOptions = useMemo(
        () =>
            Array.from(
                new Set([
                    ...(recipientOptionsData || []),
                    ...selectedToAccounts,
                ]),
            ),
        [recipientOptionsData, selectedToAccounts],
    );

    // Calculate filter options with date restrictions based on plan
    const activityFilterOptions: FilterOption[] = useMemo(() => {
        const minDate = subscriptionData?.planConfig?.limits
            ?.historyLookupMonths
            ? subMonths(
                  new Date(),
                  subscriptionData.planConfig.limits.historyLookupMonths,
              )
            : undefined;

        return [
            {
                id: "created_date",
                label: tActivity("filters.createdDate"),
                minDate,
                maxDate: new Date(),
            },
            {
                id: "token",
                label: tActivity("filters.token"),
                hideAmount: true,
            },
            {
                id: "from",
                label: tActivity("filters.from"),
                options: senderOptions.map((option) => ({
                    value: option,
                    label: option,
                })),
            },
            {
                id: "to",
                label: tActivity("filters.to"),
                options: recipientOptions.map((option) => ({
                    value: option,
                    label: option,
                })),
            },
        ];
    }, [
        subscriptionData?.planConfig?.limits?.historyLookupMonths,
        senderOptions,
        recipientOptions,
    ]);

    const handleTabChange = useCallback(
        (value: string) => {
            const params = new URLSearchParams(searchParams.toString());
            params.set("tab", value);
            params.delete("page"); // Reset page when changing tabs
            router.push(`${pathname}?${params.toString()}`);
        },
        [searchParams, router, pathname],
    );

    // Count active filters — the Filters button labels itself with the total.
    // A filter that has been added but has no value picked yet is not counted,
    // since it isn't narrowing anything.
    const activeFilterCount = useMemo(() => {
        const filterParams = ["created_date", "token", "from", "to"];
        return (
            filterParams.filter((param) =>
                hasFilterValue(searchParams.get(param)),
            ).length + (searchParams.has("min_usd_value") ? 1 : 0)
        );
    }, [searchParams]);

    useEffect(() => {
        setTxHashInput(txHashValue);
    }, [txHashValue]);

    const handleTxHashSearch = useCallback(
        (value: string) => {
            const params = new URLSearchParams(searchParams.toString());
            if (value.trim()) {
                params.set("tx_hash", value.trim());
            } else {
                params.delete("tx_hash");
            }
            params.delete("page");
            router.push(`${pathname}?${params.toString()}`);
        },
        [searchParams, router, pathname],
    );

    const tabs: ActivityTab[] = [
        { value: "all", label: tActivity("tabs.all") },
        { value: "outgoing", label: tActivity("tabs.send") },
        { value: "incoming", label: tActivity("tabs.receive") },
        { value: "exchange", label: tActivity("tabs.swap") },
    ];

    const filtersLabel =
        activeFilterCount > 0
            ? tCommon("filtersWithCount", { count: activeFilterCount })
            : tCommon("filters");

    const actions = (
        <div className="flex items-center justify-end gap-2">
            <ResponsiveInput
                value={txHashInput}
                onChange={(e) => setTxHashInput(e.target.value)}
                onDebouncedChange={handleTxHashSearch}
                debounceMs={350}
                placeholder={tActivity("searchPlaceholder")}
                mobilePlaceholder={tActivity("searchPlaceholderShort")}
                className="md:h-10 md:w-[290px] md:shrink-0"
                inputClassName="md:rounded-lg md:border md:border-general-border md:bg-card! md:hover:bg-card! md:pl-9 md:placeholder:font-medium md:placeholder:text-general-muted-foreground dark:md:placeholder:text-muted-foreground focus-visible:border-general-border focus-visible:ring-0"
                searchIconClassName="md:left-2 md:size-5 md:text-general-muted-foreground dark:md:text-muted-foreground"
                search
            />
            <Button
                variant={activeFilterCount > 0 ? "default" : "secondary"}
                size="icon"
                className={cn(
                    "rounded-lg md:h-10 md:w-auto md:gap-2 md:px-4 md:text-sm",
                    // Active state is the design's gray-900 (#171717) surface.
                    // `default` keeps the paired label colour, and
                    // `general-foreground` flips to white in the dark theme.
                    activeFilterCount > 0
                        ? "bg-general-foreground hover:bg-general-foreground/90"
                        : "text-muted-foreground",
                )}
                onClick={() => setIsFiltersOpen(!isFiltersOpen)}
                aria-label={filtersLabel}
            >
                <Icon icon={FilterIcon} className="md:size-[13.25px]" />
                <span className="hidden md:inline">{filtersLabel}</span>
            </Button>
        </div>
    );

    const filterPanel = (
        <div
            className="overflow-hidden transition-all duration-500 ease-in-out"
            style={{
                maxHeight: isFiltersOpen ? FILTER_PANEL_MAX_HEIGHT : "0px",
                opacity: isFiltersOpen ? 1 : 0,
            }}
        >
            <div className="px-4 py-3 md:px-0 md:py-0">
                <GenericFilters filterOptions={activityFilterOptions} />
            </div>
        </div>
    );

    const tabContents = tabs.map(({ value }) => (
        <TabsContent key={value} value={value}>
            <ActivityList status={value === "all" ? undefined : value} />
        </TabsContent>
    ));

    return (
        <PageComponentLayout
            title={t("title")}
            headerActions={<HistoryRefreshButton className="size-10" />}
        >
            <ResponsiveTabs
                tabs={tabs}
                value={currentTab}
                onValueChange={handleTabChange}
                actions={actions}
                variant="plain"
                className="md:gap-4"
            >
                {filterPanel}
                {tabContents}
            </ResponsiveTabs>
        </PageComponentLayout>
    );
}
