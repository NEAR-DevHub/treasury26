"use client";

import { useState, useEffect } from "react";
import { useFormContext } from "react-hook-form";
import { useTranslations } from "next-intl";
import { PageCard } from "@/components/card";
import { Button } from "@/components/button";
import { Textarea } from "@/components/textarea";
import { Upload, FileText, ArrowLeft, DollarSign, Info, X } from "lucide-react";
import TokenSelect, { SelectedTokenData } from "@/components/token-select";
import { NumberBadge } from "@/components/number-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CreateRequestButton } from "@/components/create-request-button";
import { useSubscription } from "@/hooks/use-subscription";
import { isTrialPlan } from "@/lib/subscription-api";
import { BulkPaymentCreditsDisplay } from "./bulk-payment-credits-display";
import { MAX_RECIPIENTS_PER_BULK_PAYMENT } from "@/lib/bulk-payment-api";
import type { BulkPaymentFormValues, BulkPaymentData } from "../schemas";
import {
    Tabs,
    TabsList,
    TabsTrigger,
    TabsContent,
} from "@/components/underline-tabs";
import {
    parseAndValidateCsv,
    parseAndValidatePasteData,
    validateIntentsFeeCoverage,
} from "../utils";
import { useBulkParsingLabels } from "../utils/use-parsing-labels";

interface UploadDataStepProps {
    handleBack?: () => void;
    treasuryId: string;
    onContinue: (
        payments: BulkPaymentData[],
        networkFeePerRecipient: string | null,
    ) => void;
}

