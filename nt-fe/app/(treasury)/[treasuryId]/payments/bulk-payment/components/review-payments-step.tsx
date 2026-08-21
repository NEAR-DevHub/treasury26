"use client";

import { Edit2, Info, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { useFormContext } from "react-hook-form";
import { toast } from "sonner";
import { Address } from "@/components/address";
import { AmountSummary } from "@/components/amount-summary";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { CreateRequestButton } from "@/components/create-request-button";
import { FormattedAmount } from "@/components/formatted-amount";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { NumberBadge } from "@/components/number-badge";
import { ReviewStep, type StepProps } from "@/components/step-wizard";
import { Textarea } from "@/components/textarea";
import { TokenDisplay } from "@/components/token-display-with-network";
import { Tooltip } from "@/components/tooltip";
import { useAddressBook } from "@/features/address-book";
import { useTokenCatalog } from "@/hooks/use-bridge-tokens";
import { useTreasury } from "@/hooks/use-treasury";
import { useToken, useTokenBalance } from "@/hooks/use-treasury-queries";
import { decimalFromBaseUnits } from "@/lib/amount-format";
import { trackEvent } from "@/lib/analytics";
import Big from "@/lib/big";
import { getPaymentBalanceWarning } from "@/lib/intents-fee";
import { getNearComChainIcons, isNearComNetwork } from "@/lib/intents-network";
import { formatRecipientForNearComDestination } from "@/lib/nearcom-address";
import { cn } from "@/lib/utils";
import type { BulkPaymentData, BulkPaymentFormValues } from "../schemas";
import { validateAccountsAndStorage } from "../utils";
import type { QuoteFees } from "../utils/confidential-prepare";
import { useBulkParsingLabels } from "../utils/use-parsing-labels";

interface ReviewPaymentsStepProps extends StepProps {
    initialPaymentData: BulkPaymentData[];
    networkFeePerRecipient: string | null;
    onEditPayment: (index: number) => void;
    onPaymentDataChange: (data: BulkPaymentData[]) => void;
    onSubmit: () => void;
    isSubmitting?: boolean;
    /**
     * Confidential flow: selected receive-network id (bridge asset network id
     * or near.com). Drives the network badge on each recipient amount row —
     * same pattern as single confidential payment review.
     */
    destinationNetworkId?: string;
    /**
     * Confidential flow: raw receive-network name used for NEAR account /
     * storage validation when receive chain ≠ source token chain.
     */
    destinationNetworkName?: string;
    /**
     * Confidential flow only: lifecycle of the review-time prepare call that
     * fetches firm quotes. Display amounts come from `quotes` (same fields
     * request details reads from stored prepare metadata); submission stays
     * blocked until status is success.
     */
    confidentialPrepare?: {
        status: "idle" | "loading" | "success" | "error";
        fees: QuoteFees | null;
        /**
         * Firm quote amounts from prepare — mirrors backend / request details.
         * Null while loading or while a fee re-pad is in flight.
         */
        quotes: {
            /** DAO total spend (`headerQuote.amountInFormatted`). */
            headerAmountInFormatted: string;
            /** Per-recipient net (`amountOutFormatted`), same order as payments. */
            recipientAmountOutFormatted: string[];
        } | null;
        retry: () => void;
        /**
         * Treasury has no batch-payment credits (or prepare 402'd). Quotes
         * aren't fetched and submission stays blocked; retry is pointless.
         */
        outOfCredits: boolean;
    };
}

export function ReviewPaymentsStep({
    handleBack,
    initialPaymentData,
    networkFeePerRecipient,
    onEditPayment,
    onPaymentDataChange,
    onSubmit,
    isSubmitting = false,
    destinationNetworkId,
    destinationNetworkName,
    confidentialPrepare,
}: ReviewPaymentsStepProps) {
    const locale = useLocale();
    const tPay = useTranslations("payments");
    const tBulk = useTranslations("bulkPayment");
    const tIntents = useTranslations("intentsQuote");
    const tCommon = useTranslations("common");
    const parsingLabels = useBulkParsingLabels();
    const form = useFormContext<BulkPaymentFormValues>();
    const selectedToken = form.watch("selectedToken");
    const comment = form.watch("comment");

    const [paymentData, setPaymentData] =
        useState<BulkPaymentData[]>(initialPaymentData);
    const [isValidatingAccounts, setIsValidatingAccounts] = useState(false);
    const [validationComplete, setValidationComplete] = useState(false);
    const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
    const [recipientToRemove, setRecipientToRemove] = useState<{
        index: number;
        recipient: string;
    } | null>(null);

    const { treasuryId } = useTreasury();
    const { data: addressBook = [] } = useAddressBook();
    const { data: bridgeAssets = [] } = useTokenCatalog({ kind: "swap" });
    const { data: selectedTokenData } = useToken(selectedToken?.address || "");
    const { data: balance } = useTokenBalance(
        treasuryId,
        selectedToken?.address || "",
    );

    // Chain icons for the receive network (recipient amount badge) — mirrors
    // single confidential payment review.
    const destinationChainIcons = useMemo(() => {
        if (!destinationNetworkId) {
            return undefined;
        }
        if (isNearComNetwork(destinationNetworkId)) {
            return getNearComChainIcons();
        }
        for (const asset of bridgeAssets) {
            const network = asset.networks.find(
                (n) => n.id === destinationNetworkId,
            );
            if (network?.chainIcons) return network.chainIcons;
        }
        return undefined;
    }, [bridgeAssets, destinationNetworkId]);

    // Validate accounts on mount
    useEffect(() => {
        if (!selectedToken || validationComplete || paymentData.length === 0)
            return;

        const validateAccounts = async () => {
            setIsValidatingAccounts(true);
            try {
                const validatedPayments = await validateAccountsAndStorage(
                    paymentData,
                    selectedToken,
                    parsingLabels,
                    destinationNetworkName,
                );
                setPaymentData(validatedPayments);
                onPaymentDataChange(validatedPayments);
            } finally {
                setIsValidatingAccounts(false);
            }
        };

        validateAccounts();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleRemovePayment = (index: number) => {
        if (isSubmitting) return;
        const updatedPayments = paymentData.filter((_, i) => i !== index);
        setPaymentData(updatedPayments);
        onPaymentDataChange(updatedPayments);
        setRemoveDialogOpen(false);
        setRecipientToRemove(null);

        // Empty review is invalid — send the user back to upload a new list.
        if (updatedPayments.length === 0) {
            toast.info(tBulk("allRecipientsRemoved"));
            handleBack?.();
        }
    };

    const handleRemoveClick = (index: number, recipient: string) => {
        if (isSubmitting) return;
        setRecipientToRemove({ index, recipient });
        setRemoveDialogOpen(true);
    };

    const handleEditClick = (index: number) => {
        if (isSubmitting) return;
        onEditPayment(index);
    };

    const handleProceedClick = () => {
        if (isSubmitting || paymentData.length === 0) return;
        trackEvent("bulk-payments-submit-click", {
            source: "bulk_payments_review_step",
            treasury_id: treasuryId ?? "",
        });
        onSubmit();
    };

    if (!selectedToken) {
        return null;
    }

    const recipientsTotal = paymentData.reduce(
        (sum, item) => sum.add(Big(item.amount || "0")),
        Big(0),
    );

    const hasValidationErrors = paymentData.some(
        (payment) => payment.validationError,
    );
    const isFetchingNetworkFees =
        confidentialPrepare !== undefined &&
        !confidentialPrepare.outOfCredits &&
        (confidentialPrepare.status === "loading" ||
            confidentialPrepare.status === "idle");
    const feePerRecipient = networkFeePerRecipient
        ? Big(networkFeePerRecipient)
        : null;
    // Confidential flow: fees come from the firm quotes fetched at review
    // load (null until they arrive, and zero-fee legs show no row — same as
    // the estimate path). Standard flow keeps the local estimate.
    const estimatedTotalFee = feePerRecipient
        ? feePerRecipient.mul(paymentData.length)
        : null;
    const quotedTotalFee = confidentialPrepare?.fees?.totalNetworkFee;
    const totalNetworkFee = confidentialPrepare
        ? quotedTotalFee?.gt(0)
            ? quotedTotalFee
            : null
        : estimatedTotalFee;
    // Confidential: Total = header quote amountIn (what the DAO is charged) —
    // same field request details uses. Fallback while quotes load: typed sum
    // (+ estimated fee for public / pre-quote).
    const quotedTotalAmount = confidentialPrepare?.quotes
        ?.headerAmountInFormatted
        ? Big(confidentialPrepare.quotes.headerAmountInFormatted)
        : null;
    const totalAmount =
        quotedTotalAmount ??
        (totalNetworkFee
            ? recipientsTotal.add(totalNetworkFee)
            : recipientsTotal);
    // Per-recipient fee shown on each row: the firm quote leg in the
    // confidential flow (guarded on length so a just-edited list never reads
    // a stale quote by index; zero-fee legs show nothing), the flat local
    // estimate otherwise.
    const quotedRecipientFees =
        confidentialPrepare?.fees?.perRecipientFees.length ===
        paymentData.length
            ? confidentialPrepare.fees.perRecipientFees
            : null;
    const quotedRecipientOuts =
        confidentialPrepare?.quotes?.recipientAmountOutFormatted.length ===
        paymentData.length
            ? confidentialPrepare.quotes.recipientAmountOutFormatted
            : null;
    const getRecipientFee = (index: number) => {
        if (confidentialPrepare) {
            const fee = quotedRecipientFees?.[index];
            return fee?.gt(0) ? fee : null;
        }
        return feePerRecipient;
    };
    // Confidential: show amountOut (net received) once quotes land — matches
    // request details. Until then show the typed amount.
    const getRecipientDisplayAmount = (index: number, typedAmount: string) =>
        quotedRecipientOuts?.[index] ?? typedAmount;

    // Calculate total USD value and check insufficient balance (amount + fees)
    let totalUSDValue = Big(0);
    let balanceWarning = null;

    if (balance) {
        try {
            const balanceBig = Big(balance);
            const balanceFormattedBig = decimalFromBaseUnits(
                balanceBig,
                selectedToken.decimals,
            );

            // When total already includes fees (header quote or typed+fee),
            // do not pass networkFee again — that double-counts.
            balanceWarning = getPaymentBalanceWarning({
                amount: quotedTotalAmount
                    ? totalAmount.toString()
                    : recipientsTotal.toString(),
                balance: balanceFormattedBig,
                networkFee: quotedTotalAmount
                    ? undefined
                    : (totalNetworkFee ?? undefined),
                decimals: selectedToken.decimals,
                symbol: selectedToken.symbol,
                locale,
            });

            // USD follows payment amount × price; do not require a non-zero
            // treasury balance (that only gates the insufficient-funds warning).
            if (selectedTokenData?.price && totalAmount.gt(0)) {
                totalUSDValue = totalAmount.mul(selectedTokenData.price);
            }
        } catch (error) {
            console.error("Error calculating total USD value:", error);
        }
    } else if (selectedTokenData?.price && totalAmount.gt(0)) {
        try {
            totalUSDValue = totalAmount.mul(selectedTokenData.price);
        } catch (error) {
            console.error("Error calculating total USD value:", error);
        }
    }

    return (
        <PageCard className="max-w-[600px] mx-auto w-full min-w-0">
            <ReviewStep
                reviewingTitle={tPay("reviewYourPayment")}
                handleBack={handleBack}
                backDisabled={isSubmitting}
            >
                {/* Total Summary */}
                <AmountSummary
                    total={totalAmount}
                    totalUSD={totalUSDValue.toNumber()}
                    token={selectedToken}
                    showNetworkIcon={true}
                >
                    <p className="font-normal">
                        {tPay("summaryRecipients", {
                            count: paymentData.length,
                        })}
                    </p>
                    {balanceWarning && (
                        <p className="text-general-info-foreground text-sm mt-2 font-normal">
                            {balanceWarning.type === "fee_not_covered"
                                ? tBulk("insufficientTokensForFee", {
                                      fee: balanceWarning.formattedFee ?? "",
                                      symbol: balanceWarning.symbol ?? "",
                                  })
                                : tBulk("insufficientTokens")}
                        </p>
                    )}
                </AmountSummary>

                {/* Recipients List */}
                <div className="space-y-4 mb-2">
                    <h3 className="text-sm text-muted-foreground mb-6">
                        {tBulk("recipients")}
                    </h3>

                    {isValidatingAccounts ? (
                        // Loading skeleton while validating
                        <>
                            {paymentData.map((_, index) => (
                                <div key={index} className="space-y-3">
                                    <div className="flex items-start gap-3">
                                        <NumberBadge
                                            number={index + 1}
                                            variant="secondary"
                                        />
                                        <div className="flex-1">
                                            <div className="flex justify-between mb-2">
                                                <div className="flex flex-col gap-2 justify-between flex-1">
                                                    <div className="h-5 w-48 bg-general-unofficial-accent-0 animate-pulse rounded" />
                                                </div>
                                                <div>
                                                    <div className="flex flex-col gap-2 items-end">
                                                        <div className="h-5 w-32 bg-general-unofficial-accent-0 animate-pulse rounded" />
                                                        <div className="h-4 w-20 bg-general-unofficial-accent-0 animate-pulse rounded" />
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </>
                    ) : (
                        // Actual data after validation
                        <>
                            {paymentData.map((payment, index) => {
                                const recipientFee = getRecipientFee(index);
                                const displayAmount = getRecipientDisplayAmount(
                                    index,
                                    payment.amount,
                                );
                                // Total includes fee when present (matches the
                                // info-tooltip breakdown); USD stays on the
                                // net recipient amount.
                                const rowTotalAmount = recipientFee
                                    ? Big(displayAmount || "0").add(
                                          recipientFee,
                                      )
                                    : Big(displayAmount || "0");
                                let estimatedUSDValue = Big(0);
                                if (selectedTokenData?.price) {
                                    try {
                                        const amountBig = Big(
                                            displayAmount || "0",
                                        );
                                        if (amountBig.gt(0)) {
                                            estimatedUSDValue = amountBig.mul(
                                                selectedTokenData.price,
                                            );
                                        }
                                    } catch (error) {
                                        console.error(
                                            "Error calculating USD value:",
                                            error,
                                        );
                                        estimatedUSDValue = Big(0);
                                    }
                                }

                                return (
                                    <div
                                        key={index}
                                        className={`space-y-3 ${
                                            index < paymentData.length - 1
                                                ? "border-b border-border pb-4"
                                                : ""
                                        }`}
                                    >
                                        <div className="flex items-start gap-3">
                                            <NumberBadge
                                                number={index + 1}
                                                variant={
                                                    payment.validationError
                                                        ? "error"
                                                        : "secondary"
                                                }
                                            />
                                            <div className="flex-1 min-w-0 space-y-2">
                                                <div className="flex items-start justify-between gap-2 w-full">
                                                    <div className="flex flex-col gap-0.5 min-w-0 overflow-hidden">
                                                        {(() => {
                                                            const contact =
                                                                addressBook.find(
                                                                    (e) =>
                                                                        e.address.toLowerCase() ===
                                                                        payment.recipient.toLowerCase(),
                                                                );
                                                            return (
                                                                <>
                                                                    {contact && (
                                                                        <span className="font-semibold text-sm text-foreground truncate">
                                                                            {
                                                                                contact.name
                                                                            }
                                                                        </span>
                                                                    )}

                                                                    <Address
                                                                        address={formatRecipientForNearComDestination(
                                                                            payment.recipient,
                                                                            destinationNetworkId,
                                                                        )}
                                                                        className={cn(
                                                                            "min-w-0",
                                                                            contact
                                                                                ? "text-xs text-muted-foreground"
                                                                                : "font-semibold text-sm text-foreground",
                                                                        )}
                                                                    />
                                                                </>
                                                            );
                                                        })()}
                                                    </div>

                                                    <div className="flex items-start gap-2 shrink-0">
                                                        <TokenDisplay
                                                            symbol={
                                                                selectedToken.symbol
                                                            }
                                                            icon={
                                                                selectedToken.icon ||
                                                                ""
                                                            }
                                                            chainIcons={
                                                                destinationChainIcons ??
                                                                selectedToken.chainIcons
                                                            }
                                                            iconSize="md"
                                                        />
                                                        <div className="flex flex-col gap-[3px] items-end">
                                                            <div className="flex items-center gap-1">
                                                                <p className="text-sm font-semibold whitespace-nowrap leading-5">
                                                                    <FormattedAmount
                                                                        kind="token"
                                                                        value={
                                                                            rowTotalAmount
                                                                        }
                                                                        symbol={
                                                                            selectedToken.symbol
                                                                        }
                                                                        tokenDecimals={
                                                                            selectedToken.decimals
                                                                        }
                                                                        unitPriceUsd={
                                                                            selectedTokenData?.price
                                                                        }
                                                                        profile="standard"
                                                                    />
                                                                </p>
                                                                {recipientFee && (
                                                                    <Tooltip
                                                                        content={
                                                                            <div className="text-left">
                                                                                <p className="flex items-center gap-1">
                                                                                    <FormattedAmount
                                                                                        kind="token"
                                                                                        value={
                                                                                            displayAmount
                                                                                        }
                                                                                        symbol={
                                                                                            selectedToken.symbol
                                                                                        }
                                                                                        tokenDecimals={
                                                                                            selectedToken.decimals
                                                                                        }
                                                                                        unitPriceUsd={
                                                                                            selectedTokenData?.price
                                                                                        }
                                                                                        profile="standard"
                                                                                    />
                                                                                    +
                                                                                    <FormattedAmount
                                                                                        kind="token"
                                                                                        value={
                                                                                            recipientFee
                                                                                        }
                                                                                        symbol={
                                                                                            selectedToken.symbol
                                                                                        }
                                                                                        tokenDecimals={
                                                                                            selectedToken.decimals
                                                                                        }
                                                                                        unitPriceUsd={
                                                                                            selectedTokenData?.price
                                                                                        }
                                                                                        profile="standard"
                                                                                        rounding="up"
                                                                                    />
                                                                                </p>
                                                                                <p className="lowercase">
                                                                                    {tPay(
                                                                                        "networkFee",
                                                                                    )}
                                                                                </p>
                                                                            </div>
                                                                        }
                                                                        side="right"
                                                                    >
                                                                        <Info
                                                                            className="size-3.5 shrink-0 text-muted-foreground"
                                                                            aria-label={tPay(
                                                                                "networkFeeInfo",
                                                                            )}
                                                                        />
                                                                    </Tooltip>
                                                                )}
                                                            </div>
                                                            <p className="text-xs text-muted-foreground whitespace-nowrap">
                                                                ≈{" "}
                                                                <FormattedAmount
                                                                    kind="fiat"
                                                                    value={
                                                                        estimatedUSDValue
                                                                    }
                                                                />
                                                            </p>
                                                        </div>
                                                    </div>
                                                </div>

                                                {payment.validationError && (
                                                    <div className="text-xs text-red-600 dark:text-red-400">
                                                        {
                                                            payment.validationError
                                                        }
                                                    </div>
                                                )}

                                                <div className="flex items-center gap-3 justify-end">
                                                    <Button
                                                        variant="unstyled"
                                                        size="sm"
                                                        className="text-muted-foreground hover:text-foreground px-0!"
                                                        onClick={() =>
                                                            handleEditClick(
                                                                index,
                                                            )
                                                        }
                                                        disabled={isSubmitting}
                                                    >
                                                        <Edit2 className="w-4 h-4" />{" "}
                                                        {tBulk("edit")}
                                                    </Button>
                                                    <Button
                                                        variant="unstyled"
                                                        size="sm"
                                                        className="text-muted-foreground hover:text-foreground px-0!"
                                                        onClick={() =>
                                                            handleRemoveClick(
                                                                index,
                                                                payment.recipient,
                                                            )
                                                        }
                                                        disabled={isSubmitting}
                                                    >
                                                        <Trash2 className="w-4 h-4" />{" "}
                                                        {tBulk("remove")}
                                                    </Button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </>
                    )}
                </div>

                {/* Confidential: skeleton while firm quotes are in flight. */}
                {!isValidatingAccounts &&
                    confidentialPrepare?.status === "loading" && (
                        <div className="flex items-center justify-between gap-2 text-sm py-3 border-t border-border">
                            <div className="flex items-center gap-1 text-muted-foreground">
                                <p>{tPay("networkFee")}</p>
                                <Tooltip
                                    content={tIntents("networkFeeTooltip")}
                                    side="top"
                                >
                                    <Info
                                        className="size-3 shrink-0"
                                        aria-label={tPay("networkFeeInfo")}
                                    />
                                </Tooltip>
                            </div>
                            <div className="h-5 w-24 bg-general-unofficial-accent-0 animate-pulse rounded" />
                        </div>
                    )}

                {/* Confidential: no batch-payment credits — no quotes, no
                    submit, and nothing a retry could fix. */}
                {!isValidatingAccounts && confidentialPrepare?.outOfCredits && (
                    <div className="flex items-center justify-between gap-2 text-sm py-3 border-t border-border">
                        <p className="text-red-600 dark:text-red-400">
                            {tBulk("upload.bulkPaymentsUsed")}
                        </p>
                    </div>
                )}

                {/* Confidential: quote fetch failed — submission stays blocked. */}
                {!isValidatingAccounts &&
                    !confidentialPrepare?.outOfCredits &&
                    confidentialPrepare?.status === "error" && (
                        <div className="flex items-center justify-between gap-2 text-sm py-3 border-t border-border">
                            <p className="text-red-600 dark:text-red-400">
                                {tBulk("quoteFetchFailed")}
                            </p>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={confidentialPrepare.retry}
                                disabled={isSubmitting}
                            >
                                {tCommon("retry")}
                            </Button>
                        </div>
                    )}

                {!isValidatingAccounts && totalNetworkFee && (
                    <div className="flex items-center justify-between gap-2 text-sm py-3 border-t border-border">
                        <div className="flex items-center gap-1 text-muted-foreground">
                            <p>{tPay("networkFee")}</p>
                            <Tooltip
                                content={tIntents("networkFeeTooltip")}
                                side="top"
                            >
                                <Info
                                    className="size-3 shrink-0"
                                    aria-label={tPay("networkFeeInfo")}
                                />
                            </Tooltip>
                        </div>
                        <p>
                            <FormattedAmount
                                kind="token"
                                value={totalNetworkFee}
                                symbol={selectedToken.symbol}
                                tokenDecimals={selectedToken.decimals}
                                unitPriceUsd={selectedTokenData?.price}
                                profile="standard"
                                rounding="up"
                            />
                        </p>
                    </div>
                )}

                {/* Comment */}
                {!isValidatingAccounts && (
                    <div className="mb-2">
                        <Textarea
                            value={comment}
                            onChange={(e) =>
                                form.setValue("comment", e.target.value)
                            }
                            placeholder={tPay("commentPlaceholder")}
                            rows={3}
                            borderless
                            className="resize-none"
                            disabled={isSubmitting}
                        />
                    </div>
                )}

                {/* Submit Button */}
                {!isValidatingAccounts && (
                    <CreateRequestButton
                        type="button"
                        onClick={handleProceedClick}
                        disabled={
                            hasValidationErrors ||
                            isSubmitting ||
                            paymentData.length === 0 ||
                            // Confidential: only submit fees the user has seen.
                            (confidentialPrepare !== undefined &&
                                confidentialPrepare.status !== "success")
                        }
                        isSubmitting={isSubmitting || isFetchingNetworkFees}
                        permissions={[{ kind: "call", action: "AddProposal" }]}
                        idleMessage={tPay("confirmSubmit")}
                        loadingMessage={
                            isFetchingNetworkFees
                                ? tBulk("fetchingNetworkFees")
                                : tBulk("submittingProposal")
                        }
                    />
                )}
            </ReviewStep>

            {/* Remove Recipient Confirmation Dialog */}
            <Dialog
                open={removeDialogOpen && !isSubmitting}
                onOpenChange={(open) => {
                    if (isSubmitting) return;
                    setRemoveDialogOpen(open);
                }}
            >
                <DialogContent className="max-w-md gap-4">
                    <DialogHeader>
                        <DialogTitle className="text-left">
                            {tBulk("removeRecipient")}
                        </DialogTitle>
                    </DialogHeader>

                    <DialogDescription>
                        {recipientToRemove && (
                            <p className="text-base">
                                {tBulk.rich("removeRecipientConfirm", {
                                    recipient: recipientToRemove.recipient,
                                    strong: (chunks) => (
                                        <span className="font-semibold">
                                            {chunks}
                                        </span>
                                    ),
                                })}
                            </p>
                        )}
                    </DialogDescription>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="destructive"
                            className="w-full"
                            disabled={isSubmitting}
                            onClick={() =>
                                recipientToRemove &&
                                handleRemovePayment(recipientToRemove.index)
                            }
                        >
                            {tBulk("remove")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </PageCard>
    );
}
