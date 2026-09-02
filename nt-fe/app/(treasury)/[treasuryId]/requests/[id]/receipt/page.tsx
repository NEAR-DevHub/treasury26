"use client";
import { File01Icon } from "@hugeicons/core-free-icons";
import { redirect, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useEffect, useMemo, useRef } from "react";
import QRCode from "react-qr-code";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { CopyButton } from "@/components/copy-button";
import { Icon } from "@/components/icon";
import { NearBusinessLogo } from "@/components/icons/near-business-logo";
import { Pill } from "@/components/pill";
import { NetworkIconDisplay } from "@/components/token-display";
import { Skeleton } from "@/components/ui/skeleton";
import { LANDING_PAGE } from "@/constants/config";
import { NEAR_COM_NETWORK_ID } from "@/constants/network-ids";
import { StatusPill } from "@/features/proposals/components/proposal-status-pill";
import type { BatchPaymentRequestData } from "@/features/proposals/types/index";
import { extractProposalData } from "@/features/proposals/utils/proposal-extractors";
import {
    getProposalStatus,
    getProposalUIKind,
} from "@/features/proposals/utils/proposal-utils";
import {
    extractConfidentialBulkReceiptData,
    extractReceiptProposalData,
    isReceiptEligibleProposalKind,
    resolveExecutionTimestamp,
} from "@/features/proposals/utils/receipt-utils";
import { useCachedProposalSubmissionTime } from "@/hooks/use-cached-proposal-submission-time";
import {
    useProposal,
    useProposalTransaction,
    useQuoteByDepositAddress,
    useSwapStatus,
    useTokenPriceAtTimestamp,
} from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";
import {
    useBatchPayment,
    useToken,
    useTreasuryPolicy,
} from "@/hooks/use-treasury-queries";
import {
    decimalFromBaseUnitsOrNull,
    formatTokenQuantity,
} from "@/lib/amount-format";
import {
    getNearComChainIcons,
    isNearComNetwork,
    isNearComPaymentRoute,
} from "@/lib/intents-network";
import { formatRecipientForNearComDestination } from "@/lib/nearcom-address";
import {
    recordReceiptMetric,
    type SwapQuoteResponse,
} from "@/lib/proposals-api";
import { cn, formatUserDate } from "@/lib/utils";
import {
    ReceiptLabelValueRow,
    ReceiptSection,
    ReceiptSenderSection,
    ReceiptTokenAmountRow,
    receiptSectionRows,
} from "./components/receipt-shared";
import {
    type AsyncValue,
    buildReceiptAmountModel,
    buildTokenReceiptInfo,
    type TokenReceiptInfo,
} from "./utils/receipt-models";
import { getTokenDisplayFields } from "./utils/token-display";

