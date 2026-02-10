"use client";

import { useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { PageComponentLayout } from "@/components/page-component-layout";
import { PageCard } from "@/components/card";
import { Button } from "@/components/button";
import { ArrowLeft, Calendar, Coins, Mail, Clock, FileX, ChevronDown } from "lucide-react";
import { useTreasury } from "@/hooks/use-treasury";
import { useNear } from "@/stores/near-store";
import { useSubscription } from "@/hooks/use-subscription";
import { useExportCredits, useExportHistory } from "@/hooks/use-treasury-queries";
import { DateRangePicker } from "@/components/date-range-picker";
import { Input } from "@/components/ui/input";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAssets, useAggregatedTokens } from "@/hooks/use-assets";
import { cn } from "@/lib/utils";
import { subMonths } from "date-fns";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/underline-tabs";
import { EmptyState } from "@/components/empty-state";
import { toast } from "sonner";
import { formatHistoryDuration } from "@/lib/utils/plan-utils";
import { format } from "date-fns";
import { ExportHistoryItem } from "@/lib/api";
import { Download, Loader2 } from "lucide-react";
import { User } from "@/components/user";
import { FormattedDate } from "@/components/formatted-date";
import {
    useReactTable,
    getCoreRowModel,
    flexRender,
    createColumnHelper,
    ColumnDef,
} from "@tanstack/react-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/table";

type DocumentType = "csv" | "json" | "xlsx";
type TransactionType = "all" | "outgoing" | "incoming" | "staking_rewards";

const BACKEND_API_BASE = process.env.NEXT_PUBLIC_BACKEND_API_BASE || "";

const columnHelper = createColumnHelper<ExportHistoryItem>();

const DOCUMENT_TYPES: { value: DocumentType; label: string }[] = [
    { value: "csv", label: ".CSV" },
    { value: "json", label: ".JSON" },
    { value: "xlsx", label: ".XLSX" },
];

const TRANSACTION_TYPES: { value: TransactionType; label: string }[] = [
    { value: "all", label: "All Types" },
    { value: "outgoing", label: "Sent" },
    { value: "incoming", label: "Received" },
    { value: "staking_rewards", label: "Staking Rewards" },
];

const exportFormSchema = z.object({
    email: z.string().email("Please enter a valid email address").optional().or(z.literal("")),
    documentType: z.enum(["csv", "json", "xlsx"]),
    dateRange: z.object({
        from: z.date(),
        to: z.date().optional(),
    }),
    selectedAssets: z.array(z.string()).min(1),
    selectedTransactionTypes: z.array(z.string()).min(1),
});

// Helper to parse date range from file URL
function parseDateRangeFromUrl(fileUrl: string): { startDate: string; endDate: string } | null {
    try {
        // Extract query params from the URL string
        const queryString = fileUrl.includes('?') ? fileUrl.split('?')[1] : '';

        // Manually extract start_time and end_time to avoid URLSearchParams treating + as space
        const startMatch = queryString.match(/start_time=([^&]+)/);
        const endMatch = queryString.match(/end_time=([^&]+)/);

        if (startMatch && endMatch) {
            const startTime = decodeURIComponent(startMatch[1]);
            const endTime = decodeURIComponent(endMatch[1]);

            return {
                startDate: format(new Date(startTime), "MMM dd, yyyy"),
                endDate: format(new Date(endTime), "MMM dd, yyyy")
            };
        }
    } catch (error) {
        console.error("Error parsing date range from URL:", error, "URL:", fileUrl);
    }
    return null;
}

