"use client";

import { use, useEffect, useMemo, useRef } from "react";
import { redirect, useSearchParams } from "next/navigation";
import { FileText } from "lucide-react";
import QRCode from "react-qr-code";
import { useTranslations } from "next-intl";
import Logo from "@/components/icons/logo";
import { PageCard } from "@/components/card";
import { Button } from "@/components/button";
import { CopyButton } from "@/components/copy-button";
import { Pill } from "@/components/pill";
import { ConfidentialState } from "@/components/confidential-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
    useProposal,
    useProposalTransaction,
    useSwapStatus,
    useQuoteByDepositAddress,
    useTokenPriceAtTimestamp,
} from "@/hooks/use-proposals";
import { useCachedProposalSubmissionTime } from "@/hooks/use-cached-proposal-submission-time";
import { useTreasury } from "@/hooks/use-treasury";
import {
    useBatchPayment,
    useToken,
    useTreasuryPolicy,
} from "@/hooks/use-treasury-queries";
import {
    getProposalStatus,
    getProposalUIKind,
} from "@/features/proposals/utils/proposal-utils";
import { extractProposalData } from "@/features/proposals/utils/proposal-extractors";
import {
    extractReceiptProposalData,
    getProposalExecutedDate,
    isReceiptEligibleProposalKind,
} from "@/features/proposals/utils/receipt-utils";
import { NetworkIconDisplay } from "@/components/token-display";
import {
    isNearComPaymentRoute,
    getNearComChainIcons,
} from "@/lib/intents-network";
import { NEAR_COM_NETWORK_ID } from "@/constants/network-ids";
import { StatusPill } from "@/features/proposals/components/proposal-status-pill";
import {
    ReceiptSenderSection,
    ReceiptTokenAmountRow,
} from "./components/receipt-shared";
import { getTokenDisplayFields } from "./utils/token-display";
import {
    buildReceiptAmountModel,
    buildTokenReceiptInfo,
    type AsyncValue,
    type TokenReceiptInfo,
} from "./utils/receipt-models";
import {
    formatBalance,
    formatTokenDisplayAmount,
    formatUserDate,
    cn,
} from "@/lib/utils";
import {
    recordReceiptMetric,
    type SwapQuoteResponse,
} from "@/lib/proposals-api";
import type { BatchPaymentRequestData } from "@/features/proposals/types/index";
import { LANDING_PAGE } from "@/constants/config";

interface RequestReceiptPageProps {
    params: Promise<{
        id: string;
    }>;
}

interface ReceiptPageShellProps {
    receiptUrl: string;
    showCopyLink: boolean;
    onPrint: () => void;
    children: React.ReactNode;
}

interface ReceiptLayoutProps {
    title: string;
    proposalId: string | number;
    receiptDate: AsyncValue<Date>;
    children: React.ReactNode;
}

interface PaymentReceiptSectionsProps {
    recipientAddress: AsyncValue<string>;
    sourceToken: TokenReceiptInfo;
    destinationToken: TokenReceiptInfo;
    rate: AsyncValue<string>;
    executedTime: AsyncValue<string>;
}

interface ExchangeReceiptSectionsProps {
    sourceToken: TokenReceiptInfo;
    destinationToken: TokenReceiptInfo;
    rate: AsyncValue<string>;
    executedTime: AsyncValue<string>;
}

interface ReceiptSectionTitleProps {
    children: React.ReactNode;
}

function ReceiptSectionTitle({ children }: ReceiptSectionTitleProps) {
    return <p className="text-base font-semibold">{children}</p>;
}

interface ReceiptLabelValueRowProps {
    label: React.ReactNode;
    value: React.ReactNode;
    className?: string;
    labelClassName?: string;
    valueClassName?: string;
}

function ReceiptLabelValueRow({
    label,
    value,
    className = "",
    labelClassName = "",
    valueClassName = "",
}: ReceiptLabelValueRowProps) {
    return (
        <div className={cn("flex items-start gap-6 text-sm", className)}>
            <p
                className={cn(
                    "w-60 shrink-0 text-muted-foreground text-sm",
                    labelClassName,
                )}
            >
                {label}
            </p>
            <div className={cn("flex-1 text-left font-medium", valueClassName)}>
                {value}
            </div>
        </div>
    );
}

function ReceiptValueSkeleton({ width = "w-24" }: { width?: string }) {
    return <Skeleton className={cn("h-5", width)} />;
}

