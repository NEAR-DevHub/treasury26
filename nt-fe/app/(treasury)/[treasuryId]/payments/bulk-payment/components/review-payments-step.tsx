"use client";

import {
    Delete01Icon,
    Edit03Icon,
    HelpCircleIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useFormContext } from "react-hook-form";
import { toast } from "sonner";
import { Address } from "@/components/address";
import { AmountSummary } from "@/components/amount-summary";
import { Button } from "@/components/button";
import { CreateRequestButton } from "@/components/create-request-button";
import { FormattedAmount } from "@/components/formatted-amount";
import { Icon } from "@/components/icon";
import { Input } from "@/components/input";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    mobileInsetSheetClassName,
} from "@/components/modal";
import { ReviewPaymentsSkeleton } from "@/components/review-payments-skeleton";
import { ReviewStep, type StepProps } from "@/components/step-wizard";
import { getNetworkDisplayName } from "@/components/token-display";
import { TokenDisplay } from "@/components/token-display-with-network";
import { Tooltip } from "@/components/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { NEAR_COM_NETWORK_ID } from "@/constants/network-ids";
import { useTokenCatalog } from "@/hooks/use-bridge-tokens";
import { useTreasury } from "@/hooks/use-treasury";
import { useToken, useTokenBalance } from "@/hooks/use-treasury-queries";
import { decimalFromBaseUnits, decimalOrNull } from "@/lib/amount-format";
import { trackEvent } from "@/lib/analytics";
import Big from "@/lib/big";
import {
    formatShortAddress,
    SHORT_ADDRESS_PREFIX_LENGTH,
    SHORT_ADDRESS_SUFFIX_LENGTH,
} from "@/lib/format-short-address";
import { getPaymentBalanceWarning } from "@/lib/intents-fee";
import {
    getNearComChainIcons,
    getNetworkDisplayCaseClass,
    isNearComNetwork,
} from "@/lib/intents-network";
import {
    formatRecipientForNearComDestination,
    hasNearComAddressPrefix,
} from "@/lib/nearcom-address";
import { cn } from "@/lib/utils";
import type { BulkPaymentData, BulkPaymentFormValues } from "../schemas";
import { validateAccountsAndStorage } from "../utils";
import type { QuoteFees } from "../utils/confidential-prepare";

const helpTooltipTriggerClass =
    "inline-flex text-card [&_circle]:fill-general-muted-foreground [&_circle]:stroke-general-muted-foreground hover:[&_circle]:fill-general-secondary-foreground hover:[&_circle]:stroke-general-secondary-foreground";

function HelpTooltip({
    content,
    label,
}: {
    content: ReactNode;
    label: string;
}) {
    return (
        <Tooltip
            content={content}
            side="top"
            contentProps={{ className: "max-w-72" }}
        >
            <button
                type="button"
                className={helpTooltipTriggerClass}
                aria-label={label}
            >
                <Icon icon={HelpCircleIcon} className="size-3.5" />
            </button>
        </Tooltip>
    );
}

