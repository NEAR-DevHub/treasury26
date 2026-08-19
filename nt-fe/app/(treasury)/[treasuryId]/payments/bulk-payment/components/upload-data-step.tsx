"use client";

import {
    Bitcoin,
    FileText,
    FileUp,
    Info,
    ReceiptText,
    Users,
    WalletCards,
    X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
    cloneElement,
    isValidElement,
    type ReactElement,
    useEffect,
    useState,
} from "react";
import { useFormContext } from "react-hook-form";
import { Button } from "@/components/button";
import { CreateRequestButton } from "@/components/create-request-button";
import { Textarea } from "@/components/textarea";
import TokenSelect, { type SelectedTokenData } from "@/components/token-select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    hasInlineWarning,
    SlotWarning,
    WarningMessage,
} from "@/components/warning-message";
import { useSubscription } from "@/hooks/use-subscription";
import {
    useBridgeAssetsForWarnings,
    useBridgeScopedWarning,
} from "@/hooks/use-warnings";
import { MAX_RECIPIENTS_PER_BULK_PAYMENT } from "@/lib/bulk-payment-api";
import { isTrialPlan } from "@/lib/subscription-api";
import { cn } from "@/lib/utils";
import type { BulkPaymentData, BulkPaymentFormValues } from "../schemas";
import {
    parseAndValidateCsv,
    parseAndValidatePasteData,
    validateIntentsFeeCoverage,
} from "../utils";
import { useBulkParsingLabels } from "../utils/use-parsing-labels";

interface UploadDataStepProps {
    treasuryId: string;
    onContinue: (
        payments: BulkPaymentData[],
        networkFeePerRecipient: string | null,
    ) => void;
    /** When true, restrict token picker to Intents tokens and skip credit
     * gating (confidential bulk has its own backend cost model). */
    isConfidential?: boolean;
    /** Slot rendered above the token select — used by confidential bulk to
     * surface the destination network picker. */
    networkSlot?: React.ReactNode;
    /**
     * Raw destination network name (e.g. "near", "eth", "sol") used to drive
     * recipient address validation in confidential bulk. When omitted,
     * validation falls back to the selected token's own network.
     */
    destinationNetwork?: string;
    /**
     * Destination intents asset id (e.g. "nep141:arb-...omft.near") used for
     * fee estimation in confidential bulk where source token chain differs
     * from the recipient chain.
     */
    destinationAssetId?: string | null;
}

