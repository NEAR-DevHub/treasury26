"use client";

import { useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import * as z from "zod";
import { PageComponentLayout } from "@/components/page-component-layout";
import { PageCard } from "@/components/card";
import { Button } from "@/components/button";
import {
    ArrowLeft,
    Calendar,
    Coins,
    Mail,
    Clock,
    FileX,
    ChevronDown,
    Info,
} from "lucide-react";
import { useTreasury } from "@/hooks/use-treasury";
import { useNear } from "@/stores/near-store";
import { useSubscription } from "@/hooks/use-subscription";
import { useExportHistory } from "@/hooks/use-treasury-queries";
import { APP_CONTACT_US_URL } from "@/constants/config";
import {
    DatePickerPopover,
    useDefaultDatePresets,
} from "@/components/datepicker";
import { Input } from "@/components/input";
import {
    FormField,
    FormMessage,
    FormControl,
    FormItem,
    FormLabel,
    FormDescription,
    Form,
} from "@/components/ui/form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { isTrialPlan } from "@/lib/subscription-api";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAssets, useAggregatedTokens } from "@/hooks/use-assets";
import { cn } from "@/lib/utils";
import { endOfDay, startOfDay, subMonths, subDays } from "date-fns";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "@/components/underline-tabs";
import { EmptyState } from "@/components/empty-state";
import { ScrollContainer } from "@/components/scroll-container";
import { toast } from "sonner";
import { useFormatHistoryDuration } from "@/features/activity";
import { format } from "date-fns";
import { ExportHistoryItem } from "@/lib/api";
import { Download, Loader2 } from "lucide-react";
import { User } from "@/components/user";
import { FormattedDate } from "@/components/formatted-date";
import { CreditsQuotaDisplay } from "@/components/credits-quota-display";
import { getBalanceHistoryTokenIds } from "@/lib/balance-history-token-ids";
import {
    useReactTable,
    getCoreRowModel,
    flexRender,
    createColumnHelper,
    ColumnDef,
} from "@tanstack/react-table";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/table";
import { trackEvent } from "@/lib/analytics";

type DocumentType = "csv" | "json" | "xlsx";
type TransactionType = "all" | "outgoing" | "incoming" | "staking_rewards";

const BACKEND_API_BASE = process.env.NEXT_PUBLIC_BACKEND_API_BASE || "";

const columnHelper = createColumnHelper<ExportHistoryItem>();

const DOCUMENT_TYPES: { value: DocumentType; label: string }[] = [
    { value: "csv", label: ".CSV" },
    { value: "json", label: ".JSON" },
    { value: "xlsx", label: ".XLSX" },
];

const TRANSACTION_TYPES: { value: TransactionType; labelKey: string }[] = [
    { value: "all", labelKey: "typeAll" },
    { value: "outgoing", labelKey: "typeSent" },
    { value: "incoming", labelKey: "typeReceived" },
    { value: "staking_rewards", labelKey: "typeStakingRewards" },
];

function buildExportFormSchema(messages: { invalidEmail: string }) {
    return z.object({
        email: z
            .string()
            .email(messages.invalidEmail)
            .optional()
            .or(z.literal("")),
        documentType: z.enum(["csv", "json", "xlsx"]),
        dateRange: z.object({
            from: z.date(),
            to: z.date().optional(),
        }),
        selectedAssets: z.array(z.string()).min(1),
        selectedTransactionTypes: z.array(z.string()).min(1),
    });
}

// Helper to parse date range from file URL
function parseDateRangeFromUrl(
    fileUrl: string,
): { startDate: string; endDate: string } | null {
    try {
        // Extract query params from the URL string
        const queryString = fileUrl.includes("?") ? fileUrl.split("?")[1] : "";

        // Manually extract startTime and endTime (camelCase format)
        const startMatch = queryString.match(/startTime=([^&]+)/);
        const endMatch = queryString.match(/endTime=([^&]+)/);

        if (startMatch && endMatch) {
            const startTime = decodeURIComponent(startMatch[1]);
            const endTime = decodeURIComponent(endMatch[1]);

            return {
                startDate: format(new Date(startTime), "MMM dd, yyyy"),
                endDate: format(new Date(endTime), "MMM dd, yyyy"),
            };
        }
    } catch (error) {
        console.error(
            "Error parsing date range from URL:",
            error,
            "URL:",
            fileUrl,
        );
    }
    return null;
}

function ExportHistoryTable({ items }: { items: ExportHistoryItem[] }) {
    const tEx = useTranslations("exportToasts");
    const tExport = useTranslations("export");
    const { isGuestTreasury } = useTreasury();
    const { accountId } = useNear();
    const isMember = !isGuestTreasury;

    const handleDownload = useCallback(
        (item: ExportHistoryItem) => {
            try {
                const url = new URL(item.fileUrl, BACKEND_API_BASE);
                const fullUrl = `${BACKEND_API_BASE}${url.pathname}${url.search}`;

                // Open in new tab
                window.open(fullUrl, "_blank", "noopener,noreferrer");
            } catch (error) {
                console.error("Download error:", error);
                toast.error(tEx("downloadFailed"));
            }
        },
        [tEx],
    );

    const columns = useMemo<ColumnDef<ExportHistoryItem, any>[]>(
        () => [
            columnHelper.display({
                id: "submissionTime",
                header: tEx("columnSubmissionTime"),
                cell: ({ row }) => {
                    const item = row.original;
                    return (
                        <div className="text-sm whitespace-normal">
                            <FormattedDate
                                date={new Date(item.createdAt)}
                                includeTime
                            />
                        </div>
                    );
                },
            }),
            columnHelper.display({
                id: "dateRange",
                header: tEx("columnDateRange"),
                cell: ({ row }) => {
                    const item = row.original;
                    const dateRange = parseDateRangeFromUrl(item.fileUrl);
                    return (
                        <div className="text-sm whitespace-normal">
                            {dateRange
                                ? `${dateRange.startDate} - ${dateRange.endDate}`
                                : "N/A"}
                        </div>
                    );
                },
            }),
            columnHelper.display({
                id: "generatedBy",
                header: tEx("columnGeneratedBy"),
                cell: ({ row }) => {
                    const item = row.original;
                    return (
                        <div className="min-w-0">
                            <User
                                accountId={item.generatedBy}
                                size="md"
                                withLink={false}
                            />
                        </div>
                    );
                },
            }),
            columnHelper.display({
                id: "status",
                header: tEx("columnStatus"),
                cell: ({ row }) => {
                    const item = row.original;
                    return (
                        <div className="flex justify-end">
                            {item.status === "generating" ? (
                                <div className="flex items-center gap-2 px-3 py-1.5 bg-orange-50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-400 rounded-md text-sm">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    {tExport("status.generating")}
                                </div>
                            ) : item.status === "completed" ? (
                                <Button
                                    variant="link"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleDownload(item);
                                    }}
                                    className="p-0!"
                                    disabled={!isMember || !accountId}
                                    tooltipContent={
                                        !isMember || !accountId
                                            ? tEx("noDownloadPermission")
                                            : undefined
                                    }
                                >
                                    <Download className="w-4 h-4" />
                                    {tExport("download")}
                                </Button>
                            ) : item.status === "expired" ? (
                                <div className="px-3 py-1.5 bg-muted rounded-md text-sm">
                                    {tExport("status.expired")}
                                </div>
                            ) : (
                                <div className="px-3 py-1.5 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 rounded-md text-sm">
                                    {tExport("status.failed")}
                                </div>
                            )}
                        </div>
                    );
                },
            }),
        ],
        [handleDownload, isMember, accountId, tEx],
    );

    const table = useReactTable({
        data: items,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getRowId: (row) => row.id.toString(),
    });

    return (
        <div className="w-full">
            <Table className="table-fixed">
                <colgroup>
                    <col className="w-[28%]" />
                    <col className="w-[28%]" />
                    <col className="w-[28%]" />
                    <col className="w-[16%]" />
                </colgroup>
                <TableHeader>
                    <TableRow className="hover:bg-transparent">
                        {table.getHeaderGroups().map((headerGroup) =>
                            headerGroup.headers.map((header) => (
                                <TableHead
                                    key={header.id}
                                    className={cn(
                                        "text-xs font-medium uppercase text-muted-foreground",
                                        header.column.id === "status" &&
                                            "text-right",
                                    )}
                                >
                                    {flexRender(
                                        header.column.columnDef.header,
                                        header.getContext(),
                                    )}
                                </TableHead>
                            )),
                        )}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {table.getRowModel().rows.map((row) => (
                        <TableRow key={row.id}>
                            {row.getVisibleCells().map((cell, idx) => (
                                <TableCell
                                    key={cell.id}
                                    className={cn(
                                        "align-top",
                                        cell.column.id === "status" &&
                                            "text-right",
                                    )}
                                >
                                    {flexRender(
                                        cell.column.columnDef.cell,
                                        cell.getContext(),
                                    )}
                                </TableCell>
                            ))}
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

export default function ExportActivityPage() {
    const t = useTranslations("pages.dashboard");
    const tEx = useTranslations("exportToasts");
    const tExport = useTranslations("export");
    const formatHistoryDuration = useFormatHistoryDuration();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { treasuryId, isGuestTreasury } = useTreasury();
    const { accountId } = useNear();
    const { data: planDetails, isLoading: planLoading } =
        useSubscription(treasuryId);

    const { data: exportHistoryData, refetch: refetchHistory } =
        useExportHistory(treasuryId);
    const { data: assetsData } = useAssets(treasuryId, {
        onlyPositiveBalance: false,
    });
    const aggregatedTokens = useAggregatedTokens(assetsData?.tokens || []);

    const isMember = !isGuestTreasury;
    const [isExporting, setIsExporting] = useState(false);
    const [currentTab, setCurrentTab] = useState<string>("generate");

    // Calculate min date based on plan
    const minDate = useMemo(() => {
        if (!planDetails?.planConfig?.limits?.historyLookupMonths)
            return undefined;
        return subMonths(
            new Date(),
            planDetails.planConfig.limits.historyLookupMonths,
        );
    }, [planDetails?.planConfig?.limits?.historyLookupMonths]);

    // Default start date: use the plan's history limit
    const defaultStartDate = useMemo(() => {
        return minDate || subMonths(new Date(), 6);
    }, [minDate]);

    const defaultDatePresets = useDefaultDatePresets();
    // Create custom date presets based on plan's history limit
    const datePresets = useMemo(() => {
        const historyMonths =
            planDetails?.planConfig?.limits?.historyLookupMonths;
        const presets = [...defaultDatePresets];

        if (historyMonths) {
            // Add year-based presets based on plan
            const years = Math.floor(historyMonths / 12);

            if (years >= 1) {
                presets.push({
                    label: tEx("last1Year"),
                    value: {
                        from: subMonths(startOfDay(new Date()), 12),
                        to: endOfDay(new Date()),
                    },
                });
            }

            if (years >= 2) {
                presets.push({
                    label: tEx("last2Years"),
                    value: {
                        from: subMonths(startOfDay(new Date()), 24),
                        to: endOfDay(new Date()),
                    },
                });
            }
        }

        return presets;
    }, [
        planDetails?.planConfig?.limits?.historyLookupMonths,
        defaultDatePresets,
        tEx,
    ]);

    const exportFormSchema = useMemo(
        () =>
            buildExportFormSchema({
                invalidEmail: tEx("invalidEmail"),
            }),
        [tEx],
    );

    const form = useForm<z.infer<ReturnType<typeof buildExportFormSchema>>>({
        resolver: zodResolver(exportFormSchema),
        defaultValues: {
            email: "",
            documentType: "csv",
            dateRange: {
                from: defaultStartDate,
                to: new Date(),
            },
            selectedAssets: ["all"],
            selectedTransactionTypes: ["all"],
        },
        mode: "onChange", // Validate on change
    });

    // Watch form values
    const documentType = form.watch("documentType");
    const dateRange = form.watch("dateRange");
    const selectedAssets = form.watch("selectedAssets");
    const selectedTransactionTypes = form.watch("selectedTransactionTypes");

    const defaultMonth = useMemo(() => {
        if (dateRange?.from) {
            return dateRange.from;
        }
        return startOfDay(new Date());
    }, [dateRange?.from]);

    const handleExport = async () => {
        if (!treasuryId || !dateRange.from || !dateRange.to) {
            toast.error(tEx("invalidDateRange"), {
                description: tEx("invalidDateRangeDescription"),
            });
            return;
        }

        trackEvent("export-generate-click", {
            source: "dashboard_export_page",
            treasury_id: treasuryId,
            document_type: documentType,
        });

        setIsExporting(true);
        try {
            const formValues = form.getValues();
            const params = new URLSearchParams({
                accountId: treasuryId,
                startTime: dateRange.from.toISOString(),
                endTime: dateRange.to.toISOString(),
                format: documentType, // csv, json, or xlsx
            });

            if (accountId) {
                params.append("generatedBy", accountId);
            }

            // Add email if provided and valid
            if (formValues.email && formValues.email.trim()) {
                params.append("email", formValues.email.trim());
            }

            // Add tokenIds if specific assets are selected (excluding "all")
            const specificAssets = selectedAssets.filter((a) => a !== "all");
            if (specificAssets.length > 0) {
                const tokenIds = new Set<string>();
                specificAssets.forEach((assetId) => {
                    const token = aggregatedTokens.find(
                        (t) => t.id === assetId,
                    );
                    if (token) {
                        token.networks.forEach((network) => {
                            for (const tokenId of getBalanceHistoryTokenIds(
                                network,
                            )) {
                                tokenIds.add(tokenId);
                            }
                        });
                    }
                });
                if (tokenIds.size > 0) {
                    params.append("tokenIds", Array.from(tokenIds).join(","));
                }
            }

            // Add transactionTypes if specific types are selected (excluding "all")
            const specificTypes = selectedTransactionTypes.filter(
                (t) => t !== "all",
            );
            if (
                specificTypes.length > 0 &&
                specificTypes.length < TRANSACTION_TYPES.length - 1
            ) {
                params.append("transactionTypes", specificTypes.join(","));
            }

            const url = `${BACKEND_API_BASE}/api/balance-history/export?${params.toString()}`;

            const response = await fetch(url, { credentials: "include" });

            if (!response.ok) {
                const errorText = await response.text();
                let errorMessage = tEx("exportFailed");

                try {
                    const errorJson = JSON.parse(errorText);
                    errorMessage =
                        errorJson.message ||
                        errorJson.error ||
                        errorText ||
                        tEx("exportFailed");
                } catch {
                    errorMessage = errorText || tEx("exportFailed");
                }

                throw new Error(errorMessage);
            }

            const blob = await response.blob();
            const downloadUrl = window.URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = downloadUrl;

            const filename = `balance_changes_${treasuryId}_${dateRange.from.toISOString().split("T")[0]}_to_${dateRange.to.toISOString().split("T")[0]}.${documentType}`;
            link.download = filename;

            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(downloadUrl);

            toast.success(tEx("exportSuccess"), {
                description: tEx("exportSuccessDescription", {
                    type: documentType.toUpperCase(),
                }),
            });

            // Refetch subscription data and history
            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: ["subscription", treasuryId],
                }),
                refetchHistory(),
            ]);

            // Navigate to history tab
            setCurrentTab("history");
        } catch (error) {
            console.error("Export error:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : tEx("exportFailedFallback");

            toast.error(tEx("exportFailed"), {
                description: errorMessage,
            });
        } finally {
            setIsExporting(false);
        }
    };

    const historyText = formatHistoryDuration(
        planDetails?.planConfig?.limits?.historyLookupMonths,
    );

    const toggleSelection = <T extends string>(
        fieldName: "selectedAssets" | "selectedTransactionTypes",
        value: T,
    ) => {
        const currentSelection = form.getValues(fieldName);
        if (value === "all") {
            form.setValue(fieldName, ["all"] as any, { shouldValidate: true });
        } else {
            const newSelection = currentSelection.includes(value)
                ? currentSelection.filter((item) => item !== value)
                : [...currentSelection.filter((item) => item !== "all"), value];

            form.setValue(
                fieldName,
                newSelection.length === 0 ? ["all"] : (newSelection as any),
                { shouldValidate: true },
            );
        }
    };

    const toggleAsset = (asset: string) =>
        toggleSelection("selectedAssets", asset);
    const toggleTransactionType = (type: TransactionType) =>
        toggleSelection("selectedTransactionTypes", type);

    const getSelectedAssetsLabel = () => {
        if (selectedAssets.includes("all") || selectedAssets.length === 0)
            return tEx("allAssets");
        const selectedLabels = selectedAssets
            .filter((assetId) => assetId !== "all")
            .map((assetId) => {
                const token = aggregatedTokens.find((t) => t.id === assetId);
                return token?.name || token?.id || assetId;
            });
        if (selectedLabels.length === 1) return selectedLabels[0];
        return selectedLabels.join(", ");
    };

    const getSelectedTypesLabel = () => {
        if (
            selectedTransactionTypes.includes("all") ||
            selectedTransactionTypes.length === 0
        )
            return tEx("typeAll");
        if (selectedTransactionTypes.length === 1) {
            const type = TRANSACTION_TYPES.find(
                (t) => t.value === selectedTransactionTypes[0],
            );
            return type ? tEx(type.labelKey) : tEx("typeAll");
        }
        // Show comma-separated list: "Sent, Received"
        const labels = selectedTransactionTypes
            .filter((t) => t !== "all")
            .map((t) => {
                const type = TRANSACTION_TYPES.find((tt) => tt.value === t);
                return type ? tEx(type.labelKey) : t;
            });
        return labels.join(", ");
    };

    const canGenerateExport = useMemo(() => {
        const credits = planDetails?.exportCredits ?? 0;
        return credits > 0;
    }, [planDetails]);

    const exportCreditsRemaining = planDetails?.exportCredits ?? 0;
    const exportCreditsTotal =
        planDetails?.planConfig?.limits?.monthlyExportCredits ??
        planDetails?.planConfig?.limits?.trialExportCredits ??
        0;
    const exportCreditsUsed = Math.max(
        0,
        exportCreditsTotal - exportCreditsRemaining,
    );
    const isFreeExportPlan = planDetails?.planType === "free";
    const isUnlimitedExport =
        planDetails?.planConfig?.limits?.monthlyExportCredits === null;

    // Show loading skeleton
    if (planLoading) {
        return (
            <PageComponentLayout
                title={t("title")}
                description={t("descriptionLong")}
            >
                <div className="flex flex-wrap justify-center gap-6 w-full">
                    <div className="flex-1 min-w-0 max-w-3xl">
                        <PageCard className="gap-2">
                            <div className="h-64 bg-muted-foreground/20 rounded animate-pulse" />
                        </PageCard>
                    </div>
                    <div className="flex flex-col gap-4 w-full lg:w-80 shrink-0">
                        <PageCard className="w-full">
                            <div className="h-32 bg-muted-foreground/20 rounded animate-pulse" />
                        </PageCard>
                    </div>
                </div>
            </PageComponentLayout>
        );
    }

    return (
        <Form {...form}>
            <PageComponentLayout
                title={t("title")}
                description={t("descriptionLong")}
            >
                <div className="flex flex-wrap justify-center gap-6 w-full">
                    {/* Main Content */}
                    <div className="flex-1 min-w-0 max-w-3xl">
                        <PageCard className="gap-2">
                            <div className="flex flex-col gap-3">
                                <div className="flex flex-col mb-1">
                                    <div className="flex items-center gap-2">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() =>
                                                router.push(
                                                    `/${treasuryId}/dashboard`,
                                                )
                                            }
                                            className="p-0!"
                                        >
                                            <ArrowLeft />
                                        </Button>

                                        <div className="flex flex-col">
                                            <p className="font-semibold mb-1">
                                                {tExport("heading")}
                                            </p>
                                            <p className="text-sm text-muted-foreground">
                                                {tExport("teamOnly")}
                                            </p>
                                        </div>
                                    </div>
                                </div>

                                {/* No Credits Alert */}
                                {exportCreditsRemaining === 0 &&
                                    planDetails && (
                                        <Alert variant="info">
                                            <Info className="h-4 w-4 mt-[2px]" />
                                            <AlertTitle className="font-semibold">
                                                {isTrialPlan(
                                                    planDetails.planConfig,
                                                )
                                                    ? tExport("creditsUsed")
                                                    : tExport("exportsUsed")}
                                            </AlertTitle>
                                            <AlertDescription className="text-general-info-foreground">
                                                {isTrialPlan(
                                                    planDetails.planConfig,
                                                )
                                                    ? tEx("upgradeTrial")
                                                    : tEx("upgradePaid")}
                                            </AlertDescription>
                                        </Alert>
                                    )}
                                <Tabs
                                    value={currentTab}
                                    onValueChange={setCurrentTab}
                                    className="gap-0"
                                >
                                    <TabsList className="">
                                        <TabsTrigger value="generate">
                                            {tExport("tabs.generate")}
                                        </TabsTrigger>
                                        <TabsTrigger value="history">
                                            {tExport("tabs.history")}
                                        </TabsTrigger>
                                    </TabsList>

                                    <TabsContent
                                        value="generate"
                                        className="mt-4"
                                    >
                                        <div className="space-y-4">
                                            {/* Document Type */}
                                            <div>
                                                <label className="text-sm font-medium mb-2 block">
                                                    {tExport(
                                                        "fields.documentType",
                                                    )}
                                                </label>
                                                <div className="flex gap-2">
                                                    {DOCUMENT_TYPES.map(
                                                        (type) => (
                                                            <Button
                                                                key={type.value}
                                                                variant="unstyled"
                                                                onClick={() =>
                                                                    form.setValue(
                                                                        "documentType",
                                                                        type.value,
                                                                        {
                                                                            shouldValidate: true,
                                                                        },
                                                                    )
                                                                }
                                                                className={cn(
                                                                    "flex-1 border transition-colors",
                                                                    documentType ===
                                                                        type.value
                                                                        ? "bg-general-secondary"
                                                                        : "hover:bg-general-tertiary",
                                                                )}
                                                                style={{
                                                                    borderColor:
                                                                        documentType ===
                                                                        type.value
                                                                            ? "var(--general-unofficial-border-5)"
                                                                            : "var(--general-unofficial-border-3)",
                                                                }}
                                                            >
                                                                {type.label}
                                                            </Button>
                                                        ),
                                                    )}
                                                </div>
                                            </div>

                                            {/* Time Range */}
                                            <div>
                                                <label className="text-sm font-medium mb-2 block">
                                                    {tExport(
                                                        "fields.timeRange",
                                                    )}
                                                </label>
                                                <DatePickerPopover
                                                    mode="range"
                                                    value={
                                                        dateRange
                                                            ? {
                                                                  from: dateRange.from,
                                                                  to: dateRange.to,
                                                              }
                                                            : undefined
                                                    }
                                                    onChange={(range: any) => {
                                                        if (
                                                            range &&
                                                            typeof range ===
                                                                "object" &&
                                                            "from" in range
                                                        ) {
                                                            form.setValue(
                                                                "dateRange",
                                                                {
                                                                    from: range.from
                                                                        ? startOfDay(
                                                                              range.from,
                                                                          )
                                                                        : startOfDay(
                                                                              new Date(),
                                                                          ),
                                                                    to: range.to
                                                                        ? endOfDay(
                                                                              range.to,
                                                                          )
                                                                        : endOfDay(
                                                                              new Date(),
                                                                          ),
                                                                },
                                                                {
                                                                    shouldValidate: true,
                                                                },
                                                            );
                                                        } else {
                                                            form.setValue(
                                                                "dateRange",
                                                                {
                                                                    from: startOfDay(
                                                                        new Date(),
                                                                    ),
                                                                    to: endOfDay(
                                                                        new Date(),
                                                                    ),
                                                                },
                                                                {
                                                                    shouldValidate: true,
                                                                },
                                                            );
                                                        }
                                                    }}
                                                    defaultMonth={defaultMonth}
                                                    numberOfMonths={1}
                                                    min={minDate}
                                                    max={new Date()}
                                                    presets={datePresets}
                                                    align="start"
                                                    side="bottom"
                                                    classNames={{
                                                        trigger: "w-full",
                                                    }}
                                                    placeholder={tEx(
                                                        "selectDateRange",
                                                    )}
                                                />
                                            </div>

                                            {/* Asset Selection */}
                                            <div>
                                                <label className="text-sm font-medium mb-2 block">
                                                    {tExport("fields.asset")}
                                                </label>
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger
                                                        asChild
                                                    >
                                                        <Button
                                                            variant="outline"
                                                            className="w-full justify-between bg-muted! dark:bg-muted! hover:bg-general-tertiary! dark:hover:bg-general-tertiary! font-normal"
                                                        >
                                                            <div className="flex items-center gap-2 min-w-0 flex-1">
                                                                <Coins className="w-4 h-4 shrink-0" />
                                                                <span className="truncate">
                                                                    {getSelectedAssetsLabel()}
                                                                </span>
                                                            </div>
                                                            <ChevronDown className="w-4 h-4 opacity-50 shrink-0" />
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent
                                                        className="min-w-(--radix-dropdown-menu-trigger-width) text-foreground p-0"
                                                        align="start"
                                                    >
                                                        <ScrollContainer className="max-h-[300px] p-1">
                                                            <DropdownMenuCheckboxItem
                                                                checked={selectedAssets.includes(
                                                                    "all",
                                                                )}
                                                                onCheckedChange={() =>
                                                                    toggleAsset(
                                                                        "all",
                                                                    )
                                                                }
                                                                onSelect={(e) =>
                                                                    e.preventDefault()
                                                                }
                                                            >
                                                                <div className="flex items-center">
                                                                    <Coins className="w-4 h-4 mr-2" />
                                                                    {tExport(
                                                                        "fields.allAssets",
                                                                    )}
                                                                </div>
                                                            </DropdownMenuCheckboxItem>
                                                            {aggregatedTokens.map(
                                                                (
                                                                    token: any,
                                                                ) => (
                                                                    <DropdownMenuCheckboxItem
                                                                        key={
                                                                            token.id
                                                                        }
                                                                        checked={selectedAssets.includes(
                                                                            token.id,
                                                                        )}
                                                                        onCheckedChange={() =>
                                                                            toggleAsset(
                                                                                token.id,
                                                                            )
                                                                        }
                                                                        onSelect={(
                                                                            e,
                                                                        ) =>
                                                                            e.preventDefault()
                                                                        }
                                                                    >
                                                                        <div className="flex items-center">
                                                                            {token.icon && (
                                                                                <img
                                                                                    src={
                                                                                        token.icon
                                                                                    }
                                                                                    alt={
                                                                                        token.name ||
                                                                                        token.id
                                                                                    }
                                                                                    className="w-4 h-4 rounded-full mr-2"
                                                                                />
                                                                            )}
                                                                            {token.name ||
                                                                                token.id}
                                                                        </div>
                                                                    </DropdownMenuCheckboxItem>
                                                                ),
                                                            )}
                                                        </ScrollContainer>
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
                                            </div>

                                            {/* Transaction Type */}
                                            <div>
                                                <label className="text-sm font-medium mb-2 block">
                                                    {tExport(
                                                        "fields.transactionType",
                                                    )}
                                                </label>
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger
                                                        asChild
                                                    >
                                                        <Button
                                                            variant="outline"
                                                            className="w-full justify-between bg-muted! dark:bg-muted! hover:bg-general-tertiary! dark:hover:bg-general-tertiary! font-normal"
                                                        >
                                                            <span className="truncate flex-1 text-left">
                                                                {getSelectedTypesLabel()}
                                                            </span>
                                                            <ChevronDown className="w-4 h-4 opacity-50 shrink-0 ml-2" />
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent
                                                        className="min-w-(--radix-dropdown-menu-trigger-width) text-foreground"
                                                        align="start"
                                                    >
                                                        {TRANSACTION_TYPES.map(
                                                            (type) => (
                                                                <DropdownMenuCheckboxItem
                                                                    key={
                                                                        type.value
                                                                    }
                                                                    checked={selectedTransactionTypes.includes(
                                                                        type.value,
                                                                    )}
                                                                    onCheckedChange={() =>
                                                                        toggleTransactionType(
                                                                            type.value,
                                                                        )
                                                                    }
                                                                    onSelect={(
                                                                        e,
                                                                    ) =>
                                                                        e.preventDefault()
                                                                    }
                                                                >
                                                                    {tEx(
                                                                        type.labelKey,
                                                                    )}
                                                                </DropdownMenuCheckboxItem>
                                                            ),
                                                        )}
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
                                            </div>

                                            {/* TODO: Email notification feature to be implemented later */}
                                            {/* Email */}
                                            {/* <FormField
                                                control={form.control}
                                                name="email"
                                                render={({ field }) => (
                                                    <FormItem>
                                                        <FormLabel>Email</FormLabel>
                                                        <FormControl>
                                                            <Input
                                                                type="email"
                                                                placeholder="example@mail.com"
                                                                {...field}
                                                            />
                                                        </FormControl>
                                                        <FormMessage />
                                                        {!form.formState.errors.email && (
                                                            <FormDescription>
                                                                We respect your privacy - your email is used only for export notifications and is not stored.
                                                            </FormDescription>
                                                        )}
                                                    </FormItem>
                                                )}
                                            /> */}

                                            {/* Export Button */}
                                            <Button
                                                onClick={handleExport}
                                                disabled={
                                                    !dateRange.from ||
                                                    !dateRange.to ||
                                                    isExporting ||
                                                    !canGenerateExport ||
                                                    !isMember ||
                                                    !accountId
                                                }
                                                className="w-full mt-3"
                                            >
                                                {!isMember || !accountId
                                                    ? tEx("noExportPermission")
                                                    : !canGenerateExport
                                                      ? tEx("quotaUsed")
                                                      : isExporting
                                                        ? tEx("exporting")
                                                        : tEx("export")}
                                            </Button>
                                        </div>
                                    </TabsContent>

                                    <TabsContent
                                        value="history"
                                        className="mt-4"
                                    >
                                        {!exportHistoryData ||
                                        exportHistoryData.data.length === 0 ? (
                                            <EmptyState
                                                icon={FileX}
                                                title={tEx("noExportsTitle")}
                                                description={tEx(
                                                    "noExportsDescription",
                                                )}
                                            />
                                        ) : (
                                            <ExportHistoryTable
                                                items={exportHistoryData.data}
                                            />
                                        )}
                                    </TabsContent>
                                </Tabs>
                            </div>
                        </PageCard>
                    </div>

                    {/* Sidebar */}
                    <div className="flex flex-col gap-4 w-full lg:w-80 shrink-0">
                        {/* Export Requirements */}
                        <PageCard
                            style={{
                                backgroundColor:
                                    "var(--color-general-tertiary)",
                            }}
                            className="gap-3 w-full"
                        >
                            <p className="font-semibold">
                                {tEx("requirementsTitle")}
                            </p>
                            <div className="space-y-3 text-sm">
                                <div className="flex gap-2.5">
                                    <Calendar className="w-5 h-5 shrink-0 mt-0.5" />
                                    <span>
                                        {tEx("exportFromPeriod", {
                                            period: historyText,
                                        })}
                                    </span>
                                </div>
                                <div className="flex gap-2.5">
                                    <Clock className="w-5 h-5 shrink-0 mt-0.5" />
                                    <span>{tEx("availableFor48Hours")}</span>
                                </div>
                            </div>
                        </PageCard>

                        {/* Export Quota */}
                        <PageCard
                            style={{
                                backgroundColor:
                                    exportCreditsRemaining === 0
                                        ? "var(--color-general-info-background-faded)"
                                        : "var(--color-general-tertiary)",
                            }}
                            className="w-full"
                        >
                            <div className="space-y-3">
                                {/* Header */}
                                <div className="flex items-center justify-between">
                                    <h3 className="font-semibold">
                                        {tEx("quotaTitle")}
                                    </h3>
                                    <span className="text-sm font-medium border py-1 px-2 rounded-lg border-general-border bg-general-unofficial-outline">
                                        {planDetails?.planConfig?.limits
                                            ?.monthlyExportCredits === null
                                            ? tEx("unlimited")
                                            : tEx("creditsPerMonth", {
                                                  total: exportCreditsTotal,
                                              })}
                                    </span>
                                </div>

                                {/* Credits Display */}
                                {!isUnlimitedExport && (
                                    <CreditsQuotaDisplay
                                        creditsAvailable={
                                            exportCreditsRemaining
                                        }
                                        creditsUsed={exportCreditsUsed}
                                        creditsTotal={exportCreditsTotal}
                                        creditsResetAt={
                                            planDetails?.creditsResetAt
                                        }
                                        isFree={isFreeExportPlan}
                                        isUnlimited={isUnlimitedExport}
                                    />
                                )}

                                {/* Upgrade CTA - Only show if not unlimited */}
                                {!isUnlimitedExport && (
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm text-secondary-foreground">
                                            {tEx("moreFlexibility")}
                                        </span>
                                        <Button
                                            variant={
                                                exportCreditsRemaining === 0
                                                    ? "default"
                                                    : "secondary"
                                            }
                                            className="px-2! py-3!"
                                            size="sm"
                                            onClick={() => {
                                                window.open(
                                                    APP_CONTACT_US_URL,
                                                    "_blank",
                                                );
                                            }}
                                        >
                                            {tEx("contactUs")}
                                        </Button>
                                    </div>
                                )}
                            </div>
                        </PageCard>
                    </div>
                </div>
            </PageComponentLayout>
        </Form>
    );
}