interface ReviewPaymentsStepProps extends StepProps {
    initialPaymentData: BulkPaymentData[];
    networkFeePerRecipient: string | null;
    onEditPayment: (index: number) => void;
    onPaymentDataChange: (data: BulkPaymentData[]) => void;
    onSubmit: () => void;
    isSubmitting?: boolean;
    /**
     * Confidential flow: selected receive-network id (bridge asset network id
     * or near.com). Drives the top-level send summary badge and the
     * destination-network row.
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
    const tPay = useTranslations("payments");
    const tBulk = useTranslations("bulkPayment");
    const tIntents = useTranslations("intentsQuote");
    const tCommon = useTranslations("common");
    const form = useFormContext<BulkPaymentFormValues>();
    const selectedToken = form.watch("selectedToken");
    const comment = form.watch("comment");

    const [paymentData, setPaymentData] =
        useState<BulkPaymentData[]>(initialPaymentData);
    const [isValidatingAccounts, setIsValidatingAccounts] = useState(
        initialPaymentData.length > 0,
    );
    const [validationComplete, setValidationComplete] = useState(false);
    const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
    const [recipientToRemove, setRecipientToRemove] = useState<{
        index: number;
        recipient: string;
    } | null>(null);

    const { treasuryId } = useTreasury();
    const { data: bridgeAssets = [] } = useTokenCatalog({ kind: "swap" });
    const { data: selectedTokenData } = useToken(selectedToken?.address || "");
    const { data: balance } = useTokenBalance(
        treasuryId,
        selectedToken?.address || "",
    );

    const receiveNetworkId = destinationNetworkId || selectedToken?.network;
    const receiveNetworkName = destinationNetworkName || selectedToken?.network;

    // Receive-network icons for the destination row — confidential uses the
    // selected receive chain; public bulk falls back to the source token.
    const destinationChainIcons = useMemo(() => {
        if (!receiveNetworkId) {
            return selectedToken?.chainIcons;
        }
        if (isNearComNetwork(receiveNetworkId)) {
            return getNearComChainIcons();
        }
        for (const asset of bridgeAssets) {
            const network = asset.networks.find(
                (n) => n.id === receiveNetworkId,
            );
            if (network?.chainIcons) return network.chainIcons;
        }
        return selectedToken?.chainIcons;
    }, [bridgeAssets, receiveNetworkId, selectedToken?.chainIcons]);

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

    const isReviewLoading =
        isValidatingAccounts ||
        (confidentialPrepare !== undefined &&
            !confidentialPrepare.outOfCredits &&
            (confidentialPrepare.status === "loading" ||
                confidentialPrepare.status === "idle"));

    if (isReviewLoading) {
        return (
            <div
                className="flex w-full min-w-0 max-w-lg mx-auto flex-col gap-6"
                aria-busy="true"
            >
                <ReviewStep
                    reviewingTitle={tPay("reviewYourPayment")}
                    handleBack={handleBack}
                    backDisabled={isSubmitting}
                >
                    <ReviewPaymentsSkeleton
                        recipientCount={paymentData.length}
                    />
                </ReviewStep>
                <Skeleton className="h-11 w-full rounded-2xl" />
            </div>
        );
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
    let totalUSDValue: Big | null = null;
    let balanceWarning = null;

    if (balance) {
        try {
            const balanceFormattedBig = decimalFromBaseUnits(
                Big(balance),
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
            });
        } catch (error) {
            console.error("Error calculating balance warning:", error);
        }
    }

    if (selectedTokenData?.price && totalAmount.gt(0)) {
        try {
            totalUSDValue = totalAmount.mul(selectedTokenData.price);
        } catch (error) {
            console.error("Error calculating total USD value:", error);
        }
    }

    const destinationNetworkLabel = receiveNetworkId
        ? getNetworkDisplayName(receiveNetworkName || receiveNetworkId)
        : null;

    return (
        <div className="flex w-full min-w-0 max-w-lg mx-auto flex-col gap-6">
            <ReviewStep
                reviewingTitle={tPay("reviewYourPayment")}
                handleBack={handleBack}
                backDisabled={isSubmitting}
            >
                <AmountSummary
                    total={totalAmount}
                    totalUSD={totalUSDValue}
                    token={selectedToken}
                    title=""
                    showNetworkIcon={true}
                />
                {balanceWarning && (
                    <p className="text-sm font-normal text-general-info-foreground">
                        {balanceWarning.type === "fee_not_covered"
                            ? tBulk("insufficientTokensForFee", {
                                  fee: balanceWarning.formattedFee ?? "",
                                  symbol: balanceWarning.symbol ?? "",
                              })
                            : tBulk("insufficientTokens")}
                    </p>
                )}

                <div className="flex w-full flex-col gap-4 mt-2">
                    {paymentData.map((payment, index) => {
                        const recipientFee = getRecipientFee(index);
                        const displayAmount = getRecipientDisplayAmount(
                            index,
                            payment.amount,
                        );
                        const recipientAmount = decimalOrNull(displayAmount);
                        const estimatedUSDValue =
                            selectedTokenData?.price && recipientAmount?.gt(0)
                                ? recipientAmount.mul(selectedTokenData.price)
                                : null;

                        return (
                            <div
                                key={index}
                                className="flex flex-col gap-2 border-b border-general-border pb-4"
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <p className="text-sm font-medium leading-normal text-general-secondary-foreground">
                                        {tPay("recipientLabel")} {index + 1}
                                    </p>
                                    <div className="flex items-center gap-3">
                                        <Button
                                            type="button"
                                            variant="unstyled"
                                            size="icon-sm"
                                            className="size-auto text-general-secondary-foreground hover:text-general-foreground"
                                            onClick={() =>
                                                handleEditClick(index)
                                            }
                                            disabled={isSubmitting}
                                            aria-label={tBulk("edit")}
                                        >
                                            <Icon
                                                icon={Edit03Icon}
                                                className="size-[0.82813rem] shrink-0"
                                            />
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="unstyled"
                                            size="icon-sm"
                                            className="size-auto text-general-secondary-foreground hover:text-general-foreground"
                                            onClick={() =>
                                                handleRemoveClick(
                                                    index,
                                                    payment.recipient,
                                                )
                                            }
                                            disabled={isSubmitting}
                                            aria-label={tBulk("remove")}
                                        >
                                            <Icon
                                                icon={Delete01Icon}
                                                className="size-[0.82813rem] shrink-0"
                                            />
                                        </Button>
                                    </div>
                                </div>
                                <div className="flex w-full items-start justify-between gap-2">
                                    <div className="flex min-w-0 flex-col gap-0.5">
                                        <Address
                                            address={formatRecipientForNearComDestination(
                                                payment.recipient,
                                                hasNearComAddressPrefix(
                                                    payment.recipient,
                                                )
                                                    ? NEAR_COM_NETWORK_ID
                                                    : destinationNetworkId,
                                            )}
                                            prefixLength={
                                                SHORT_ADDRESS_PREFIX_LENGTH
                                            }
                                            suffixLength={
                                                SHORT_ADDRESS_SUFFIX_LENGTH
                                            }
                                            className="min-w-0 text-sm font-semibold leading-normal text-general-foreground"
                                        />
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1.5">
                                        <TokenDisplay
                                            symbol={selectedToken.symbol}
                                            icon={selectedToken.icon || ""}
                                            iconSize="lg"
                                            className="shrink-0"
                                        />
                                        <div className="flex flex-col items-end gap-0.5 text-right">
                                            <span className="inline-flex items-center gap-1.5 text-sm font-semibold leading-normal text-general-foreground">
                                                {recipientAmount ? (
                                                    <FormattedAmount
                                                        kind="token"
                                                        value={recipientAmount}
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
                                                ) : (
                                                    "—"
                                                )}
                                                {recipientFee ? (
                                                    <HelpTooltip
                                                        label={tPay(
                                                            "networkFeeInfo",
                                                        )}
                                                        content={
                                                            <div className="text-left">
                                                                <p>
                                                                    <FormattedAmount
                                                                        kind="token"
                                                                        value={
                                                                            recipientAmount
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
                                                                    />{" "}
                                                                    +{" "}
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
                                                    />
                                                ) : null}
                                            </span>
                                            {estimatedUSDValue ? (
                                                <p className="whitespace-nowrap text-xs font-normal leading-4 tracking-[0.01125rem] text-general-secondary-foreground">
                                                    ≈{" "}
                                                    <FormattedAmount
                                                        kind="fiat"
                                                        value={
                                                            estimatedUSDValue
                                                        }
                                                    />
                                                </p>
                                            ) : null}
                                        </div>
                                    </div>
                                </div>
                                {payment.validationError ? (
                                    <div className="text-xs text-red-600 dark:text-red-400">
                                        {payment.validationError}
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}

                    {destinationNetworkLabel ? (
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium leading-normal text-general-secondary-foreground">
                                {tPay("destinationNetwork")}
                            </p>
                            <div className="flex items-center gap-1.5">
                                {destinationChainIcons?.icon ? (
                                    <img
                                        src={destinationChainIcons.icon}
                                        alt=""
                                        className="size-5 shrink-0 overflow-hidden rounded-full object-cover aspect-square"
                                    />
                                ) : null}
                                <span
                                    className={cn(
                                        "text-sm font-semibold leading-normal text-general-foreground",
                                        getNetworkDisplayCaseClass(
                                            destinationNetworkLabel,
                                        ),
                                    )}
                                >
                                    {destinationNetworkLabel}
                                </span>
                            </div>
                        </div>
                    ) : null}

                    {confidentialPrepare?.outOfCredits && (
                        <div className="flex items-center justify-between gap-2 text-sm">
                            <p className="text-red-600 dark:text-red-400">
                                {tBulk("upload.bulkPaymentsUsed")}
                            </p>
                        </div>
                    )}

                    {!confidentialPrepare?.outOfCredits &&
                        confidentialPrepare?.status === "error" && (
                            <div className="flex items-center justify-between gap-2 text-sm">
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

                    {totalNetworkFee && (
                        <div className="flex items-center justify-between gap-2 text-sm">
                            <span className="inline-flex items-center gap-1 text-sm font-medium leading-[1.3125rem] text-general-secondary-foreground">
                                {tPay("networkFee")}
                                <HelpTooltip
                                    content={tIntents("networkFeeTooltip")}
                                    label={tPay("networkFeeInfo")}
                                />
                            </span>
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

                    <Input
                        value={comment}
                        onChange={(e) =>
                            form.setValue("comment", e.target.value)
                        }
                        placeholder={tPay("commentPlaceholder")}
                        inputClassName="h-11 rounded-xl border border-general-border bg-general-bg-tertiary! hover:bg-general-bg-tertiary! focus-visible:border-general-border focus-visible:ring-0"
                        disabled={isSubmitting}
                    />
                </div>
            </ReviewStep>

            <CreateRequestButton
                type="button"
                className="w-full h-11 rounded-2xl"
                onClick={handleProceedClick}
                disabled={
                    hasValidationErrors ||
                    isSubmitting ||
                    paymentData.length === 0 ||
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

            <Dialog
                open={removeDialogOpen && !isSubmitting}
                onOpenChange={(open) => {
                    if (isSubmitting) return;
                    setRemoveDialogOpen(open);
                }}
            >
                <DialogContent
                    className={cn(
                        mobileInsetSheetClassName,
                        "gap-2 max-sm:gap-4 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:max-w-md!",
                    )}
                >
                    <DialogHeader className="mx-0 border-0 px-0 pb-0 [&>div]:min-w-0 [&>div]:flex-1">
                        <DialogTitle className="min-w-0 text-left text-xl font-bold leading-[1.2] tracking-[-0.4px]">
                            {recipientToRemove
                                ? tBulk("removeRecipient", {
                                      recipient: formatShortAddress(
                                          formatRecipientForNearComDestination(
                                              recipientToRemove.recipient,
                                              hasNearComAddressPrefix(
                                                  recipientToRemove.recipient,
                                              )
                                                  ? NEAR_COM_NETWORK_ID
                                                  : destinationNetworkId,
                                          ),
                                      ),
                                  })
                                : null}
                        </DialogTitle>
                    </DialogHeader>
                    <DialogDescription className="text-sm font-medium text-general-secondary-foreground">
                        {tBulk("removeRecipientConfirm")}
                    </DialogDescription>
                    <DialogFooter className="mx-0 px-0 pt-0">
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
        </div>
    );
}
