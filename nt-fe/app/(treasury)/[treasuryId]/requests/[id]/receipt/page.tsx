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
    isTerminalSwapStatus,
} from "@/features/proposals/utils/receipt-utils";
import { NetworkIconDisplay } from "@/components/token-display";
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
import { recordReceiptMetric } from "@/lib/proposals-api";
import type { BatchPaymentRequestData } from "@/features/proposals/types/index";

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
    label: string;
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
        <div
            className={cn(
                "flex items-start justify-between text-sm",
                "gap-4",
                className,
            )}
        >
            <p className={cn("text-muted-foreground text-sm", labelClassName)}>
                {label}
            </p>
            <div className={cn("text-right font-medium", valueClassName)}>
                {value}
            </div>
        </div>
    );
}

function ReceiptValueSkeleton({ width = "w-24" }: { width?: string }) {
    return <Skeleton className={cn("ml-auto h-5", width)} />;
}

function AsyncText({ value }: { value: AsyncValue<string> }) {
    if (value.isLoading || value.value == null) {
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
        <div className="flex justify-end">
            <NetworkIconDisplay
                chainIcons={
                    networkChainIcons?.icon
                        ? { icon: networkChainIcons.icon }
                        : null
                }
                networkName={networkName}
                networkNameClassName="font-medium"
                expandNearComLabel
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
        <div className="min-h-dvh bg-background print:bg-white print-color-exact">
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

            <main className="px-4 py-4 pb-8 print:px-0 print:py-0">
                <div className="mx-auto w-full max-w-[700px]">{children}</div>
            </main>
        </div>
    );
}