/** The printed sheet: a flat white page on the tinted app background. */
const RECEIPT_CARD_CLASS =
    "force-light-theme gap-8 rounded-none border-0 bg-white p-6 text-foreground print:bg-white print:shadow-none";

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

    return (
        <div className="flex justify-start">
            <NetworkIconDisplay
                chainIcons={metadata.value?.network?.chainIcons ?? null}
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
        <div className="flex min-h-dvh flex-col gap-8 pb-20 print-color-exact print:block print:gap-0 print:pb-0">
            <header className="sticky top-0 z-10 flex items-center justify-between px-5 py-3 backdrop-blur-[2px] print:hidden">
                <div className="flex items-center gap-3">
                    <NearBusinessLogo className="h-6" />
                    <Pill
                        title={tReceipt("transactionConfirmation")}
                        variant="primary"
                        className="rounded-sm font-semibold"
                    />
                </div>
                <div className="flex items-center gap-2 print:hidden">
                    {showCopyLink && (
                        <CopyButton
                            text={receiptUrl}
                            variant="secondary"
                            size="sm"
                            iconClassName="size-4"
                        >
                            {tReceipt("copyLink")}
                        </CopyButton>
                    )}
                    <Button variant="default" size="sm" onClick={onPrint}>
                        <Icon icon={File01Icon} />
                        {tReceipt("printOrSavePdf")}
                    </Button>
                </div>
            </header>

            <main className="px-4 print:bg-white print:px-0">
                <div className="mx-auto w-full max-w-[595px]">{children}</div>
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
        <div className="flex flex-col gap-8">
            <div className="flex items-start gap-1 border-b border-border pb-4">
                <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
                    <p className="text-xl font-semibold leading-[1.2] tracking-[-0.4px]">
                        {title}
                    </p>
                    <p className="text-sm font-medium leading-[1.5] text-muted-foreground">
                        {tReceipt("generatedOn", {
                            date: formatUserDate(new Date(), {
                                timezone: "UTC",
                                includeTime: false,
                            }),
                        })}
                    </p>
                </div>
                <NearBusinessLogo className="h-6" />
            </div>
            <div className="flex flex-col gap-5 pb-6">
                <p className="pb-3 text-xl font-semibold leading-[1.2] tracking-[-0.4px]">
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
            </div>
            <div className="flex items-center gap-10 rounded-xl border border-border bg-general-bg-secondary p-3">
                <div className="flex min-w-0 flex-1 flex-col justify-center gap-3">
                    <span className="flex min-h-6 w-fit items-center rounded-sm bg-general-bg-primary px-2 py-[3px] text-xs font-semibold leading-[14px] text-white">
                        Free to start
                    </span>
                    <div className="flex flex-col gap-1">
                        <p className="text-base font-semibold leading-[1.2]">
                            {tReceipt("createYourTreasury")}
                        </p>
                        <p className="text-sm font-medium leading-[1.5] text-muted-foreground">
                            {tReceipt("createYourTreasuryDescription")}
                        </p>
                    </div>
                </div>
                <div className="flex shrink-0 flex-col items-center gap-2">
                    <a
                        href={LANDING_PAGE}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="Open Near Business landing page"
                    >
                        <QRCode size={66} value={LANDING_PAGE} />
                    </a>
                    <a
                        href={LANDING_PAGE}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium leading-[1.5] underline"
                    >
                        near.com for biz
                    </a>
                </div>
            </div>
        </div>
    );
}

function ReceiptPdfSkeletonLabelRow({
    valueWidth = "w-36",
}: {
    valueWidth?: string;
}) {
    return (
        <ReceiptLabelValueRow
            label={<Skeleton className="h-4 w-24" />}
            value={<Skeleton className={cn("h-4", valueWidth)} />}
        />
    );
}