function AsyncText({ value }: { value: AsyncValue<string> }) {
    const tCommon = useTranslations("common");

    if (value.isLoading || value.value == null) {
        if (!value.isLoading) {
            return tCommon("notAvailable");
        }
        return <ReceiptValueSkeleton width="w-24" />;
    }

    return value.value;
}

function AsyncNetwork({
    metadata,
    width = "w-20",
}: {
    metadata: TokenReceiptInfo["metadata"];
    width?: string;
}) {
    const networkName = metadata.value?.network?.name;
    if (metadata.isLoading || !networkName) {
        return <ReceiptValueSkeleton width={width} />;
    }

    const networkChainIcons = metadata.value?.network?.chainIcons ?? null;
    return (
        <div className="flex justify-start">
            <NetworkIconDisplay
                chainIcons={
                    networkChainIcons?.icon
                        ? { icon: networkChainIcons.icon }
                        : null
                }
                networkName={networkName}
                networkNameClassName="font-medium"
                expandNearComLabel
                className="gap-2"
            />
        </div>
    );
}

function ReceiptPageShell({
    receiptUrl,
    showCopyLink,
    onPrint,
    children,
}: ReceiptPageShellProps) {
    const tReceipt = useTranslations("receiptPage");

    return (
        <div className="min-h-dvh bg-background print-color-exact print:bg-white">
            <header className="flex min-h-14 items-center justify-between border-b border-border bg-card px-4 md:px-6 print:hidden">
                <div className="flex items-center gap-3">
                    <Logo size="sm" />
                    <Pill
                        title={tReceipt("transactionConfirmation")}
                        variant="secondary"
                    />
                </div>
                <div className="flex items-center gap-2 print:hidden">
                    {showCopyLink && (
                        <CopyButton
                            text={receiptUrl}
                            variant="secondary"
                            iconClassName="size-4"
                        >
                            {tReceipt("copyLink")}
                        </CopyButton>
                    )}
                    <Button variant="default" onClick={onPrint}>
                        <FileText className="size-4" />
                        {tReceipt("printOrSavePdf")}
                    </Button>
                </div>
            </header>

            <main className="px-4 py-4 pb-8 print:bg-white print:px-0 print:py-0">
                <div className="mx-auto w-full max-w-[700px]">{children}</div>
            </main>
        </div>
    );
}

function ReceiptLayout({
    title,
    proposalId,
    receiptDate,
    children,
}: ReceiptLayoutProps) {
    const tReceipt = useTranslations("receiptPage");
    const tCommon = useTranslations("common");

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between border-b pb-4">
                <div>
                    <p className="text-xl font-medium">{title}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {tReceipt("generatedOn", {
                            date: formatUserDate(new Date(), {
                                timezone: "UTC",
                                includeTime: false,
                            }),
                        })}
                    </p>
                </div>
                <Logo size="md" mode="light" />
            </div>
            <p className="text-xl font-medium">
                {tReceipt.rich("receiptTitle", {
                    proposalId,
                    date: receiptDate.value
                        ? formatUserDate(receiptDate.value, {
                              timezone: "UTC",
                              includeTime: false,
                          })
                        : tCommon("notAvailable"),
                    datePart: (chunks) =>
                        receiptDate.isLoading ? (
                            <span className="inline-block align-middle">
                                <ReceiptValueSkeleton width="w-32" />
                            </span>
                        ) : (
                            chunks
                        ),
                })}
            </p>
            {children}
            <div className="flex items-center justify-between rounded-lg bg-secondary px-4 py-3">
                <div className="space-y-2">
                    <span className="inline-flex rounded-md bg-foreground px-3 py-1 text-xs font-medium text-background">
                        Free to start
                    </span>
                    <div>
                        <p className="text-base font-medium">
                            {tReceipt("createYourTreasury")}
                        </p>
                        <p className="text-sm text-muted-foreground">
                            {tReceipt("createYourTreasuryDescription")}
                        </p>
                    </div>
                </div>
                <div className="flex flex-col items-center gap-2">
                    <a
                        href={LANDING_PAGE}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="Open Trezu landing page"
                    >
                        <QRCode size={66} value={LANDING_PAGE} />
                    </a>
                    <a
                        href={LANDING_PAGE}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[16px] font-medium underline"
                    >
                        trezu.org
                    </a>
                </div>
            </div>
        </div>
    );
}