function ReceiptLayout({ title, receiptDate, children }: ReceiptLayoutProps) {
    const tReceipt = useTranslations("receiptPage");
    const tCommon = useTranslations("common");
    const createTreasuryUrl =
        typeof window !== "undefined"
            ? `${window.location.origin}/app/new`
            : "/app/new";

    return (
        <div className="space-y-8">
            <div className="flex items-start justify-between border-b pb-4">
                <div>
                    <p className="text-xl font-semibold">{title}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {tReceipt("generatedOn")}{" "}
                        {formatUserDate(new Date(), {
                            timezone: "UTC",
                            includeTime: false,
                        })}
                    </p>
                </div>
                <Logo size="md" />
            </div>

            <p className="text-xl font-semibold">
                {tReceipt("receiptDated")}{" "}
                {receiptDate.isLoading ? (
                    <span className="inline-block align-middle">
                        <ReceiptValueSkeleton width="w-32" />
                    </span>
                ) : receiptDate.value ? (
                    formatUserDate(receiptDate.value, {
                        timezone: "UTC",
                        includeTime: false,
                    })
                ) : (
                    tCommon("notAvailable")
                )}
            </p>
            {children}
            <div className="flex justify-between rounded-lg bg-muted p-3">
                <div>
                    <p className="text-base font-medium">
                        {tReceipt("createYourTreasury")}
                    </p>
                    <p className="text-sm text-muted-foreground">
                        {tReceipt("createYourTreasuryDescription")}
                    </p>
                </div>
                <div>
                    <QRCode size={66} value={createTreasuryUrl} />
                </div>
            </div>
        </div>
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
                    <ReceiptSectionTitle>
                        {tReceipt("recipient")}
                    </ReceiptSectionTitle>
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
    paymentCount: number;
    batchTokenData: ReturnType<typeof useToken>["data"];
    effectiveBatchTokenId: string;
    sourceHistoricalPriceUsd: number | null;
    transactionDate: Date | null;
    isTransactionDateLoading: boolean;
    executedTimeValue: string | null;
}

function BatchReceiptCard({
    batchPayment,
    paymentIndex,
    paymentCount,
    batchTokenData,
    effectiveBatchTokenId,
    sourceHistoricalPriceUsd,
    transactionDate,
    isTransactionDateLoading,
    executedTimeValue,
}: BatchReceiptCardProps) {
    const tReceipt = useTranslations("receiptPage");
    const normalizedAmount = formatBalance(
        batchPayment.amount,
        batchTokenData?.decimals ?? 24,
    );
    const formattedAmount = formatTokenDisplayAmount(normalizedAmount);
    const { sourceAmountDisplay, sourceAmountUsd, rateLabel } =
        buildReceiptAmountModel({
            isExchangeReceipt: false,
            hasDepositAddress: false,
            quote: null,
            sourceToken: {
                normalizedAmount,
                formattedAmount,
                symbol: batchTokenData?.symbol ?? "",
                tokenPrice: batchTokenData?.price ?? null,
                historicalPriceUsd: sourceHistoricalPriceUsd,
            },
            destinationToken: {
                amountWithDecimals: normalizedAmount,
                symbol: batchTokenData?.symbol ?? "",
                tokenPrice: batchTokenData?.price ?? null,
                historicalPriceUsd: sourceHistoricalPriceUsd,
            },
        });

    const batchTokenInfo = buildTokenReceiptInfo({
        tokenId: effectiveBatchTokenId,
        token: {
            ...batchTokenData,
            network: batchTokenData?.network || "NEAR",
            chainIcons: batchTokenData?.chainIcons,
        },
        amount: sourceAmountDisplay,
        usdValue: sourceAmountUsd,
    });

    return (
        <PageCard
            className={cn(
                "rounded-none bg-card p-8 print:shadow-none",
                paymentIndex < paymentCount - 1 && "break-after-page",
            )}
        >
            <ReceiptLayout
                title={tReceipt("paymentConfirmation")}
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
                        value: executedTimeValue,
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
    const proposalUiKind = proposal ? getProposalUIKind(proposal) : undefined;
    const isBatchPaymentProposal = proposalUiKind === "Batch Payment Request";
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

    const isHidden = isConfidential && isGuestTreasury;
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
    const hasSingleReceiptData = receiptProposalData !== null;
    const receiptProposalVariant = receiptProposalData?.variant ?? "payment";
    const sourceTokenId = receiptProposalData?.sourceTokenId;
    const destinationTokenId = receiptProposalData?.destinationTokenId;
    const depositAddress = receiptProposalData?.depositAddress;
    const receiverAddress = receiptProposalData?.receiverAddress;
    const sourceAmountRaw = receiptProposalData?.sourceAmountRaw;
    const destinationAmountWithDecimals =
        receiptProposalData?.destinationAmountWithDecimals;
    const isExecutableReceipt = status === "Executed";

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
        isExecutableReceipt && !!depositAddress,
    );
    const isSwapTerminalReady =
        !depositAddress || isTerminalSwapStatus(swapStatus?.status);
    const transactionDate = getProposalExecutedDate(swapStatus, transaction);
    const isExchangeProposal = receiptProposalVariant === "exchange";
    const hasDepositAddress = !!depositAddress;
    const shouldLoadSingleReceiptData = !isBatchPaymentProposal;
    const executedAtIso =
        shouldLoadSingleReceiptData &&
        transactionDate &&
        !Number.isNaN(transactionDate.getTime())
            ? transactionDate.toISOString()
            : null;
    const {
        data: quoteByDepositAddress,
        isLoading: isLoadingQuoteByDepositAddress,
    } = useQuoteByDepositAddress(
        depositAddress,
        undefined,
        shouldLoadSingleReceiptData && isExecutableReceipt && !!depositAddress,
    );
    const {
        data: sourceHistoricalPrice,
        isLoading: isLoadingSourceHistoricalPrice,
    } = useTokenPriceAtTimestamp(
        sourceTokenId,
        executedAtIso,
        shouldLoadSingleReceiptData &&
            isExecutableReceipt &&
            !hasDepositAddress &&
            !!sourceTokenId &&
            !!executedAtIso,
    );
    const {
        data: destinationHistoricalPrice,
        isLoading: isLoadingDestinationHistoricalPrice,
    } = useTokenPriceAtTimestamp(
        destinationTokenId,
        executedAtIso,
        shouldLoadSingleReceiptData &&
            isExecutableReceipt &&
            !hasDepositAddress &&
            isExchangeProposal &&
            !!destinationTokenId &&
            !!executedAtIso,
    );

    const { data: sourceToken } = useToken(
        shouldLoadSingleReceiptData ? sourceTokenId : null,
    );
    const { data: destinationToken } = useToken(
        shouldLoadSingleReceiptData ? destinationTokenId : null,
    );
    const { data: batchPaymentData, isLoading: isLoadingBatchPayment } =
        useBatchPayment(batchReceiptData?.batchId || null);
    const effectiveBatchTokenId =
        batchPaymentData?.tokenId?.toLowerCase() === "native"
            ? "near"
            : (batchReceiptData?.tokenId ??
              batchPaymentData?.tokenId ??
              "near");
    const { data: batchTokenData } = useToken(effectiveBatchTokenId);
    const tokenDecimals = sourceToken?.decimals ?? 24;
    const normalizedAmount =
        shouldLoadSingleReceiptData && sourceAmountRaw
            ? formatBalance(sourceAmountRaw, tokenDecimals)
            : "0";
    const formattedAmount = formatTokenDisplayAmount(normalizedAmount);
    const isInvalidSingleReceiptSwapTerminal =
        isSingleReceiptProposal &&
        !!depositAddress &&
        !isLoadingSwapStatus &&
        !isSwapTerminalReady;
    const isValidReceipt =
        !!proposal &&
        isReceiptEligibleProposal &&
        (!isSingleReceiptProposal || hasSingleReceiptData) &&
        !!policy &&
        isExecutableReceipt &&
        !isInvalidSingleReceiptSwapTerminal &&
        !(isBatchPaymentProposal && isConfidential);
    const redirectPath = isValidReceipt ? null : `/${treasuryId}/requests`;
    const shouldTrackGeneratedMetric =
        !hasRecordedGeneratedRef.current &&
        !!treasuryId &&
        !isHidden &&
        isExecutableReceipt &&
        (!depositAddress || isSwapTerminalReady);
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
        if (!shouldTrackGeneratedMetric || !treasuryId) {
            return;
        }

        hasRecordedGeneratedRef.current = true;
        recordReceiptMetric(treasuryId, "generated");
    }, [treasuryId, shouldTrackGeneratedMetric]);

    const sourceSymbol = sourceToken?.symbol ?? "";
    const destinationSymbol = destinationToken?.symbol ?? "";
    const sourceHistoricalPriceUsd =
        sourceHistoricalPrice?.source === "exact_timestamp" ||
        sourceHistoricalPrice?.source === "daily_eod"
            ? sourceHistoricalPrice.priceUsd
            : null;
    const destinationHistoricalPriceUsd =
        destinationHistoricalPrice?.source === "exact_timestamp" ||
        destinationHistoricalPrice?.source === "daily_eod"
            ? destinationHistoricalPrice.priceUsd
            : null;
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
                quote: shouldLoadSingleReceiptData
                    ? quoteByDepositAddress
                    : null,
                sourceToken: {
                    normalizedAmount,
                    formattedAmount,
                    symbol: sourceSymbol,
                    tokenPrice: sourceToken?.price ?? null,
                    historicalPriceUsd: sourceHistoricalPriceUsd,
                },
                destinationToken: {
                    amountWithDecimals: destinationAmountWithDecimals,
                    symbol: destinationSymbol,
                    tokenPrice: destinationToken?.price ?? null,
                    historicalPriceUsd: destinationHistoricalPriceUsd,
                },
            }),
        [
            isExchangeProposal,
            quoteByDepositAddress,
            normalizedAmount,
            formattedAmount,
            destinationAmountWithDecimals,
            hasDepositAddress,
            sourceHistoricalPriceUsd,
            destinationHistoricalPriceUsd,
            sourceToken?.price,
            destinationToken?.price,
            sourceSymbol,
            destinationSymbol,
        ],
    );
    const isTransactionDateLoading =
        isExecutableReceipt &&
        shouldLoadSingleReceiptData &&
        ((hasDepositAddress && isLoadingSwapStatus) ||
            (!hasDepositAddress && isLoadingTransaction));
    const isRateLoading = hasDepositAddress
        ? shouldLoadSingleReceiptData && isLoadingQuoteByDepositAddress
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
                tokenId: sourceTokenId ?? undefined,
                token: sourceToken,
                amount: sourceAmountDisplay,
                usdValue: sourceAmountUsd,
            }),
        [sourceTokenId, sourceToken, sourceAmountDisplay, sourceAmountUsd],
    );
    const destinationTokenInfo = useMemo(
        () =>
            buildTokenReceiptInfo({
                tokenId: destinationTokenId ?? undefined,
                token: {
                    ...destinationToken,
                    network:
                        destinationToken?.network ??
                        sourceToken?.network ??
                        destinationTokenId,
                    chainIcons:
                        destinationToken?.chainIcons ?? sourceToken?.chainIcons,
                },
                amount: destinationAmountDisplay,
                usdValue: destinationAmountUsd,
            }),
        [
            destinationTokenId,
            destinationToken,
            sourceToken?.network,
            sourceToken?.chainIcons,
            destinationAmountDisplay,
            destinationAmountUsd,
        ],
    );

    if (isLoadingProposal || (canLoadPolicy && isLoadingPolicy)) {
        return (
            <div className="min-h-dvh bg-muted p-4">
                <PageCard className="mx-auto w-full max-w-3xl">
                    <Skeleton className="h-8 w-56" />
                    <Skeleton className="h-64 w-full" />
                </PageCard>
            </div>
        );
    }

    if (redirectPath) {
        redirect(redirectPath);
    }
    const handlePrint = () => {
        if (treasuryId && !isHidden) {
            recordReceiptMetric(treasuryId, "print");
        }
        window.print();
    };

    if (isBatchPaymentProposal) {
        return (
            <ReceiptPageShell
                receiptUrl={receiptUrl}
                showCopyLink={!isConfidential}
                onPrint={handlePrint}
            >
                <div className="space-y-4">
                    {isLoadingBatchPayment ? (
                        <PageCard className="bg-card p-8 rounded-none">
                            <Skeleton className="h-8 w-56" />
                            <Skeleton className="h-64 w-full" />
                        </PageCard>
                    ) : (
                        paymentsToRender.map((payment, index) => (
                            <BatchReceiptCard
                                key={`${batchReceiptData?.batchId ?? "batch"}-${index}`}
                                batchPayment={payment}
                                paymentIndex={index}
                                paymentCount={paymentsToRender.length}
                                batchTokenData={batchTokenData}
                                effectiveBatchTokenId={effectiveBatchTokenId}
                                sourceHistoricalPriceUsd={
                                    sourceHistoricalPriceUsd
                                }
                                transactionDate={transactionDate}
                                isTransactionDateLoading={
                                    isTransactionDateLoading
                                }
                                executedTimeValue={executedTimeValue}
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
            {isHidden ? (
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
            ) : (
                <PageCard className="bg-card p-8 rounded-none print:shadow-none">
                    <ReceiptLayout
                        title={
                            isExchangeProposal
                                ? tReceipt("exchangeConfirmation")
                                : tReceipt("paymentConfirmation")
                        }
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
            )}
        </ReceiptPageShell>
    );
}