export function UploadDataStep({
    handleBack,
    treasuryId,
    onContinue,
}: UploadDataStepProps) {
    const t = useTranslations("bulkPayment.upload");
    const parsingLabels = useBulkParsingLabels();
    const form = useFormContext<BulkPaymentFormValues>();
    const { data: subscription, isLoading: isLoadingSubscription } =
        useSubscription(treasuryId);
    const [isDragging, setIsDragging] = useState(false);
    const [uploadedFile, setUploadedFile] = useState<File | null>(null);
    const [dataErrors, setDataErrors] = useState<Array<{
        row: number;
        message: string;
    }> | null>(null);
    const [isReviewLoading, setIsReviewLoading] = useState(false);

    const isLoading = isLoadingSubscription;
    const availableCredits = subscription?.batchPaymentCredits ?? 0;
    const totalCredits =
        subscription?.planConfig.limits.monthlyBatchPaymentCredits ??
        subscription?.planConfig.limits.trialBatchPaymentCredits ??
        0;
    const creditsUsed = totalCredits - availableCredits;

    const selectedToken = form.watch("selectedToken");
    const csvData = form.watch("csvData");
    const pasteDataInput = form.watch("pasteDataInput");
    const activeTab = form.watch("activeTab");
    const uploadedFileName = form.watch("uploadedFileName");

    // Restore uploaded file state when navigating back
    useEffect(() => {
        if (uploadedFileName && !uploadedFile) {
            const file = new File([""], uploadedFileName, { type: "text/csv" });
            setUploadedFile(file);
        }
    }, [uploadedFileName, uploadedFile]);

    const handleFileUpload = (file: File) => {
        if (file.type !== "text/csv" && !file.name.endsWith(".csv")) {
            setDataErrors([{ row: 0, message: t("pleaseUploadCsv") }]);
            return;
        }

        if (file.size > 1.5 * 1024 * 1024) {
            setDataErrors([{ row: 0, message: t("fileSizeLimit") }]);
            return;
        }

        // Clear any previous errors when uploading a new file
        setDataErrors(null);
        setUploadedFile(file);

        // Store the filename in form state
        form.setValue("uploadedFileName", file.name);

        const reader = new FileReader();
        reader.onload = (e) => {
            const text = e.target?.result as string;
            form.setValue("csvData", text);
        };

        reader.readAsText(file);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);

        const file = e.dataTransfer.files[0];
        if (file) {
            handleFileUpload(file);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = () => {
        setIsDragging(false);
    };

    const downloadTemplate = () => {
        const csvContent =
            "recipient,amount\nalice.near,10.5\nbob.near,25\ncharlie.near,100";
        const blob = new Blob([csvContent], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "bulk_payment_template.csv";
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleContinue = async () => {
        // Validate that we have required data
        if (!selectedToken) {
            setDataErrors([{ row: 0, message: t("selectTokenError") }]);
            return;
        }

        if (activeTab === "upload" && !csvData) {
            setDataErrors([{ row: 0, message: t("pleaseUploadCsv") }]);
            return;
        }

        if (activeTab === "paste" && !pasteDataInput.trim()) {
            setDataErrors([{ row: 0, message: t("providePaymentDataError") }]);
            return;
        }

        setDataErrors(null);
        setIsReviewLoading(true);
        try {
            // Parse and validate data
            let result: {
                payments: BulkPaymentData[];
                errors: Array<{ row: number; message: string }>;
            };

            if (activeTab === "upload" && csvData) {
                result = parseAndValidateCsv(
                    csvData,
                    parsingLabels,
                    selectedToken,
                );
            } else {
                result = parseAndValidatePasteData(
                    pasteDataInput,
                    parsingLabels,
                    selectedToken,
                );
            }

            if (result.errors.length > 0) {
                // Show errors in the component
                setDataErrors(result.errors);
                return;
            }

            if (activeTab === "paste") {
                const feeValidationResult = await validateIntentsFeeCoverage(
                    result.payments,
                    selectedToken,
                    parsingLabels,
                );
                const feeErrors = feeValidationResult.payments
                    .filter((payment) => !!payment.validationError)
                    .map((payment) => ({
                        row: payment.row || 0,
                        message: payment.validationError!,
                    }));

                if (feeErrors.length > 0) {
                    setDataErrors(feeErrors);
                    return;
                }

                onContinue(
                    feeValidationResult.payments,
                    feeValidationResult.networkFee,
                );
                return;
            }

            // Pass validated payments to parent
            onContinue(result.payments, null);
        } finally {
            setIsReviewLoading(false);
        }
    };

    // Show full page skeleton while loading
    if (isLoading) {
        return (
            <div className="flex flex-wrap justify-center gap-6 w-full">
                {/* Main Content Skeleton */}
                <div className="flex-1 min-w-0 max-w-3xl">
                    <PageCard className="gap-2">
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col">
                                <div className="flex items-center gap-2">
                                    {handleBack && (
                                        <Button
                                            variant="unstyled"
                                            size="icon"
                                            onClick={handleBack}
                                            className="p-0!"
                                        >
                                            <ArrowLeft className="w-5 h-5" />
                                        </Button>
                                    )}
                                    <h4 className="text-lg font-bold mb-1">
                                        {t("headerTitle")}
                                    </h4>
                                </div>
                                <p className="text-sm text-muted-foreground">
                                    {t("headerSubtitle")}
                                </p>
                            </div>

                            {/* Step 1 Skeleton */}
                            <div>
                                <div className="flex gap-2 mb-4">
                                    <div className="w-6 h-6 bg-muted-foreground/20 rounded-full animate-pulse" />
                                    <div className="flex-1 space-y-3">
                                        <div className="h-5 bg-muted-foreground/20 rounded w-32 animate-pulse" />
                                        <div className="h-14 bg-muted-foreground/20 rounded animate-pulse" />
                                    </div>
                                </div>
                            </div>

                            {/* Step 2 Skeleton */}
                            <div>
                                <div className="flex gap-2 mb-4">
                                    <div className="w-6 h-6 bg-muted-foreground/20 rounded-full animate-pulse" />
                                    <div className="flex-1 space-y-3">
                                        <div className="h-5 bg-muted-foreground/20 rounded w-48 animate-pulse" />
                                        <div className="h-10 bg-muted-foreground/20 rounded animate-pulse" />
                                        <div className="h-64 bg-muted-foreground/20 rounded animate-pulse" />
                                    </div>
                                </div>
                            </div>

                            {/* Button Skeleton */}
                            <div className="h-12 bg-muted-foreground/20 rounded animate-pulse" />
                        </div>
                    </PageCard>
                </div>

                {/* Sidebar Skeleton */}
                <div className="flex flex-col gap-4 w-full lg:w-80 shrink-0">
                    {/* Requirements Card Skeleton */}
                    <PageCard
                        style={{
                            backgroundColor: "var(--color-general-tertiary)",
                        }}
                        className="gap-2 w-full"
                    >
                        <div className="h-6 bg-muted-foreground/20 rounded w-48 animate-pulse mb-3" />
                        <div className="space-y-3">
                            <div className="h-4 bg-muted-foreground/20 rounded animate-pulse" />
                            <div className="h-4 bg-muted-foreground/20 rounded animate-pulse" />
                        </div>
                    </PageCard>

                    {/* Credits Card Skeleton */}
                    <PageCard
                        style={{
                            backgroundColor: "var(--color-general-tertiary)",
                        }}
                        className="w-full"
                    >
                        <div className="space-y-3">
                            <div className="h-6 bg-muted-foreground/20 rounded animate-pulse" />
                            <div className="h-4 bg-muted-foreground/20 rounded animate-pulse" />
                            <div className="h-4 bg-muted-foreground/20 rounded animate-pulse" />
                        </div>
                    </PageCard>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-wrap justify-center gap-4 w-full">
            {/* Main Content */}
            <div className="flex-1 max-w-[600px] min-w-[300px]">
                <PageCard className="gap-2">
                    {/* Header */}
                    <div className="flex flex-col gap-3">
                        <div className="flex flex-col mb-3">
                            <div className="flex items-center gap-2">
                                {handleBack && (
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={handleBack}
                                        className="p-0!"
                                    >
                                        <ArrowLeft />
                                    </Button>
                                )}
                                <div className="flex flex-col">
                                    <p className="font-semibold mb-1">
                                        {t("headerTitle")}
                                    </p>
                                    <p className="text-sm text-muted-foreground">
                                        {t("headerSubtitle")}
                                    </p>
                                </div>
                            </div>
                        </div>
                        {/* Credit Exhaustion Banner */}
                        {availableCredits === 0 && subscription && (
                            <Alert variant="info" className="mb-3">
                                <Info className="h-4 w-4 mt-[2px]" />
                                <AlertTitle className="font-semibold">
                                    {isTrialPlan(subscription.planConfig)
                                        ? t("creditsUsed")
                                        : t("bulkPaymentsUsed")}
                                </AlertTitle>
                                <AlertDescription className="text-general-info-foreground">
                                    {isTrialPlan(subscription.planConfig)
                                        ? t("upgradeTrial")
                                        : t("upgradePaid")}
                                </AlertDescription>
                            </Alert>
                        )}
                        {/* Step 1: Select Asset */}
                        <div>
                            <div className="flex gap-2 mb-4">
                                <NumberBadge number={1} variant="secondary" />
                                <div className="flex-1 flex flex-col gap-2">
                                    <h3 className="text-sm font-semibold">
                                        {t("selectAsset")}
                                    </h3>

                                    <TokenSelect
                                        selectedToken={
                                            selectedToken as SelectedTokenData | null
                                        }
                                        setSelectedToken={(token) =>
                                            form.setValue(
                                                "selectedToken",
                                                token,
                                            )
                                        }
                                        disableTokens={(token) =>
                                            token.address.startsWith("nep245:")
                                        }
                                        disableTokenMessage={t(
                                            "disableTokenMessage",
                                        )}
                                        disabled={availableCredits === 0}
                                        iconSize="lg"
                                        classNames={{
                                            trigger:
                                                "w-full h-14 rounded-lg px-4 bg-muted hover:bg-muted/80 hover:border-none",
                                        }}
                                    />
                                </div>
                            </div>
                        </div>
                        {/* Step 2: Provide Payment Data */}
                        <div className="mb-4">
                            <div className="flex gap-2 mb-4">
                                <NumberBadge number={2} variant="secondary" />
                                <div className="flex-1 flex flex-col gap-2">
                                    <h3 className="text-sm font-semibold">
                                        {t("providePaymentData")}
                                    </h3>

                                    <Tabs
                                        value={activeTab}
                                        onValueChange={(value) => {
                                            form.setValue(
                                                "activeTab",
                                                value as "upload" | "paste",
                                            );
                                            setDataErrors(null);
                                        }}
                                    >
                                        <TabsList>
                                            <TabsTrigger value="upload">
                                                {t("uploadFile")}
                                            </TabsTrigger>
                                            <TabsTrigger value="paste">
                                                {t("provideData")}
                                            </TabsTrigger>
                                        </TabsList>

                                        {/* Upload Tab Content */}
                                        <TabsContent value="upload">
                                            <div className="space-y-4">
                                                {!uploadedFile ? (
                                                    <>
                                                        <div
                                                            className={`border-2 border-dashed hover:bg-general-tertiary focus-within:bg-general-tertiary transition-colors rounded-lg p-4 text-center ${
                                                                isDragging
                                                                    ? "border-primary bg-primary/5"
                                                                    : "border-border bg-muted"
                                                            }`}
                                                            onDrop={handleDrop}
                                                            onDragOver={
                                                                handleDragOver
                                                            }
                                                            onDragLeave={
                                                                handleDragLeave
                                                            }
                                                        >
                                                            <div className="flex flex-col items-center gap-4">
                                                                <Upload className="w-6 h-6 text-muted-foreground" />
                                                                <div>
                                                                    <p className="text-base mb-2">
                                                                        <Button
                                                                            type="button"
                                                                            variant="link"
                                                                            className="font-semibold h-auto p-0! hover:underline disabled:text-muted-foreground"
                                                                            onClick={() =>
                                                                                document
                                                                                    .getElementById(
                                                                                        "file-upload",
                                                                                    )
                                                                                    ?.click()
                                                                            }
                                                                            disabled={
                                                                                availableCredits ===
                                                                                0
                                                                            }
                                                                        >
                                                                            {t(
                                                                                "chooseFile",
                                                                            )}
                                                                        </Button>{" "}
                                                                        <span className="text-muted-foreground font-medium">
                                                                            {t(
                                                                                "orDragDrop",
                                                                            )}
                                                                        </span>
                                                                    </p>
                                                                    <p className="text-sm text-muted-foreground">
                                                                        {t(
                                                                            "maxFileSize",
                                                                        )}
                                                                    </p>
                                                                </div>
                                                                <input
                                                                    id="file-upload"
                                                                    type="file"
                                                                    accept=".csv"
                                                                    className="hidden"
                                                                    disabled={
                                                                        availableCredits ===
                                                                        0
                                                                    }
                                                                    onChange={(
                                                                        e,
                                                                    ) => {
                                                                        const file =
                                                                            e
                                                                                .target
                                                                                .files?.[0];
                                                                        if (
                                                                            file
                                                                        )
                                                                            handleFileUpload(
                                                                                file,
                                                                            );
                                                                    }}
                                                                />
                                                            </div>
                                                        </div>

                                                        <div className="flex items-center gap-2 text-sm">
                                                            <span className="text-muted-foreground">
                                                                {t(
                                                                    "noFilePrompt",
                                                                )}
                                                            </span>
                                                            <Button
                                                                type="button"
                                                                variant="link"
                                                                onClick={
                                                                    downloadTemplate
                                                                }
                                                                className="h-auto p-0! font-medium hover:underline text-general-unofficial-ghost-foreground"
                                                            >
                                                                {t(
                                                                    "downloadTemplate",
                                                                )}
                                                            </Button>
                                                        </div>
                                                    </>
                                                ) : (
                                                    <div
                                                        className={`rounded-lg p-4 flex items-center justify-between ${
                                                            dataErrors &&
                                                            dataErrors.length >
                                                                0
                                                                ? "bg-destructive/10 border border-destructive"
                                                                : "bg-muted/50"
                                                        }`}
                                                    >
                                                        <div className="flex items-center gap-3">
                                                            <FileText
                                                                className={`w-5 h-5 ${
                                                                    dataErrors &&
                                                                    dataErrors.length >
                                                                        0
                                                                        ? "text-destructive"
                                                                        : "text-primary"
                                                                }`}
                                                            />
                                                            <div>
                                                                <p className="text-sm font-medium">
                                                                    {
                                                                        uploadedFile.name
                                                                    }
                                                                </p>
                                                                <p className="text-xs text-muted-foreground">
                                                                    {(
                                                                        uploadedFile.size /
                                                                        1024
                                                                    ).toFixed(
                                                                        0,
                                                                    )}
                                                                    KB
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon"
                                                            onClick={() => {
                                                                setUploadedFile(
                                                                    null,
                                                                );
                                                                form.setValue(
                                                                    "csvData",
                                                                    null,
                                                                );
                                                                form.setValue(
                                                                    "uploadedFileName",
                                                                    null,
                                                                );
                                                                setDataErrors(
                                                                    null,
                                                                );
                                                            }}
                                                            className={`h-8 w-8 ${
                                                                dataErrors &&
                                                                dataErrors.length >
                                                                    0
                                                                    ? "text-destructive hover:text-destructive/80"
                                                                    : "text-muted-foreground hover:text-foreground"
                                                            }`}
                                                        >
                                                            <X className="w-4 h-4" />
                                                        </Button>
                                                    </div>
                                                )}

                                                {/* Error Message Below File Upload */}
                                                {activeTab === "upload" &&
                                                    dataErrors &&
                                                    dataErrors.length > 0 && (
                                                        <div className="space-y-1 max-h-48 overflow-y-auto overflow-x-hidden">
                                                            {dataErrors.map(
                                                                (
                                                                    error,
                                                                    idx,
                                                                ) => (
                                                                    <div
                                                                        key={
                                                                            idx
                                                                        }
                                                                        className="text-sm text-destructive break-word wrap-anywhere"
                                                                    >
                                                                        {
                                                                            error.message
                                                                        }
                                                                    </div>
                                                                ),
                                                            )}
                                                        </div>
                                                    )}
                                            </div>
                                        </TabsContent>

                                        {/* Paste Tab Content */}
                                        <TabsContent value="paste">
                                            <div className="space-y-2">
                                                <Textarea
                                                    value={pasteDataInput}
                                                    onChange={(e) => {
                                                        form.setValue(
                                                            "pasteDataInput",
                                                            e.target.value,
                                                        );
                                                        if (
                                                            dataErrors &&
                                                            dataErrors.length >
                                                                0
                                                        ) {
                                                            setDataErrors(null);
                                                        }
                                                    }}
                                                    borderless
                                                    placeholder={`alice.near, 100.00\nbob.near, 100.00\ncharlie.near, 100.00`}
                                                    rows={8}
                                                    className={`w-full max-w-full resize-none font-mono text-sm bg-muted focus:outline-none break-all whitespace-pre-wrap wrap-anywhere overflow-x-hidden min-h-41 ${
                                                        dataErrors &&
                                                        dataErrors.length > 0
                                                            ? "border border-destructive bg-destructive/5! focus:border-destructive!"
                                                            : "bg-muted"
                                                    }`}
                                                    disabled={
                                                        availableCredits === 0
                                                    }
                                                />

                                                {/* Error Message Below Textarea */}
                                                {dataErrors &&
                                                    dataErrors.length > 0 && (
                                                        <div className="space-y-1 max-h-48 overflow-y-auto overflow-x-hidden">
                                                            {dataErrors.map(
                                                                (
                                                                    error,
                                                                    idx,
                                                                ) => (
                                                                    <div
                                                                        key={
                                                                            idx
                                                                        }
                                                                        className="text-sm text-destructive break-word wrap-anywhere"
                                                                    >
                                                                        {
                                                                            error.message
                                                                        }
                                                                    </div>
                                                                ),
                                                            )}
                                                        </div>
                                                    )}
                                            </div>
                                        </TabsContent>
                                    </Tabs>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Continue Button */}
                    <CreateRequestButton
                        type="button"
                        disabled={
                            !selectedToken ||
                            (activeTab === "upload" && !csvData) ||
                            (activeTab === "paste" && !pasteDataInput.trim()) ||
                            availableCredits === 0 ||
                            isReviewLoading
                        }
                        onClick={handleContinue}
                        isSubmitting={isReviewLoading}
                        permissions={[
                            { kind: "transfer", action: "AddProposal" },
                            { kind: "call", action: "AddProposal" },
                        ]}
                        idleMessage={
                            availableCredits === 0
                                ? t("limitsUsed")
                                : !selectedToken ||
                                    (activeTab === "upload" && !csvData) ||
                                    (activeTab === "paste" &&
                                        !pasteDataInput.trim())
                                  ? t("selectAndProvide")
                                  : t("continueToReview")
                        }
                    />
                </PageCard>
            </div>

            {/* Right Sidebar */}
            <div className="flex flex-col gap-4 w-full lg:w-80 shrink-0">
                {/* Requirements Card */}
                <PageCard
                    style={{
                        backgroundColor: "var(--color-general-tertiary)",
                    }}
                    className="gap-3 w-full"
                >
                    <p className="font-semibold">{t("requirements")}</p>
                    <div className="space-y-3">
                        <div className="flex items-start gap-3">
                            <FileText className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                            <div>
                                <p className="text-sm">
                                    {t("maxTransactions", {
                                        max: MAX_RECIPIENTS_PER_BULK_PAYMENT,
                                    })}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-start gap-3">
                            <DollarSign className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                            <div>
                                <p className="text-sm">
                                    {t("singleTokenNetwork")}
                                </p>
                            </div>
                        </div>
                    </div>
                </PageCard>

                {/* Credits Display */}
                <PageCard
                    style={{
                        backgroundColor:
                            availableCredits === 0
                                ? "var(--color-general-info-background-faded)"
                                : "var(--color-general-tertiary)",
                    }}
                    className="w-full"
                >
                    {subscription && (
                        <BulkPaymentCreditsDisplay
                            credits={{
                                creditsAvailable: availableCredits,
                                creditsUsed: creditsUsed,
                                totalCredits: totalCredits,
                            }}
                            subscription={subscription}
                        />
                    )}
                </PageCard>
            </div>
        </div>
    );
}