function ReceiptPdfSkeletonLabelRow({
    className = "py-3",
    valueWidth = "w-36",
}: {
    className?: string;
    valueWidth?: string;
}) {
    return (
        <ReceiptLabelValueRow
            label={<Skeleton className="h-4 w-24" />}
            value={<Skeleton className={cn("h-4", valueWidth)} />}
            className={className}
        />
    );
}

function ReceiptPdfSkeletonCard() {
    return (
        <PageCard className="force-light-theme bg-white text-foreground p-8 rounded-none print:bg-white print:shadow-none">
            <div className="space-y-8">
                <div className="flex items-start justify-between border-b pb-4">
                    <div className="space-y-2">
                        <Skeleton className="h-7 w-64" />
                        <Skeleton className="h-4 w-40" />
                    </div>
                    <Skeleton className="h-8 w-24" />
                </div>

                <Skeleton className="h-7 w-80" />

                <section className="space-y-5">
                    <div>
                        <Skeleton className="h-6 w-20" />
                        <ReceiptLabelValueRow
                            label={<Skeleton className="h-4 w-16" />}
                            value={<Skeleton className="h-4 w-64" />}
                            className="mt-2 border-b pb-3 pt-3"
                            valueClassName="break-all"
                        />
                    </div>
                </section>

                <section className="space-y-3">
                    <Skeleton className="h-6 w-40" />
                    <div className="divide-y text-sm">
                        <ReceiptPdfSkeletonLabelRow valueWidth="w-20" />
                        <ReceiptPdfSkeletonLabelRow valueWidth="w-28" />
                        <ReceiptPdfSkeletonLabelRow valueWidth="w-32" />
                        <ReceiptPdfSkeletonLabelRow valueWidth="w-24" />
                        <ReceiptPdfSkeletonLabelRow valueWidth="w-48" />
                        <ReceiptPdfSkeletonLabelRow valueWidth="w-36" />
                    </div>
                </section>

                <div className="flex items-center justify-between rounded-lg bg-secondary px-4 py-3">
                    <div className="space-y-2">
                        <Skeleton className="h-6 w-24 rounded-md" />
                        <Skeleton className="h-5 w-44" />
                        <Skeleton className="h-4 w-72" />
                    </div>
                    <div className="space-y-2">
                        <Skeleton className="size-[66px]" />
                        <Skeleton className="h-4 w-20" />
                    </div>
                </div>
            </div>
        </PageCard>
    );
}

function PaymentReceiptSections({
    recipientAddress,
    sourceToken,
    destinationToken,
    rate,
    executedTime,
}: PaymentReceiptSectionsProps) {
    const tReceipt = useTranslations("receiptPage");
    const tCommon = useTranslations("common");
    const { treasuryId } = useTreasury();
    const { symbol: amountSymbol } = getTokenDisplayFields(
        sourceToken.metadata,
    );

    return (
        <>
            <ReceiptSenderSection senderAddress={treasuryId ?? ""} />
            <section className="space-y-5">
                <div>
                    <p className="text-base font-medium">
                        {tReceipt("recipient")}
                    </p>
                    <ReceiptLabelValueRow
                        label={tReceipt("address")}
                        value={
                            recipientAddress.isLoading ? (
                                <ReceiptValueSkeleton width="w-28" />
                            ) : (
                                (recipientAddress.value ??
                                tCommon("notAvailable"))
                            )
                        }
                        className="mt-2 pt-3"
                        valueClassName="break-all"
                    />
                    <ReceiptLabelValueRow
                        label={tReceipt("destinationNetwork")}
                        value={
                            <AsyncNetwork
                                metadata={destinationToken.metadata}
                                width="w-28"
                            />
                        }
                        className="mt-2 border-b border-t pb-3 pt-3"
                        valueClassName="break-all"
                    />
                </div>
            </section>

            <section>
                <ReceiptSectionTitle>
                    {tReceipt("transactionDetails")}
                </ReceiptSectionTitle>
                <div className="divide-y text-sm">
                    <ReceiptLabelValueRow
                        label={tReceipt("status")}
                        value={<StatusPill status="Executed" />}
                        className="py-3"
                    />
                    <ReceiptLabelValueRow
                        label={tReceipt("network")}
                        value={
                            <AsyncNetwork
                                metadata={sourceToken.metadata}
                                width="w-20"
                            />
                        }
                        className="py-3"
                    />
                    <ReceiptTokenAmountRow
                        label={tReceipt("amountWithToken", {
                            token: amountSymbol,
                        })}
                        metadata={sourceToken.metadata}
                        amount={sourceToken.amount}
                    />
                    <ReceiptLabelValueRow
                        label={tReceipt("amountUsd")}
                        value={<AsyncText value={sourceToken.usd} />}
                        className="py-3"
                    />
                    <ReceiptLabelValueRow
                        label={tReceipt("rate")}
                        value={<AsyncText value={rate} />}
                        className="py-3"
                    />
                    <ReceiptLabelValueRow
                        label={tReceipt("dateAndTime")}
                        value={<AsyncText value={executedTime} />}
                        className="py-3"
                    />
                </div>
            </section>
        </>
    );
}