export function UploadDataStep({
    treasuryId,
    onContinue,
    isConfidential = false,
    networkSlot,
    destinationNetwork,
    destinationAssetId,
}: UploadDataStepProps) {
    const t = useTranslations("bulkPayment.upload");
    const tCreate = useTranslations("createRequestButton");
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
    // Kept separate from dataErrors so the network card (not paste/upload)
    // owns the "select recipient network" validation state.
    const [networkError, setNetworkError] = useState<string | null>(null);
    const [isReviewLoading, setIsReviewLoading] = useState(false);
    const [hasAcknowledgedExchangeRisk, setHasAcknowledgedExchangeRisk] =
        useState(false);

    const isLoading = isLoadingSubscription;
    const availableCredits = subscription?.batchPaymentCredits ?? 0;

    const selectedToken = form.watch("selectedToken");
    const csvData = form.watch("csvData");
    const pasteDataInput = form.watch("pasteDataInput");
    const activeTab = form.watch("activeTab");
    const uploadedFileName = form.watch("uploadedFileName");

    const { data: bridgeAssets = [] } = useBridgeAssetsForWarnings("payments");
    const { blocked: paymentsSlotBlocked, scopedMessage: sendWarningMessage } =
        useBridgeScopedWarning(
            "payments",
            bridgeAssets,
            selectedToken?.address,
        );
    const showTokenWarning =
        selectedToken != null && hasInlineWarning(sendWarningMessage);

    // Restore uploaded file state when navigating back
    useEffect(() => {
        if (uploadedFileName && !uploadedFile) {
            const file = new File([""], uploadedFileName, { type: "text/csv" });
            setUploadedFile(file);
        }
    }, [uploadedFileName, uploadedFile]);

    // Clear network-card error once a recipient network is selected.
    useEffect(() => {
        if (destinationNetwork) {
            setNetworkError(null);
        }
    }, [destinationNetwork]);

    // Address/network validation errors are tied to the selected token (and
    // confidential receive network). Clear them when either changes so a
    // fixed selection doesn't leave a stale Continue-time error on screen.
    useEffect(() => {
        setDataErrors(null);
    }, [selectedToken?.address, selectedToken?.residency, destinationNetwork]);

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

        // Confidential bulk requires a picked recipient network — its raw name
        // drives address validation for ALL recipients. The picker is gated on
        // having payment data; block Continue if they haven't chosen one yet.
        if (isConfidential && !destinationNetwork) {
            setNetworkError(t("selectRecipientNetwork"));
            return;
        }

        setNetworkError(null);
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
                    destinationNetwork,
                );
            } else {
                result = parseAndValidatePasteData(
                    pasteDataInput,
                    parsingLabels,
                    selectedToken,
                    destinationNetwork,
                );
            }

            if (result.errors.length > 0) {
                // Show errors in the component
                setDataErrors(result.errors);
                return;
            }

            // Confidential bulk to NEAR.COM has no withdrawal fee — skip
            // estimation entirely (the SDK can't price a destination-less
            // transfer and would throw).
            const skipFeeValidation = isConfidential && !destinationAssetId;

            // Confidential cross-chain pads each recipient amount by the
            // estimated network fee at submit time, so coverage errors are
            // not blocking — we just need the per-recipient fee for display
            // and padding. Public bulk still treats coverage as a blocker
            // (paste tab only, matching prior behavior).
            const needsFeeEstimation =
                !skipFeeValidation && (isConfidential || activeTab === "paste");

            if (needsFeeEstimation) {
                const feeValidationResult = await validateIntentsFeeCoverage(
                    result.payments,
                    isConfidential && destinationAssetId
                        ? { ...selectedToken, address: destinationAssetId }
                        : selectedToken,
                    parsingLabels,
                    // Confidential: quote against the receive network, not
                    // the source token's residency chain.
                    isConfidential ? destinationNetwork : undefined,
                );

                if (!isConfidential) {
                    const feeErrors = feeValidationResult.payments.flatMap(
                        (payment) =>
                            payment.validationError
                                ? [
                                      {
                                          row: payment.row || 0,
                                          message: payment.validationError,
                                      },
                                  ]
                                : [],
                    );

                    if (feeErrors.length > 0) {
                        setDataErrors(feeErrors);
                        return;
                    }
                }

                onContinue(
                    isConfidential
                        ? result.payments
                        : feeValidationResult.payments,
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
            <div className="flex w-full min-w-0 flex-col items-start justify-center gap-5 lg:flex-row">
                <div className="mx-auto flex w-full min-w-0 max-w-[464px] flex-col gap-2 lg:mx-0">
                    <div className="h-[72px] animate-pulse rounded-3xl bg-general-unofficial-accent-0" />
                    <div className="h-12 animate-pulse rounded-2xl bg-general-unofficial-accent-0" />
                    <div className="h-[178px] animate-pulse rounded-3xl bg-general-unofficial-accent-0" />
                    <div className="h-7 w-72 animate-pulse rounded-lg bg-general-unofficial-accent-0" />
                    <div className="h-[72px] animate-pulse rounded-3xl bg-general-unofficial-accent-0" />
                    <div className="h-[66px] animate-pulse rounded-xl bg-general-unofficial-accent-0" />
                    <div className="h-11 animate-pulse rounded-2xl bg-general-unofficial-accent-0" />
                </div>
                <div className="mx-auto h-[123px] w-full max-w-[300px] shrink-0 animate-pulse rounded-3xl bg-general-unofficial-accent-0 lg:mx-0" />
            </div>
        );
    }

    return (
        <div className="flex w-full min-w-0 flex-col items-start justify-center gap-5 lg:flex-row">
            <div className="mx-auto flex w-full min-w-0 max-w-[464px] flex-col gap-2 lg:mx-0">
                {availableCredits === 0 && subscription && (
                    <Alert variant="info" className="mb-1">
                        <Info className="mt-[2px] size-4" />
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

                <SlotWarning slot="payments" />

                <div
                    className={cn(
                        "w-full min-w-0",
                        showTokenWarning &&
                            "flex flex-col rounded-3xl border border-general-border bg-card px-1 pb-3",
                    )}
                >
                    <TokenSelect
                        selectedToken={
                            selectedToken as SelectedTokenData | null
                        }
                        setSelectedToken={(token) =>
                            form.setValue("selectedToken", token)
                        }
                        disableTokens={(token) =>
                            isConfidential
                                ? token.residency?.toLowerCase() !== "intents"
                                : token.address.startsWith("nep245:")
                        }
                        disableTokenMessage={t("disableTokenMessage")}
                        disabled={availableCredits === 0}
                        iconSize="2xl"
                        triggerLabel={t("token")}
                        classNames={{
                            trigger: showTokenWarning
                                ? "h-[72px] w-full shrink-0 rounded-3xl border-0 bg-transparent px-4! shadow-none hover:bg-transparent"
                                : "h-[72px] w-full rounded-3xl border border-general-border bg-card px-4! shadow-none hover:border-general-border hover:bg-card",
                        }}
                    />
                    {showTokenWarning && (
                        <WarningMessage
                            variant="inline"
                            message={sendWarningMessage}
                            className="pl-3 text-xs"
                        />
                    )}
                </div>

                <Tabs
                    value={activeTab}
                    onValueChange={(value) => {
                        form.setValue("activeTab", value as "upload" | "paste");
                        setDataErrors(null);
                    }}
                >
                    <TabsList className="h-12 w-full justify-stretch gap-1 rounded-2xl border border-general-border bg-transparent">
                        <TabsTrigger
                            value="upload"
                            className="h-10 flex-1 rounded-[12px] px-2 py-3 font-bold text-general-unofficial-ghost-foreground data-[state=active]:border-general-border data-[state=active]:bg-card dark:data-[state=active]:border-general-border dark:data-[state=active]:bg-card"
                        >
                            <WalletCards className="size-4" />
                            {t("uploadFile")}
                        </TabsTrigger>
                        <TabsTrigger
                            value="paste"
                            className="h-10 flex-1 rounded-[12px] px-2 py-3 font-bold text-general-unofficial-ghost-foreground data-[state=active]:border-general-border data-[state=active]:bg-card dark:data-[state=active]:border-general-border dark:data-[state=active]:bg-card"
                        >
                            <Users className="size-4" />
                            {t("provideData")}
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="upload">
                        <div className="flex flex-col gap-1">
                            {!uploadedFile ? (
                                <>
                                    {/* biome-ignore lint/a11y/noStaticElementInteractions: Drag-and-drop supplements the accessible file button below. */}
                                    <div
                                        className={cn(
                                            "flex h-[178px] items-center justify-center rounded-3xl border border-general-border bg-card px-6 text-center transition-colors hover:bg-general-tertiary focus-within:bg-general-tertiary",
                                            isDragging &&
                                                "border-primary bg-primary/5",
                                        )}
                                        onDrop={handleDrop}
                                        onDragOver={handleDragOver}
                                        onDragLeave={handleDragLeave}
                                    >
                                        <div className="flex flex-col items-center gap-2.5">
                                            <span className="flex size-10 items-center justify-center rounded-full border border-general-border bg-muted">
                                                <FileUp className="size-[18px] text-muted-foreground" />
                                            </span>
                                            <div className="flex flex-col gap-1">
                                                <p className="text-base leading-[1.2]">
                                                    <Button
                                                        type="button"
                                                        variant="link"
                                                        className="h-auto p-0! font-semibold text-foreground hover:underline disabled:text-muted-foreground"
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
                                                        {t("chooseFile")}
                                                    </Button>{" "}
                                                    <span className="font-medium text-muted-foreground">
                                                        {t("orDragDrop")}
                                                    </span>
                                                </p>
                                                <p className="text-sm leading-5 text-muted-foreground">
                                                    {t("maxFileSize")}
                                                </p>
                                            </div>
                                            <input
                                                id="file-upload"
                                                type="file"
                                                accept=".csv"
                                                className="hidden"
                                                disabled={
                                                    availableCredits === 0
                                                }
                                                onChange={(event) => {
                                                    const file =
                                                        event.target.files?.[0];
                                                    if (file)
                                                        handleFileUpload(file);
                                                }}
                                            />
                                        </div>
                                    </div>

                                    <div className="flex min-h-7 flex-wrap items-center gap-1 text-sm font-medium">
                                        <span>{t("noFilePrompt")}</span>
                                        <Button
                                            type="button"
                                            variant="link"
                                            onClick={downloadTemplate}
                                            className="h-7 px-2! py-[3px] text-xs font-bold text-general-unofficial-ghost-foreground hover:underline"
                                        >
                                            {t("downloadTemplate")}
                                        </Button>
                                    </div>
                                </>
                            ) : (
                                <div
                                    className={cn(
                                        "flex h-[72px] items-center justify-between rounded-3xl border border-general-border bg-card px-4",
                                        dataErrors?.length &&
                                            "border-destructive bg-destructive/5",
                                    )}
                                >
                                    <div className="flex min-w-0 items-center gap-3">
                                        <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-general-border bg-muted">
                                            <FileText
                                                className={cn(
                                                    "size-5 text-primary",
                                                    dataErrors?.length &&
                                                        "text-destructive",
                                                )}
                                            />
                                        </span>
                                        <div className="min-w-0 text-left">
                                            <p className="truncate text-sm font-semibold">
                                                {uploadedFile.name}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {(
                                                    uploadedFile.size / 1024
                                                ).toFixed(0)}
                                                KB
                                            </p>
                                        </div>
                                    </div>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        onClick={() => {
                                            setUploadedFile(null);
                                            form.setValue("csvData", null);
                                            form.setValue(
                                                "uploadedFileName",
                                                null,
                                            );
                                            setDataErrors(null);
                                        }}
                                        className={cn(
                                            "text-muted-foreground hover:text-foreground",
                                            dataErrors?.length &&
                                                "text-destructive hover:text-destructive/80",
                                        )}
                                    >
                                        <X className="size-4" />
                                        <span className="sr-only">
                                            {t("removeFile")}
                                        </span>
                                    </Button>
                                </div>
                            )}

                            {activeTab === "upload" &&
                                dataErrors &&
                                dataErrors.length > 0 && (
                                    <div className="max-h-48 space-y-1 overflow-y-auto overflow-x-hidden">
                                        {dataErrors.map((error) => (
                                            <div
                                                key={`${error.row}-${error.message}`}
                                                className="wrap-anywhere break-word text-sm text-destructive"
                                            >
                                                {error.message}
                                            </div>
                                        ))}
                                    </div>
                                )}
                        </div>
                    </TabsContent>

                    <TabsContent value="paste">
                        <div className="space-y-2 rounded-3xl border border-general-border bg-card">
                            <Textarea
                                value={pasteDataInput}
                                onChange={(event) => {
                                    form.setValue(
                                        "pasteDataInput",
                                        event.target.value,
                                    );
                                    if (dataErrors?.length) {
                                        setDataErrors(null);
                                    }
                                }}
                                borderless
                                placeholder={`alice.near, 100.00\nbob.near, 100.00\ncharlie.near, 100.00`}
                                rows={8}
                                className={cn(
                                    "min-h-[178px] w-full max-w-full resize-none overflow-x-hidden rounded-3xl bg-transparent! p-4 font-mono text-base whitespace-pre-wrap shadow-none hover:bg-transparent! focus-within:bg-transparent! focus:outline-none disabled:opacity-100 md:text-sm",
                                    dataErrors?.length &&
                                        "border-destructive! bg-destructive/5! focus:border-destructive! focus-visible:border-destructive! focus-within:border-destructive!",
                                )}
                                disabled={availableCredits === 0}
                            />

                            {dataErrors && dataErrors.length > 0 && (
                                <div className="max-h-48 space-y-1 overflow-y-auto overflow-x-hidden">
                                    {dataErrors.map((error) => (
                                        <div
                                            key={`${error.row}-${error.message}`}
                                            className="wrap-anywhere break-word text-sm text-destructive"
                                        >
                                            {error.message}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </TabsContent>
                </Tabs>

                {networkSlot && isValidElement(networkSlot)
                    ? cloneElement(
                          networkSlot as ReactElement<{
                              invalid?: boolean;
                              errorMessage?: string | null;
                          }>,
                          {
                              invalid: !!networkError,
                              errorMessage: networkError,
                          },
                      )
                    : networkSlot}

                <div className="flex items-start gap-3 rounded-[12px] border border-[#dbeafe] bg-general-info-background-faded p-3 text-general-info-foreground dark:border-general-info-border">
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-general-info-foreground">
                        <Info className="size-3 text-white" strokeWidth={3} />
                    </span>
                    <Checkbox
                        id="bulk-payment-exchange-risk"
                        checked={hasAcknowledgedExchangeRisk}
                        onCheckedChange={(checked) =>
                            setHasAcknowledgedExchangeRisk(checked === true)
                        }
                        className="mt-0.5 border-[#1447e6] data-[state=checked]:border-[#1447e6] data-[state=checked]:bg-[#1447e6] dark:border-general-info-foreground dark:data-[state=checked]:border-general-info-foreground dark:data-[state=checked]:bg-general-info-foreground"
                    />
                    <label
                        htmlFor="bulk-payment-exchange-risk"
                        className="cursor-pointer text-sm font-semibold leading-5"
                    >
                        {t("exchangeAddressWarning")}
                    </label>
                </div>

                <CreateRequestButton
                    type="button"
                    className="h-11 w-full rounded-2xl"
                    disabled={
                        !selectedToken ||
                        (activeTab === "upload" && !csvData) ||
                        (activeTab === "paste" && !pasteDataInput.trim()) ||
                        !hasAcknowledgedExchangeRisk ||
                        availableCredits === 0 ||
                        isReviewLoading ||
                        paymentsSlotBlocked
                    }
                    onClick={handleContinue}
                    isSubmitting={isReviewLoading}
                    permissions={[
                        { kind: "transfer", action: "AddProposal" },
                        { kind: "call", action: "AddProposal" },
                    ]}
                    idleMessage={
                        paymentsSlotBlocked
                            ? tCreate("brieflyUnavailable")
                            : availableCredits === 0
                              ? t("limitsUsed")
                              : !selectedToken ||
                                  (activeTab === "upload" && !csvData) ||
                                  (activeTab === "paste" &&
                                      !pasteDataInput.trim())
                                ? t("selectAndProvide")
                                : t("continueToReview")
                    }
                />
            </div>

            <aside className="mx-auto w-full max-w-[300px] shrink-0 rounded-3xl border border-general-border bg-general-tertiary lg:mx-0">
                <div className="px-4 pb-2 pt-4">
                    <p className="text-base font-semibold leading-[1.2]">
                        {t("requirements")}
                    </p>
                </div>
                <div className="flex flex-col gap-3 px-4 pb-4 pt-2">
                    <div className="flex items-center gap-2">
                        <ReceiptText className="size-4 shrink-0" />
                        <p className="text-sm font-medium leading-5">
                            {t("maxTransactions", {
                                max: MAX_RECIPIENTS_PER_BULK_PAYMENT,
                            })}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Bitcoin className="size-4 shrink-0" />
                        <p className="text-sm font-medium leading-5">
                            {t("singleTokenNetwork")}
                        </p>
                    </div>
                </div>
            </aside>
        </div>
    );
}