function ExportHistoryTable({ items }: { items: ExportHistoryItem[] }) {
    const handleDownload = useCallback((item: ExportHistoryItem) => {
        try {
            const url = new URL(item.fileUrl, BACKEND_API_BASE);
            const fullUrl = `${BACKEND_API_BASE}${url.pathname}${url.search}`;

            const link = document.createElement("a");
            link.href = fullUrl;
            link.download = "";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (error) {
            console.error("Download error:", error);
            toast.error("Failed to download export");
        }
    }, []);

    const columns = useMemo<ColumnDef<ExportHistoryItem, any>[]>(
        () => [
            columnHelper.display({
                id: "submissionTime",
                header: "Submission Time",
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
                header: "Date Range",
                cell: ({ row }) => {
                    const item = row.original;
                    const dateRange = parseDateRangeFromUrl(item.fileUrl);
                    return (
                        <div className="text-sm whitespace-normal">
                            {dateRange ? `${dateRange.startDate} - ${dateRange.endDate}` : "N/A"}
                        </div>
                    );
                },
            }),
            columnHelper.display({
                id: "generatedBy",
                header: "Generated By",
                cell: ({ row }) => {
                    const item = row.original;
                    return (
                        <div className="min-w-0">
                            <User accountId={item.generatedBy} size="md" withLink={false} />
                        </div>
                    );
                },
            }),
            columnHelper.display({
                id: "status",
                header: "Status",
                cell: ({ row }) => {
                    const item = row.original;
                    return (
                        <div className="flex justify-end">
                            {item.status === "generating" ? (
                                <div className="flex items-center gap-2 px-3 py-1.5 bg-orange-50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-400 rounded-md text-sm">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Generating
                                </div>
                            ) : item.status === "completed" ? (
                                <Button
                                    variant="link"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleDownload(item);
                                    }}
                                    className="p-0!"
                                >
                                    <Download className="w-4 h-4" />
                                    Download
                                </Button>
                            ) : item.status === "expired" ? (
                                <div className="text-muted-foreground text-sm px-3 py-1.5">
                                    Expired
                                </div>
                            ) : (
                                <div className="text-red-600 dark:text-red-400 text-sm px-3 py-1.5">
                                    Failed
                                </div>
                            )}
                        </div>
                    );
                },
            }),
        ],
        [handleDownload],
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
                    <TableRow>
                        {table.getHeaderGroups().map((headerGroup) => (
                            headerGroup.headers.map((header) => (
                                <TableHead key={header.id} className={cn(header.column.id === "status" && "text-right")}>
                                    {flexRender(
                                        header.column.columnDef.header,
                                        header.getContext()
                                    )}
                                </TableHead>
                            ))
                        ))}
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
                                        cell.column.id === "status" && "text-right"
                                    )}
                                >
                                    {flexRender(
                                        cell.column.columnDef.cell,
                                        cell.getContext()
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
    const router = useRouter();
    const { treasuryId } = useTreasury();
    const { accountId } = useNear();
    const { data: planDetails, isLoading: planLoading } = useSubscription(treasuryId);
    const { data: exportCreditsData, refetch: refetchCredits } = useExportCredits(treasuryId);
    const { data: exportHistoryData, refetch: refetchHistory } = useExportHistory(treasuryId);
    const { data: assetsData } = useAssets(treasuryId, { onlyPositiveBalance: false });
    const aggregatedTokens = useAggregatedTokens(assetsData?.tokens || []);

    const [isExporting, setIsExporting] = useState(false);
    const [currentTab, setCurrentTab] = useState<string>("generate");

    // Calculate min date based on plan
    const minDate = useMemo(() => {
        if (!planDetails?.planConfig?.limits?.historyLookupMonths) return undefined;
        return subMonths(new Date(), planDetails.planConfig.limits.historyLookupMonths);
    }, [planDetails?.planConfig?.limits?.historyLookupMonths]);

    const form = useForm<z.infer<typeof exportFormSchema>>({
        resolver: zodResolver(exportFormSchema),
        defaultValues: {
            email: "",
            documentType: "csv",
            dateRange: {
                from: minDate || new Date(new Date().setMonth(new Date().getMonth() - 1)),
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


    const handleExport = async () => {
        if (!treasuryId || !dateRange.from || !dateRange.to) {
            toast.error("Invalid date range", {
                description: "Please select a valid date range for export.",
            });
            return;
        }

        setIsExporting(true);
        try {
            const formValues = form.getValues();
            const params = new URLSearchParams({
                account_id: treasuryId,
                start_time: dateRange.from.toISOString(),
                end_time: dateRange.to.toISOString(),
                format: documentType, // csv, json, or xlsx
            });

            if (accountId) {
                params.append("generated_by", accountId);
            }

            // Add email if provided and valid
            if (formValues.email && formValues.email.trim()) {
                params.append("email", formValues.email.trim());
            }

            // Add token_ids if specific assets are selected (excluding "all")
            const specificAssets = selectedAssets.filter(a => a !== "all");
            if (specificAssets.length > 0) {
                const tokenIds: string[] = [];
                specificAssets.forEach(assetSymbol => {
                    const token = aggregatedTokens.find((t: any) => t.symbol === assetSymbol);
                    if (token) {
                        token.networks.forEach((n: any) => tokenIds.push(n.id));
                    }
                });
                if (tokenIds.length > 0) {
                    params.append("token_ids", tokenIds.join(","));
                }
            }

            // Add transaction_types if specific types are selected (excluding "all")
            const specificTypes = selectedTransactionTypes.filter(t => t !== "all");
            if (specificTypes.length > 0 && specificTypes.length < TRANSACTION_TYPES.length - 1) {
                params.append("transaction_types", specificTypes.join(","));
            }

            const url = `${BACKEND_API_BASE}/api/balance-history/export?${params.toString()}`;

            const response = await fetch(url);

            if (!response.ok) {
                const errorText = await response.text();
                let errorMessage = "Export failed";

                try {
                    const errorJson = JSON.parse(errorText);
                    errorMessage = errorJson.message || errorJson.error || errorText;
                } catch {
                    errorMessage = errorText || "Export failed";
                }

                throw new Error(errorMessage);
            }

            const blob = await response.blob();
            const downloadUrl = window.URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = downloadUrl;

            const filename = `balance_changes_${treasuryId}_${dateRange.from.toISOString().split('T')[0]}_to_${dateRange.to.toISOString().split('T')[0]}.${documentType}`;
            link.download = filename;

            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(downloadUrl);

            toast.success("Export successful!", {
                description: `Your ${documentType.toUpperCase()} file has been downloaded. Check your export history for details.`,
            });

            // Refetch credits and history
            await Promise.all([refetchCredits(), refetchHistory()]);

            // Navigate to history tab
            setCurrentTab("history");
        } catch (error) {
            console.error("Export error:", error);
            const errorMessage = error instanceof Error ? error.message : "Failed to export data. Please try again.";

            toast.error("Export failed", {
                description: errorMessage,
            });
        } finally {
            setIsExporting(false);
        }
    };

    const historyText = formatHistoryDuration(planDetails?.planConfig?.limits?.historyLookupMonths);

    const toggleSelection = <T extends string>(
        fieldName: "selectedAssets" | "selectedTransactionTypes",
        value: T
    ) => {
        const currentSelection = form.getValues(fieldName);
        if (value === "all") {
            form.setValue(fieldName, ["all"] as any, { shouldValidate: true });
        } else {
            const newSelection = currentSelection.includes(value)
                ? currentSelection.filter(item => item !== value)
                : [...currentSelection.filter(item => item !== "all"), value];

            form.setValue(fieldName, newSelection.length === 0 ? ["all"] : newSelection as any, { shouldValidate: true });
        }
    };

    const toggleAsset = (asset: string) => toggleSelection("selectedAssets", asset);
    const toggleTransactionType = (type: TransactionType) => toggleSelection("selectedTransactionTypes", type);

    const getSelectedAssetsLabel = () => {
        if (selectedAssets.includes("all") || selectedAssets.length === 0) return "All Assets";
        if (selectedAssets.length === 1) return selectedAssets[0];
        return `${selectedAssets.length} assets selected`;
    };

    const getSelectedTypesLabel = () => {
        if (selectedTransactionTypes.includes("all") || selectedTransactionTypes.length === 0) return "All Types";
        if (selectedTransactionTypes.length === 1) {
            const type = TRANSACTION_TYPES.find(t => t.value === selectedTransactionTypes[0]);
            return type?.label || "All Types";
        }
        return `${selectedTransactionTypes.length} types selected`;
    };

    const canGenerateExport = useMemo(() => {
        const credits = exportCreditsData?.exportCredits ?? 0;
        return credits > 0;
    }, [exportCreditsData]);

    const exportCreditsUsed = exportCreditsData?.creditsUsed ?? 0;
    const exportCreditsTotal = exportCreditsData?.totalCredits ?? planDetails?.planConfig?.limits?.monthlyExportCredits ?? 0;
    const exportCreditsRemaining = exportCreditsData?.exportCredits ?? 0;

    // Show loading skeleton
    if (planLoading) {
        return (
            <PageComponentLayout
                title="Dashboard"
                description="Manage your treasury assets and track activity"
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
        <PageComponentLayout
            title="Dashboard"
            description="Manage your treasury assets and track activity"
        >
            <div className="flex flex-wrap justify-center gap-6 w-full">
                {/* Main Content */}
                <div className="flex-1 min-w-0 max-w-3xl">
                    <PageCard className="gap-2">
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col pb-3">
                                <div className="flex items-center gap-2 mb-1">
                                    <Button
                                        variant="unstyled"
                                        size="icon"
                                        onClick={() => router.push(`/${treasuryId}/dashboard`)}
                                        className="p-0!"
                                    >
                                        <ArrowLeft className="w-5 h-5" />
                                    </Button>
                                    <h4 className="text-lg font-bold">Export Recent Transactions</h4>
                                </div>
                                <p className="text-sm text-muted-foreground">
                                    Export generation and downloads are available to team members only.
                                </p>
                            </div>

                            <Tabs value={currentTab} onValueChange={setCurrentTab} className="gap-0">
                                <TabsList className="w-fit border-none">
                                    <TabsTrigger value="generate">Generate Export</TabsTrigger>
                                    <TabsTrigger value="history">History</TabsTrigger>
                                </TabsList>

                                <TabsContent value="generate" className="mt-4">
                                    <div className="space-y-4">
                                        {/* Document Type */}
                                        <div>
                                            <label className="text-sm font-medium mb-2 block">Document Type</label>
                                            <div className="flex gap-2">
                                                {DOCUMENT_TYPES.map((type) => (
                                                    <Button
                                                        key={type.value}
                                                        variant="unstyled"
                                                        onClick={() => form.setValue("documentType", type.value, { shouldValidate: true })}
                                                        className={cn(
                                                            "flex-1 border",
                                                            documentType === type.value
                                                                ? "bg-secondary"
                                                                : ""
                                                        )}
                                                        style={{
                                                            borderColor: documentType === type.value
                                                                ? 'var(--general-unofficial-border-5)'
                                                                : 'var(--general-unofficial-border-3)',
                                                        }}
                                                    >
                                                        {type.label}
                                                    </Button>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Time Range */}
                                        <div>
                                            <label className="text-sm font-medium mb-2 block">Time Range</label>
                                            <DateRangePicker
                                                initialDateFrom={dateRange.from}
                                                initialDateTo={dateRange.to}
                                                align="start"
                                                locale="en-US"
                                                minDate={minDate}
                                                maxDate={new Date()}
                                                onUpdate={(values: any) => {
                                                    if (values.range) {
                                                        form.setValue("dateRange", values.range, { shouldValidate: true });
                                                    }
                                                }}
                                            />
                                        </div>

                                        {/* Asset Selection */}
                                        <div>
                                            <label className="text-sm font-medium mb-2 block">Asset</label>
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button variant="outline" className="w-full justify-between bg-transparent! border-2">
                                                        <div className="flex items-center gap-2">
                                                            <Coins className="w-4 h-4" />
                                                            {getSelectedAssetsLabel()}
                                                        </div>
                                                        <ChevronDown className="w-4 h-4 opacity-50" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent className="min-w-(--radix-dropdown-menu-trigger-width)" align="start">
                                                    <DropdownMenuCheckboxItem
                                                        checked={selectedAssets.includes("all")}
                                                        onCheckedChange={() => toggleAsset("all")}
                                                        onSelect={(e) => e.preventDefault()}
                                                    >
                                                        <div className="flex items-center">
                                                            <Coins className="w-4 h-4 mr-2" />
                                                            All Assets
                                                        </div>
                                                    </DropdownMenuCheckboxItem>
                                                    {aggregatedTokens.map((token: any) => (
                                                        <DropdownMenuCheckboxItem
                                                            key={token.symbol}
                                                            checked={selectedAssets.includes(token.symbol)}
                                                            onCheckedChange={() => toggleAsset(token.symbol)}
                                                            onSelect={(e) => e.preventDefault()}
                                                        >
                                                            <div className="flex items-center">
                                                                {token.icon && (
                                                                    <img src={token.icon} alt={token.symbol} className="w-4 h-4 rounded-full mr-2" />
                                                                )}
                                                                {token.symbol}
                                                            </div>
                                                        </DropdownMenuCheckboxItem>
                                                    ))}
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </div>

                                        {/* Transaction Type */}
                                        <div>
                                            <label className="text-sm font-medium mb-2 block">Transaction Type</label>
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button variant="outline" className="w-full justify-between bg-transparent! border-2">
                                                        {getSelectedTypesLabel()}
                                                        <ChevronDown className="w-4 h-4 opacity-50" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent className="min-w-(--radix-dropdown-menu-trigger-width)" align="start">
                                                    {TRANSACTION_TYPES.map((type) => (
                                                        <DropdownMenuCheckboxItem
                                                            key={type.value}
                                                            checked={selectedTransactionTypes.includes(type.value)}
                                                            onCheckedChange={() => toggleTransactionType(type.value)}
                                                            onSelect={(e) => e.preventDefault()}
                                                        >
                                                            {type.label}
                                                        </DropdownMenuCheckboxItem>
                                                    ))}
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </div>

                                        {/* Email */}
                                        <div>
                                            <label htmlFor="email" className="text-sm font-medium mb-2 block">Email</label>
                                            <Input
                                                id="email"
                                                type="email"
                                                placeholder="example@mail.com"
                                                {...form.register("email")}
                                                className={cn(
                                                    form.formState.errors.email && "border-destructive focus-visible:ring-destructive"
                                                )}
                                            />
                                            {form.formState.errors.email ? (
                                                <p className="text-xs text-destructive mt-1.5">
                                                    {form.formState.errors.email.message}
                                                </p>
                                            ) : (
                                                <p className="text-xs text-muted-foreground mt-1.5">
                                                    We respect your privacy - your email is used only for export notifications and is not stored.
                                                </p>
                                            )}
                                        </div>

                                        {/* Export Button */}
                                        <Button
                                            onClick={handleExport}
                                            disabled={
                                                !dateRange.from ||
                                                !dateRange.to ||
                                                isExporting ||
                                                !canGenerateExport ||
                                                !!form.formState.errors.email
                                            }
                                            className="w-full mt-3"
                                        >
                                            {isExporting ? "Exporting..." : "Export"}
                                        </Button>
                                    </div>
                                </TabsContent>

                                <TabsContent value="history" className="mt-4">
                                    {!exportHistoryData || exportHistoryData.data.length === 0 ? (
                                        <EmptyState
                                            icon={FileX}
                                            title="No exports yet"
                                            description="Your exported files from the last month will appear here once they're generated."
                                        />
                                    ) : (
                                        <ExportHistoryTable items={exportHistoryData.data} />
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
                            backgroundColor: "var(--color-general-tertiary)",
                        }}
                        className="gap-2 w-full"
                    >
                        <h5 className="font-semibold">Export Requirements</h5>
                        <div className="space-y-3 text-sm">
                            <div className="flex gap-2.5">
                                <Calendar className="w-5 h-5 shrink-0 mt-0.5" />
                                <span>
                                    You can export data from the {historyText}.
                                </span>
                            </div>
                            <div className="flex gap-2.5">
                                <Mail className="w-5 h-5 shrink-0 mt-0.5" />
                                <span>
                                    We'll notify you by email when the export is ready.
                                </span>
                            </div>
                            <div className="flex gap-2.5">
                                <Clock className="w-5 h-5 shrink-0 mt-0.5" />
                                <span>
                                    Exported files are available for download for 48 hours.
                                </span>
                            </div>
                        </div>
                    </PageCard>

                    {/* Export Quota */}
                    <PageCard
                        style={{
                            backgroundColor: "var(--color-general-tertiary)",
                        }}
                        className="w-full"
                    >
                        <div className="space-y-3">
                            {/* Header */}
                            <div className="flex items-center justify-between">
                                <h3 className="text-lg font-semibold">Export Quota</h3>
                                <span className="text-sm font-medium border-2 py-1 px-2 rounded-lg">
                                    {planDetails?.planConfig?.limits?.monthlyExportCredits === null
                                        ? "Unlimited"
                                        : `${exportCreditsTotal} / month`
                                    }
                                </span>
                            </div>

                            {/* Credits Display */}
                            <div className="space-y-2 border-b-[0.2px] border-general-unofficial-border pb-4">
                                <div className="flex items-center justify-between text-sm">
                                    <span className="font-semibold">
                                        {exportCreditsRemaining} Available
                                    </span>
                                    <span className="text-muted-foreground text-xs">
                                        {exportCreditsUsed} Used
                                    </span>
                                </div>

                                {/* Progress bar */}
                                <div className="w-full h-2 bg-general-unofficial-accent rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-foreground transition-all"
                                        style={{
                                            width: planDetails?.planConfig?.limits?.monthlyExportCredits === null
                                                ? "0%"
                                                : exportCreditsTotal === 0
                                                    ? "0%"
                                                    : `${Math.min(100, (exportCreditsUsed / exportCreditsTotal) * 100)}%`
                                        }}
                                    />
                                </div>
                            </div>

                            {/* Upgrade CTA */}
                            <div className="flex items-center justify-between">
                                <span className="text-sm text-secondary-foreground">
                                    Looking for more flexibility?
                                </span>
                                <Button
                                    variant={exportCreditsRemaining === 0 ? "default" : "outline"}
                                    size="sm"
                                    className="p-3!"
                                >
                                    Upgrade Plan
                                </Button>
                            </div>
                        </div>
                    </PageCard>
                </div>
            </div>
        </PageComponentLayout>
    );
}