function ExchangeReceiptSections({
    sourceToken,
    destinationToken,
    rate,
    executedTime,
}: ExchangeReceiptSectionsProps) {
    const tReceipt = useTranslations("receiptPage");
    const { treasuryId } = useTreasury();
    const { symbol: sentSymbol } = getTokenDisplayFields(sourceToken.metadata);
    const { symbol: receiveSymbol } = getTokenDisplayFields(
        destinationToken.metadata,
    );

    return (
        <>
            <ReceiptSenderSection senderAddress={treasuryId ?? ""} />

            <section>
                <ReceiptSectionTitle>
                    {tReceipt("transactionDetails")}
                </ReceiptSectionTitle>
                <div className="divide-y text-sm">
                    <ReceiptLabelValueRow
                        label={tReceipt("status")}
                        value={<StatusPill status="Executed" />}
                        className="py-3"
                    />
                    <ReceiptTokenAmountRow
                        label={tReceipt("sentAmountWithToken", {
                            token: sentSymbol,
                        })}
                        metadata={sourceToken.metadata}
                        amount={sourceToken.amount}
                    />
                    <ReceiptLabelValueRow
                        label={tReceipt("sentNetwork")}
                        value={
                            <AsyncNetwork
                                metadata={sourceToken.metadata}
                                width="w-20"
                            />
                        }
                        className="py-3"
                    />
                    <ReceiptTokenAmountRow
                        label={tReceipt("receiveAmountWithToken", {
                            token: receiveSymbol,
                        })}
                        metadata={destinationToken.metadata}
                        amount={destinationToken.amount}
                    />
                    <ReceiptLabelValueRow
                        label={tReceipt("receiveNetwork")}
                        value={
                            <AsyncNetwork
                                metadata={destinationToken.metadata}
                                width="w-28"
                            />
                        }
                        className="py-3"
                    />
                    <ReceiptLabelValueRow
                        label={tReceipt("receiveAmountUsd")}
                        value={<AsyncText value={destinationToken.usd} />}
                        className="py-3"
                    />
                    <ReceiptLabelValueRow
                        label={tReceipt("rate")}
                        value={<AsyncText value={rate} />}
                        className="py-3"
                    />
                    <ReceiptLabelValueRow
                        label={tReceipt("dateAndTime")}
                        value={<AsyncText value={executedTime} />}
                        className="py-3"
                    />
                </div>
            </section>
        </>
    );
}

interface BatchReceiptCardProps {
    batchPayment: { recipient: string; amount: string };
    paymentIndex: number;
    totalPayments: number;
    tokenData: ReturnType<typeof useToken>["data"];
    batchId: string;
    sourceHistoricalPriceUsd: number | null;
    transactionDate: Date | null;
    isTransactionDateLoading: boolean;
    proposalId: string | number;
}