function ReceiptPdfSkeletonCard() {
    return (
        <PageCard className={RECEIPT_CARD_CLASS}>
            <div className="flex items-start gap-1 border-b border-border pb-4">
                <div className="flex flex-1 flex-col gap-1">
                    <Skeleton className="h-6 w-64" />
                    <Skeleton className="h-5 w-40" />
                </div>
                <Skeleton className="h-6 w-[182px]" />
            </div>

            <div className="flex flex-col gap-5 pb-6">
                <Skeleton className="mb-3 h-6 w-80" />

                <section className="flex flex-col gap-2">
                    <Skeleton className="h-5 w-20" />
                    <div className={receiptSectionRows}>
                        <ReceiptPdfSkeletonLabelRow valueWidth="w-64" />
                    </div>
                </section>

                <section className="flex flex-col gap-2">
                    <Skeleton className="h-5 w-40" />
                    <div className={receiptSectionRows}>
                        <ReceiptPdfSkeletonLabelRow valueWidth="w-20" />
                        <ReceiptPdfSkeletonLabelRow valueWidth="w-28" />
                        <ReceiptPdfSkeletonLabelRow valueWidth="w-32" />
                        <ReceiptPdfSkeletonLabelRow valueWidth="w-24" />
                        <ReceiptPdfSkeletonLabelRow valueWidth="w-48" />
                        <ReceiptPdfSkeletonLabelRow valueWidth="w-36" />
                    </div>
                </section>
            </div>

            <div className="flex items-center gap-10 rounded-xl border border-border bg-general-bg-secondary p-3">
                <div className="flex flex-1 flex-col gap-3">
                    <Skeleton className="h-6 w-24 rounded-sm" />
                    <div className="flex flex-col gap-1">
                        <Skeleton className="h-5 w-44" />
                        <Skeleton className="h-5 w-72" />
                    </div>
                </div>
                <div className="flex flex-col items-center gap-2">
                    <Skeleton className="size-[66px]" />
                    <Skeleton className="h-5 w-20" />
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
    // Amount is what the recipient receives — use destination token/network
    // for the badge (send network stays on the separate Network row).
    const { symbol: amountSymbol } = getTokenDisplayFields(
        destinationToken.metadata,
    );

    return (
        <>
            <ReceiptSenderSection senderAddress={treasuryId ?? ""} />

            <ReceiptSection title={tReceipt("recipient")}>
                <ReceiptLabelValueRow
                    label={tReceipt("address")}
                    value={
                        recipientAddress.isLoading ? (
                            <ReceiptValueSkeleton width="w-28" />
                        ) : (
                            (recipientAddress.value ?? tCommon("notAvailable"))
                        )
                    }
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
                    valueClassName="break-all"
                />
            </ReceiptSection>

            <ReceiptSection title={tReceipt("transactionDetails")} flushLastRow>
                <ReceiptLabelValueRow
                    label={tReceipt("status")}
                    value={<StatusPill status="Executed" />}
                />
                <ReceiptLabelValueRow
                    label={tReceipt("network")}
                    value={
                        <AsyncNetwork
                            metadata={sourceToken.metadata}
                            width="w-20"
                        />
                    }
                />
                <ReceiptTokenAmountRow
                    label={tReceipt("amountWithToken", {
                        token: amountSymbol,
                    })}
                    metadata={destinationToken.metadata}
                    amount={destinationToken.amount}
                />
                <ReceiptLabelValueRow
                    label={tReceipt("amountUsd")}
                    value={<AsyncText value={destinationToken.usd} />}
                />
                <ReceiptLabelValueRow
                    label={tReceipt("rate")}
                    value={<AsyncText value={rate} />}
                />
                <ReceiptLabelValueRow
                    label={tReceipt("dateAndTime")}
                    value={<AsyncText value={executedTime} />}
                />
            </ReceiptSection>
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

            <ReceiptSection title={tReceipt("transactionDetails")} flushLastRow>
                <ReceiptLabelValueRow
                    label={tReceipt("status")}
                    value={<StatusPill status="Executed" />}
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
                />
                <ReceiptLabelValueRow
                    label={tReceipt("receiveAmountUsd")}
                    value={<AsyncText value={destinationToken.usd} />}
                />
                <ReceiptLabelValueRow
                    label={tReceipt("rate")}
                    value={<AsyncText value={rate} />}
                />
                <ReceiptLabelValueRow
                    label={tReceipt("dateAndTime")}
                    value={<AsyncText value={executedTime} />}
                />
            </ReceiptSection>
        </>
    );
}

interface BatchReceiptCardProps {
    batchPayment: { recipient: string; amount: string };
    paymentIndex: number;
    totalPayments: number;
    tokenData: ReturnType<typeof useToken>["data"];
    /**
     * Receive-network token metadata for Destination Network / amount badge.
     * Falls back to `tokenData` (send/origin) when unset.
     */
    destinationTokenData?: ReturnType<typeof useToken>["data"];
    destinationAssetId?: string;
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
    destinationTokenData,
    destinationAssetId,
    batchId,
    sourceHistoricalPriceUsd,
    transactionDate,
    isTransactionDateLoading,
    proposalId,
}: BatchReceiptCardProps) {
    const tReceipt = useTranslations("receiptPage");
    const locale = useLocale();
    const executedTimeDisplay = transactionDate
        ? formatUserDate(transactionDate, {
              timezone: "UTC",
              includeTime: true,
              includeTimezone: true,
              timeFormat: "12",
          })
        : null;
    const isNearComDestination = isNearComNetwork(destinationAssetId);
    // Recipient amount is quote amountOut — use destination token decimals when
    // the receive network is a bridge asset (near.com shares origin metadata).
    const receiveToken =
        !isNearComDestination && destinationTokenData
            ? destinationTokenData
            : tokenData;
    const sourceAmountDecimal =
        decimalFromBaseUnitsOrNull(
            batchPayment.amount,
            receiveToken?.decimals ?? 24,
        )?.toFixed() ?? null;
    const sourceAmountDisplayInput = formatTokenQuantity(sourceAmountDecimal, {
        locale,
        profile: "standard",
        tokenDecimals: receiveToken?.decimals,
        unitPriceUsd: receiveToken?.price,
    }).display;
    const { sourceAmountDisplay, sourceAmountUsd, rateLabel } =
        buildReceiptAmountModel({
            isExchangeReceipt: false,
            hasDepositAddress: false,
            quote: null,
            sourceToken: {
                amountDecimal: sourceAmountDecimal,
                amountDisplay: sourceAmountDisplayInput,
                symbol: receiveToken?.symbol ?? "",
                tokenPrice: receiveToken?.price ?? null,
                historicalPriceUsd: sourceHistoricalPriceUsd,
            },
            destinationToken: {
                amountDecimal: sourceAmountDecimal,
                symbol: receiveToken?.symbol ?? "",
                tokenPrice: receiveToken?.price ?? null,
                historicalPriceUsd: sourceHistoricalPriceUsd,
            },
            locale,
        });

    const sourceNetworkName = tokenData?.network || "NEAR";
    const destinationNetworkName = isNearComDestination
        ? NEAR_COM_NETWORK_ID
        : (destinationTokenData?.network ??
          destinationAssetId ??
          sourceNetworkName);
    const destinationChainIcons = isNearComDestination
        ? getNearComChainIcons()
        : (destinationTokenData?.chainIcons ?? tokenData?.chainIcons);

    const batchTokenInfo = buildTokenReceiptInfo({
        token: {
            ...tokenData,
            tokenId: batchId,
            network: sourceNetworkName,
            chainIcons: tokenData?.chainIcons,
        },
        amount: sourceAmountDisplay,
        usdValue: sourceAmountUsd,
    });
    // Amount + Destination Network use receive-network metadata.
    const destinationTokenInfo = buildTokenReceiptInfo({
        token: {
            ...receiveToken,
            tokenId: destinationAssetId ?? batchId,
            network: destinationNetworkName,
            chainIcons: destinationChainIcons,
        },
        amount: sourceAmountDisplay,
        usdValue: sourceAmountUsd,
    });

    return (
        <PageCard
            className={cn(
                RECEIPT_CARD_CLASS,
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
                        value: formatRecipientForNearComDestination(
                            batchPayment.recipient,
                            destinationAssetId,
                        ),
                        isLoading: false,
                    }}
                    sourceToken={batchTokenInfo}
                    destinationToken={destinationTokenInfo}
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
    const locale = useLocale();
    const hasRecordedGeneratedRef = useRef(false);
    const { id } = use(params);
    const searchParams = useSearchParams();
    const recipientFilter = searchParams.get("recipient");
    const { treasuryId, isConfidential } = useTreasury();
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
    const confidentialBulkReceiptData =
        proposal && isConfidentialRequestProposal
            ? extractConfidentialBulkReceiptData(proposal, treasuryId)
            : null;
    const isConfidentialBulkProposal = confidentialBulkReceiptData !== null;
    // Public batch + confidential bulk both render one receipt card per
    // recipient (multi-card PDF).
    const isMultiRecipientReceipt =
        isBatchPaymentProposal || isConfidentialBulkProposal;
    const isReceiptEligibleProposal =
        isReceiptEligibleProposalKind(proposalUiKind);
    const isSingleReceiptProposal = !isMultiRecipientReceipt;
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
    const receiptSourceAmountUsd = receiptProposalData?.sourceAmountUsd;
    const receiptDestinationAmountUsd =
        receiptProposalData?.destinationAmountUsd;
    const hasExplicitReceiptUsd =
        receiptSourceAmountUsd !== undefined ||
        receiptDestinationAmountUsd !== undefined;
    const isExecutableReceipt = status === "Executed";
    // Intents-routed receipts poll swap status for settlement gating; a move
    // to confidential does too, but its date comes from the chain transaction
    // (the confidential quote status only exposes the quote time).
    const shouldTrackSwapStatus = isExecutableReceipt && !!depositAddress;
    const shouldUseSwapExecutionDate =
        shouldTrackSwapStatus && proposalUiKind !== "Move to Confidential";

    const {
        data: transaction,
        isLoading: isLoadingTransaction,
        isAwaitingTransaction,
    } = useProposalTransaction(
        treasuryId,
        proposal,
        policy,
        !!proposal && !!policy,
    );
    const { data: swapStatus, isLoading: isLoadingSwapStatus } = useSwapStatus(
        depositAddress,
        undefined,
        shouldTrackSwapStatus,
        treasuryId,
    );
    // Intents-routed proposals gate the receipt on a SUCCESS swap status — a
    // pending/failed/refunded swap has no finalized receipt (mirrors the sidebar
    // button gate). Layout already requires login + membership for this page.
    const isSwapSuccessReady =
        !shouldUseSwapExecutionDate || swapStatus?.status === "SUCCESS";
    const {
        executedDate: transactionDate,
        isDateLoading: resolvedTransactionDateLoading,
    } = resolveExecutionTimestamp({
        swapStatus,
        transaction,
        shouldUseSwapDate: shouldUseSwapExecutionDate,
        isLoadingSwapStatus,
        isLoadingTransaction,
        isAwaitingTransaction,
    });
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
        !isConfidentialRequestProposal &&
        !hasExplicitReceiptUsd;
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
        useBatchPayment(
            isConfidentialBulkProposal
                ? null
                : batchReceiptData?.batchId || null,
        );
    const effectiveBatchTokenId = isConfidentialBulkProposal
        ? confidentialBulkReceiptData.tokenId || "near"
        : batchPaymentData?.tokenId?.toLowerCase() === "native"
          ? "near"
          : (batchReceiptData?.tokenId ?? batchPaymentData?.tokenId ?? "near");
    const batchDestinationAssetId = isConfidentialBulkProposal
        ? confidentialBulkReceiptData.destinationAssetId
        : undefined;
    const shouldFetchBatchDestinationToken =
        !!batchDestinationAssetId && !isNearComNetwork(batchDestinationAssetId);
    const { data: batchTokenData } = useToken(effectiveBatchTokenId);
    const { data: batchDestinationTokenData } = useToken(
        shouldFetchBatchDestinationToken ? batchDestinationAssetId : null,
    );
    const { data: batchHistoricalPrice } = useTokenPriceAtTimestamp(
        effectiveBatchTokenId,
        executedAtIso,
        isMultiRecipientReceipt &&
            isExecutableReceipt &&
            !!effectiveBatchTokenId &&
            !!executedAtIso,
    );
    const sourceAmountDecimal =
        isSingleReceiptProposal && sourceAmountRaw
            ? (decimalFromBaseUnitsOrNull(
                  sourceAmountRaw,
                  sourceToken?.decimals ?? 24,
              )?.toFixed() ?? null)
            : isSingleReceiptProposal
              ? null
              : "0";
    const isValidReceipt =
        !!proposal &&
        isReceiptEligibleProposal &&
        (!isSingleReceiptProposal || receiptProposalData !== null) &&
        !!policy &&
        isExecutableReceipt &&
        isSwapSuccessReady &&
        // Public batch on a confidential treasury is unsupported; confidential
        // bulk uses Confidential Request kind and is allowed.
        !(isBatchPaymentProposal && isConfidential);
    const batchPayments = isConfidentialBulkProposal
        ? confidentialBulkReceiptData.payments
        : (batchPaymentData?.payments ?? []);
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
            !isExecutableReceipt
        ) {
            return;
        }

        hasRecordedGeneratedRef.current = true;
        recordReceiptMetric(treasuryId, "generated");
    }, [treasuryId, isExecutableReceipt]);
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
                    amountDisplay: formatTokenQuantity(sourceAmountDecimal, {
                        locale,
                        profile: "standard",
                        tokenDecimals: sourceToken?.decimals,
                        unitPriceUsd: sourceToken?.price,
                    }).display,
                    amountUsd: receiptSourceAmountUsd,
                    symbol: sourceToken?.symbol ?? "",
                    tokenPrice: sourceToken?.price ?? null,
                    historicalPriceUsd: sourceHistoricalPrice?.priceUsd ?? null,
                },
                destinationToken: {
                    amountDecimal: destinationAmountWithDecimals,
                    amountUsd: receiptDestinationAmountUsd,
                    symbol: destinationToken?.symbol ?? "",
                    tokenPrice: destinationToken?.price ?? null,
                    historicalPriceUsd:
                        destinationHistoricalPrice?.priceUsd ?? null,
                },
                locale,
            }),
        [
            isExchangeProposal,
            effectiveQuote,
            sourceAmountDecimal,
            destinationAmountWithDecimals,
            receiptSourceAmountUsd,
            receiptDestinationAmountUsd,
            hasDepositAddress,
            sourceHistoricalPrice?.priceUsd,
            destinationHistoricalPrice?.priceUsd,
            sourceToken?.price,
            sourceToken?.decimals,
            destinationToken?.price,
            sourceToken?.symbol,
            destinationToken?.symbol,
            isSingleReceiptProposal,
            locale,
        ],
    );
    const isTransactionDateLoading =
        isExecutableReceipt &&
        isSingleReceiptProposal &&
        resolvedTransactionDateLoading;
    const isRateLoading = hasExplicitReceiptUsd
        ? false
        : hasDepositAddress
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

    if (
        isLoadingProposal ||
        (canLoadPolicy && isLoadingPolicy) ||
        (shouldUseSwapExecutionDate && isLoadingSwapStatus)
    ) {
        return (
            <div className="min-h-dvh p-4">
                <div className="mx-auto w-full max-w-[595px]">
                    <ReceiptPdfSkeletonCard />
                </div>
            </div>
        );
    }

    const handlePrint = () => {
        if (treasuryId) {
            recordReceiptMetric(treasuryId, "print");
        }
        window.print();
    };

    if (!isValidReceipt) {
        redirect(`/${treasuryId}/requests`);
    }

    if (isMultiRecipientReceipt) {
        const isLoadingMultiRecipientPayments =
            isBatchPaymentProposal && isLoadingBatchPayment;
        return (
            <ReceiptPageShell
                receiptUrl={receiptUrl}
                showCopyLink={!isConfidential}
                onPrint={handlePrint}
            >
                <div className="space-y-4">
                    {isLoadingMultiRecipientPayments ? (
                        <ReceiptPdfSkeletonCard />
                    ) : (
                        paymentsToRender.map((payment, index) => (
                            <BatchReceiptCard
                                key={`${
                                    isConfidentialBulkProposal
                                        ? "confidential-bulk"
                                        : (batchReceiptData?.batchId ?? "batch")
                                }-${index}`}
                                batchPayment={payment}
                                paymentIndex={index}
                                totalPayments={paymentsToRender.length}
                                tokenData={batchTokenData}
                                destinationTokenData={batchDestinationTokenData}
                                destinationAssetId={batchDestinationAssetId}
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
            <PageCard className={RECEIPT_CARD_CLASS}>
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
                                value: receiverAddress
                                    ? formatRecipientForNearComDestination(
                                          receiverAddress,
                                          destinationTokenId,
                                      )
                                    : null,
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