function BatchReceiptCard({
    batchPayment,
    paymentIndex,
    totalPayments,
    tokenData,
    batchId,
    sourceHistoricalPriceUsd,
    transactionDate,
    isTransactionDateLoading,
    proposalId,
}: BatchReceiptCardProps) {
    const tReceipt = useTranslations("receiptPage");
    const executedTimeDisplay = transactionDate
        ? formatUserDate(transactionDate, {
              timezone: "UTC",
              includeTime: true,
              includeTimezone: true,
              timeFormat: "12",
          })
        : null;
    const sourceAmountDecimal = formatBalance(
        batchPayment.amount,
        tokenData?.decimals ?? 24,
    );
    const sourceAmountDisplayInput =
        formatTokenDisplayAmount(sourceAmountDecimal);
    const { sourceAmountDisplay, sourceAmountUsd, rateLabel } =
        buildReceiptAmountModel({
            isExchangeReceipt: false,
            hasDepositAddress: false,
            quote: null,
            sourceToken: {
                amountDecimal: sourceAmountDecimal,
                amountDisplay: sourceAmountDisplayInput,
                symbol: tokenData?.symbol ?? "",
                tokenPrice: tokenData?.price ?? null,
                historicalPriceUsd: sourceHistoricalPriceUsd,
            },
            destinationToken: {
                amountDecimal: sourceAmountDecimal,
                symbol: tokenData?.symbol ?? "",
                tokenPrice: tokenData?.price ?? null,
                historicalPriceUsd: sourceHistoricalPriceUsd,
            },
        });

    const batchTokenInfo = buildTokenReceiptInfo({
        token: {
            ...tokenData,
            tokenId: batchId,
            network: tokenData?.network || "NEAR",
            chainIcons: tokenData?.chainIcons,
        },
        amount: sourceAmountDisplay,
        usdValue: sourceAmountUsd,
    });

    return (
        <PageCard
            className={cn(
                "force-light-theme rounded-none bg-white text-foreground p-8 print:bg-white print:shadow-none",
                paymentIndex < totalPayments - 1 && "break-after-page",
            )}
        >
            <ReceiptLayout
                title={tReceipt("paymentConfirmation")}
                proposalId={proposalId}
                receiptDate={{
                    value: transactionDate,
                    isLoading: isTransactionDateLoading,
                }}
            >
                <PaymentReceiptSections
                    recipientAddress={{
                        value: batchPayment.recipient,
                        isLoading: false,
                    }}
                    sourceToken={batchTokenInfo}
                    destinationToken={batchTokenInfo}
                    rate={{
                        value: rateLabel,
                        isLoading: false,
                    }}
                    executedTime={{
                        value: executedTimeDisplay,
                        isLoading: isTransactionDateLoading,
                    }}
                />
            </ReceiptLayout>
        </PageCard>
    );
}

export default function RequestReceiptPage({
    params,
}: RequestReceiptPageProps) {
    const tReceipt = useTranslations("receiptPage");
    const hasRecordedGeneratedRef = useRef(false);
    const { id } = use(params);
    const searchParams = useSearchParams();
    const recipientFilter = searchParams.get("recipient");
    const { treasuryId, isConfidential, isGuestTreasury } = useTreasury();
    const isHidden = isConfidential && isGuestTreasury;
    const receiptUrl =
        typeof window !== "undefined" ? window.location.href : "";

    const cachedSubmissionTime = useCachedProposalSubmissionTime(
        treasuryId,
        id,
    );

    const { data: proposal, isLoading: isLoadingProposal } = useProposal(
        treasuryId,
        id,
    );
    const proposalId = proposal?.id ?? id;
    useEffect(() => {
        if (typeof document === "undefined") return;
        const previousTitle = document.title;
        document.title = `Receipt-${proposalId}`;
        return () => {
            document.title = previousTitle;
        };
    }, [proposalId]);
    const proposalUiKind = proposal ? getProposalUIKind(proposal) : undefined;
    const isBatchPaymentProposal = proposalUiKind === "Batch Payment Request";
    const isConfidentialRequestProposal =
        proposalUiKind === "Confidential Request";
    const isReceiptEligibleProposal =
        isReceiptEligibleProposalKind(proposalUiKind);
    const isSingleReceiptProposal = !isBatchPaymentProposal;
    const submissionTime = proposal?.submission_time ?? cachedSubmissionTime;
    const canLoadPolicy =
        !!treasuryId && !!submissionTime && isReceiptEligibleProposal;
    const { data: policy, isLoading: isLoadingPolicy } = useTreasuryPolicy(
        canLoadPolicy ? treasuryId : null,
        submissionTime,
    );

    const status =
        proposal && policy ? getProposalStatus(proposal, policy) : undefined;

    const receiptProposalData =
        proposal && isSingleReceiptProposal && isReceiptEligibleProposal
            ? extractReceiptProposalData(proposal, treasuryId)
            : null;
    const batchReceiptData: BatchPaymentRequestData | null =
        proposal && isBatchPaymentProposal
            ? ((extractProposalData(proposal, treasuryId)
                  .data as BatchPaymentRequestData) ?? null)
            : null;
    const receiptProposalVariant = receiptProposalData?.variant ?? "payment";
    const sourceTokenId = receiptProposalData?.sourceTokenId;
    const destinationTokenId = receiptProposalData?.destinationTokenId;
    const depositAddress = receiptProposalData?.depositAddress;
    const receiverAddress = receiptProposalData?.receiverAddress;
    const sourceAmountRaw = receiptProposalData?.sourceAmountRaw;
    const destinationAmountWithDecimals =
        receiptProposalData?.destinationAmountWithDecimals;
    const isExecutableReceipt = status === "Executed";
    const shouldUseSwapExecutionDate =
        isExecutableReceipt &&
        !!depositAddress &&
        !isConfidentialRequestProposal;

    const { data: transaction, isLoading: isLoadingTransaction } =
        useProposalTransaction(
            treasuryId,
            proposal,
            policy,
            !isHidden && !!proposal && !!policy,
        );
    const { data: swapStatus, isLoading: isLoadingSwapStatus } = useSwapStatus(
        depositAddress,
        undefined,
        shouldUseSwapExecutionDate,
        treasuryId,
    );
    const transactionDate = getProposalExecutedDate(swapStatus, transaction);
    const isExchangeProposal = receiptProposalVariant === "exchange";
    const hasDepositAddress = !!depositAddress;
    const isNearComDestination = isNearComPaymentRoute({
        destinationAssetId: destinationTokenId,
        depositAddress,
    });
    const executedAtIso =
        transactionDate && !Number.isNaN(transactionDate.getTime())
            ? transactionDate.toISOString()
            : null;
    const shouldLoadHistoricalPrices =
        isSingleReceiptProposal && !hasDepositAddress && !!executedAtIso;
    const shouldFetchQuoteByDepositAddress =
        isSingleReceiptProposal &&
        !!depositAddress &&
        !isConfidentialRequestProposal;
    const {
        data: quoteByDepositAddress,
        isLoading: isLoadingQuoteByDepositAddress,
    } = useQuoteByDepositAddress(
        depositAddress,
        undefined,
        shouldFetchQuoteByDepositAddress,
    );
    const confidentialQuote = useMemo<SwapQuoteResponse | null>(() => {
        if (!isConfidentialRequestProposal) {
            return null;
        }

        const quote =
            proposal?.confidential_metadata?.quote_metadata?.quote ?? null;
        if (!quote) {
            return null;
        }

        return {
            amountInFormatted: quote.amountInFormatted ?? null,
            amountOutFormatted: quote.amountOutFormatted ?? null,
            amountInUsd: quote.amountInUsd ?? null,
            amountOutUsd: quote.amountOutUsd ?? null,
        };
    }, [isConfidentialRequestProposal, proposal?.confidential_metadata]);
    const effectiveQuote = isConfidentialRequestProposal
        ? confidentialQuote
        : quoteByDepositAddress;
    const {
        data: sourceHistoricalPrice,
        isLoading: isLoadingSourceHistoricalPrice,
    } = useTokenPriceAtTimestamp(
        sourceTokenId,
        executedAtIso,
        shouldLoadHistoricalPrices && !!sourceTokenId,
    );
    const {
        data: destinationHistoricalPrice,
        isLoading: isLoadingDestinationHistoricalPrice,
    } = useTokenPriceAtTimestamp(
        destinationTokenId,
        executedAtIso,
        shouldLoadHistoricalPrices &&
            isExchangeProposal &&
            !!destinationTokenId,
    );

    const { data: sourceToken } = useToken(
        isSingleReceiptProposal ? sourceTokenId : null,
    );
    const { data: destinationToken } = useToken(
        isSingleReceiptProposal ? destinationTokenId : null,
    );
    const { data: batchPaymentData, isLoading: isLoadingBatchPayment } =
        useBatchPayment(batchReceiptData?.batchId || null);
    const effectiveBatchTokenId =
        batchPaymentData?.tokenId?.toLowerCase() === "native"
            ? "near"
            : (batchReceiptData?.tokenId ??
              batchPaymentData?.tokenId ??
              "near");
    const { data: batchTokenData } = useToken(
        !isHidden ? effectiveBatchTokenId : null,
    );
    const { data: batchHistoricalPrice } = useTokenPriceAtTimestamp(
        effectiveBatchTokenId,
        executedAtIso,
        isBatchPaymentProposal &&
            isExecutableReceipt &&
            !!effectiveBatchTokenId &&
            !!executedAtIso,
    );
    const sourceAmountDecimal =
        isSingleReceiptProposal && sourceAmountRaw
            ? formatBalance(sourceAmountRaw, sourceToken?.decimals ?? 24)
            : "0";
    const isValidReceipt =
        !!proposal &&
        isReceiptEligibleProposal &&
        (!isSingleReceiptProposal || receiptProposalData !== null) &&
        !!policy &&
        isExecutableReceipt &&
        !(isBatchPaymentProposal && isConfidential);
    const batchPayments = batchPaymentData?.payments ?? [];
    const paymentsToRender = useMemo(
        () =>
            recipientFilter
                ? batchPayments.filter(
                      (payment) => payment.recipient === recipientFilter,
                  )
                : batchPayments,
        [batchPayments, recipientFilter],
    );

    useEffect(() => {
        if (
            hasRecordedGeneratedRef.current ||
            !treasuryId ||
            isHidden ||
            !isExecutableReceipt
        ) {
            return;
        }

        hasRecordedGeneratedRef.current = true;
        recordReceiptMetric(treasuryId, "generated");
    }, [treasuryId, isHidden, isExecutableReceipt]);
    const {
        sourceAmountDisplay,
        destinationAmountDisplay,
        sourceAmountUsd,
        destinationAmountUsd,
        rateLabel,
    } = useMemo(
        () =>
            buildReceiptAmountModel({
                isExchangeReceipt: isExchangeProposal,
                hasDepositAddress,
                quote: isSingleReceiptProposal ? effectiveQuote : null,
                sourceToken: {
                    amountDecimal: sourceAmountDecimal,
                    amountDisplay:
                        formatTokenDisplayAmount(sourceAmountDecimal),
                    symbol: sourceToken?.symbol ?? "",
                    tokenPrice: sourceToken?.price ?? null,
                    historicalPriceUsd: sourceHistoricalPrice?.priceUsd ?? null,
                },
                destinationToken: {
                    amountDecimal: destinationAmountWithDecimals,
                    symbol: destinationToken?.symbol ?? "",
                    tokenPrice: destinationToken?.price ?? null,
                    historicalPriceUsd:
                        destinationHistoricalPrice?.priceUsd ?? null,
                },
            }),
        [
            isExchangeProposal,
            effectiveQuote,
            sourceAmountDecimal,
            destinationAmountWithDecimals,
            hasDepositAddress,
            sourceHistoricalPrice?.priceUsd,
            destinationHistoricalPrice?.priceUsd,
            sourceToken?.price,
            destinationToken?.price,
            sourceToken?.symbol,
            destinationToken?.symbol,
        ],
    );
    const isTransactionDateLoading =
        isExecutableReceipt &&
        isSingleReceiptProposal &&
        (shouldUseSwapExecutionDate
            ? isLoadingSwapStatus
            : isLoadingTransaction);
    const isRateLoading = hasDepositAddress
        ? isSingleReceiptProposal &&
          !isConfidentialRequestProposal &&
          isLoadingQuoteByDepositAddress
        : isLoadingSourceHistoricalPrice ||
          (isExchangeProposal && isLoadingDestinationHistoricalPrice);
    const executedTimeValue = transactionDate
        ? formatUserDate(transactionDate, {
              timezone: "UTC",
              includeTime: true,
              includeTimezone: true,
              timeFormat: "12",
          })
        : null;
    const sourceTokenInfo = useMemo(
        () =>
            buildTokenReceiptInfo({
                token: sourceToken
                    ? {
                          ...sourceToken,
                          tokenId: sourceTokenId ?? sourceToken.tokenId,
                      }
                    : null,
                amount: sourceAmountDisplay,
                usdValue: sourceAmountUsd,
                usdLoading: isRateLoading,
            }),
        [
            sourceTokenId,
            sourceToken,
            sourceAmountDisplay,
            sourceAmountUsd,
            isRateLoading,
        ],
    );
    const destinationTokenInfo = useMemo(
        () =>
            buildTokenReceiptInfo({
                token: {
                    ...destinationToken,
                    tokenId: destinationTokenId ?? destinationToken?.tokenId,
                    network: isNearComDestination
                        ? NEAR_COM_NETWORK_ID
                        : (destinationToken?.network ??
                          sourceToken?.network ??
                          destinationTokenId),
                    chainIcons: isNearComDestination
                        ? getNearComChainIcons()
                        : (destinationToken?.chainIcons ??
                          sourceToken?.chainIcons),
                },
                amount: destinationAmountDisplay,
                usdValue: destinationAmountUsd,
                usdLoading: isRateLoading,
            }),
        [
            destinationTokenId,
            destinationToken,
            sourceToken?.network,
            sourceToken?.chainIcons,
            destinationAmountDisplay,
            destinationAmountUsd,
            isNearComDestination,
            isRateLoading,
        ],
    );

    if (isLoadingProposal || (canLoadPolicy && isLoadingPolicy)) {
        return (
            <div className="min-h-dvh bg-muted p-4 print:bg-white">
                <div className="mx-auto w-full max-w-[700px]">
                    <ReceiptPdfSkeletonCard />
                </div>
            </div>
        );
    }

    const handlePrint = () => {
        if (treasuryId && !isHidden) {
            recordReceiptMetric(treasuryId, "print");
        }
        window.print();
    };

    if (isHidden) {
        return (
            <ReceiptPageShell
                receiptUrl={receiptUrl}
                showCopyLink={false}
                onPrint={handlePrint}
            >
                <PageCard className="bg-card p-8 rounded-none">
                    <ConfidentialState
                        skeleton={
                            <div className="space-y-3">
                                <Skeleton className="h-16 w-full" />
                                <Skeleton className="h-16 w-full" />
                                <Skeleton className="h-16 w-full" />
                            </div>
                        }
                    />
                </PageCard>
            </ReceiptPageShell>
        );
    }

    if (!isValidReceipt) {
        redirect(`/${treasuryId}/requests`);
    }

    if (isBatchPaymentProposal) {
        return (
            <ReceiptPageShell
                receiptUrl={receiptUrl}
                showCopyLink={!isConfidential}
                onPrint={handlePrint}
            >
                <div className="space-y-4">
                    {isLoadingBatchPayment ? (
                        <ReceiptPdfSkeletonCard />
                    ) : (
                        paymentsToRender.map((payment, index) => (
                            <BatchReceiptCard
                                key={`${batchReceiptData?.batchId ?? "batch"}-${index}`}
                                batchPayment={payment}
                                paymentIndex={index}
                                totalPayments={paymentsToRender.length}
                                tokenData={batchTokenData}
                                batchId={effectiveBatchTokenId}
                                sourceHistoricalPriceUsd={
                                    batchHistoricalPrice?.priceUsd ?? null
                                }
                                transactionDate={transactionDate}
                                isTransactionDateLoading={
                                    isTransactionDateLoading
                                }
                                proposalId={proposalId}
                            />
                        ))
                    )}
                </div>
            </ReceiptPageShell>
        );
    }

    return (
        <ReceiptPageShell
            receiptUrl={receiptUrl}
            showCopyLink={!isConfidential}
            onPrint={handlePrint}
        >
            <PageCard className="force-light-theme bg-white text-foreground p-8 rounded-none print:bg-white print:shadow-none">
                <ReceiptLayout
                    title={
                        isExchangeProposal
                            ? tReceipt("exchangeConfirmation")
                            : tReceipt("paymentConfirmation")
                    }
                    proposalId={proposalId}
                    receiptDate={{
                        value: transactionDate,
                        isLoading: isTransactionDateLoading,
                    }}
                >
                    {isExchangeProposal ? (
                        <ExchangeReceiptSections
                            sourceToken={sourceTokenInfo}
                            destinationToken={destinationTokenInfo}
                            rate={{
                                value: rateLabel,
                                isLoading: isRateLoading,
                            }}
                            executedTime={{
                                value: executedTimeValue,
                                isLoading: isTransactionDateLoading,
                            }}
                        />
                    ) : (
                        <PaymentReceiptSections
                            recipientAddress={{
                                value: receiverAddress ?? null,
                                isLoading: false,
                            }}
                            sourceToken={sourceTokenInfo}
                            destinationToken={destinationTokenInfo}
                            rate={{
                                value: rateLabel,
                                isLoading: isRateLoading,
                            }}
                            executedTime={{
                                value: executedTimeValue,
                                isLoading: isTransactionDateLoading,
                            }}
                        />
                    )}
                </ReceiptLayout>
            </PageCard>
        </ReceiptPageShell>
    );
}
