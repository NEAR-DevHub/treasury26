"use client";

import { useState, useEffect } from "react";
import { useFormContext } from "react-hook-form";
import { useTranslations } from "next-intl";
import { PageCard } from "@/components/card";
import { Button } from "@/components/button";
import { Textarea } from "@/components/textarea";
import { Edit2, Info, Trash2 } from "lucide-react";
import { StepProps, ReviewStep } from "@/components/step-wizard";
import { TokenDisplay } from "@/components/token-display-with-network";
import Big from "@/lib/big";
import { getPaymentBalanceWarning } from "@/lib/intents-fee";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/modal";
import { NumberBadge } from "@/components/number-badge";
import type { BulkPaymentFormValues, BulkPaymentData } from "../schemas";
import { cn, formatBalance, formatTokenDisplayAmount } from "@/lib/utils";
import { validateAccountsAndStorage } from "../utils";
import { useBulkParsingLabels } from "../utils/use-parsing-labels";
import { useToken, useTokenBalance } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/hooks/use-treasury";
import { useAddressBook } from "@/features/address-book";
import { AmountSummary } from "@/components/amount-summary";
import { CreateRequestButton } from "@/components/create-request-button";
import { trackEvent } from "@/lib/analytics";
import { Tooltip } from "@/components/tooltip";
import { Address } from "@/components/address";

interface ReviewPaymentsStepProps extends StepProps {
    initialPaymentData: BulkPaymentData[];
    networkFeePerRecipient: string | null;
    onEditPayment: (index: number) => void;
    onPaymentDataChange: (data: BulkPaymentData[]) => void;
    onSubmit: () => void;
    isSubmitting?: boolean;
}

export function ReviewPaymentsStep({
    handleBack,
    initialPaymentData,
    networkFeePerRecipient,
    onEditPayment,
    onPaymentDataChange,
    onSubmit,
    isSubmitting = false,
}: ReviewPaymentsStepProps) {
    const tPay = useTranslations("payments");
    const tBulk = useTranslations("bulkPayment");
    const tIntents = useTranslations("intentsQuote");
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
    const { data: selectedTokenData } = useToken(selectedToken?.address || "");
    const { data: balance } = useTokenBalance(
        treasuryId,
        selectedToken?.address || "",
    );

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
        const updatedPayments = paymentData.filter((_, i) => i !== index);
        setPaymentData(updatedPayments);
        onPaymentDataChange(updatedPayments);
        setRemoveDialogOpen(false);
        setRecipientToRemove(null);
    };

    const handleRemoveClick = (index: number, recipient: string) => {
        setRecipientToRemove({ index, recipient });
        setRemoveDialogOpen(true);
    };

    const handleProceedClick = () => {
        if (isSubmitting) return;
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
    const feePerRecipient = networkFeePerRecipient
        ? Big(networkFeePerRecipient)
        : null;
    const totalNetworkFee = feePerRecipient
        ? feePerRecipient.mul(paymentData.length)
        : null;
    // Confidential bulk pads each leg by the estimated fee, so the DAO is
    // actually charged recipients + fees. Roll fees into the headline total
    // so the AmountSummary and balance check reflect reality.
    const totalAmount = totalNetworkFee
        ? recipientsTotal.add(totalNetworkFee)
        : recipientsTotal;

    // Calculate total USD value and check insufficient balance (amount + fees)
    let totalUSDValue = Big(0);
    let balanceWarning = null;

    if (balance) {
        try {
            const balanceBig = Big(balance);
            const balanceFormattedString = formatBalance(
                balanceBig.toString(),
                selectedToken.decimals,
            );
            const balanceFormattedBig = Big(balanceFormattedString);

            balanceWarning = getPaymentBalanceWarning({
                amount: totalAmount.toString(),
                balance: balanceFormattedBig,
                networkFee: totalNetworkFee ?? undefined,
                decimals: selectedToken.decimals,
                symbol: selectedToken.symbol,
            });

            // Calculate USD value only if price is available
            if (selectedTokenData?.price && balanceFormattedBig.gt(0)) {
                totalUSDValue = totalAmount.mul(selectedTokenData.price);
            }
        } catch (error) {
            console.error("Error calculating total USD value:", error);
        }
    }

    return (
        <PageCard className="max-w-[600px] mx-auto">
            <ReviewStep
                reviewingTitle={tPay("reviewYourPayment")}
                handleBack={handleBack}
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
                                                    <div className="h-5 w-48 bg-muted animate-pulse rounded" />
                                                </div>
                                                <div>
                                                    <div className="flex flex-col gap-2 items-end">
                                                        <div className="h-5 w-32 bg-muted animate-pulse rounded" />
                                                        <div className="h-4 w-20 bg-muted animate-pulse rounded" />
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
                                // Calculate estimated USD value
                                // balanceUSD is the total USD value of the token balance
                                // To get price per token: balanceUSD / (balance / 10^decimals)
                                // To get USD value of payment: amount * pricePerToken
                                let estimatedUSDValue = 0;
                                if (selectedTokenData?.price && balance) {
                                    try {
                                        const balanceBig = Big(balance);
                                        const balanceFormatted = Number(
                                            formatBalance(
                                                balanceBig.toString(),
                                                selectedToken.decimals,
                                            ),
                                        );
                                        if (balanceFormatted > 0) {
                                            estimatedUSDValue =
                                                Number(payment.amount) *
                                                selectedTokenData.price;
                                        }
                                    } catch (error) {
                                        console.error(
                                            "Error calculating USD value:",
                                            error,
                                        );
                                        estimatedUSDValue = 0;
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
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-start justify-between gap-3 mb-2">
                                                    <div className="flex flex-col gap-2 justify-between min-w-0 flex-1 lg:flex-auto">
                                                        <div className="flex flex-col gap-0.5">
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
                                                                            <span className="font-semibold text-sm text-foreground">
                                                                                {
                                                                                    contact.name
                                                                                }
                                                                            </span>
                                                                        )}

                                                                        <Address
                                                                            address={
                                                                                payment.recipient
                                                                            }
                                                                            className={cn(
                                                                                contact
                                                                                    ? "text-xs text-muted-foreground"
                                                                                    : "font-semibold text-sm text-foreground",
                                                                            )}
                                                                        />
                                                                    </>
                                                                );
                                                            })()}
                                                        </div>
                                                        {payment.validationError && (
                                                            <div className="text-xs text-red-600 dark:text-red-400 mb-2">
                                                                {
                                                                    payment.validationError
                                                                }
                                                            </div>
                                                        )}
                                                    </div>

                                                    <div className="shrink-0">
                                                        <div className="flex flex-col gap-2 items-end">
                                                            <div className="flex items-center gap-2">
                                                                <TokenDisplay
                                                                    symbol={
                                                                        selectedToken.symbol
                                                                    }
                                                                    icon={
                                                                        selectedToken.icon ||
                                                                        ""
                                                                    }
                                                                    chainIcons={
                                                                        selectedToken.chainIcons
                                                                    }
                                                                    iconSize="md"
                                                                />
                                                                <div className="text-right">
                                                                    <div className="text-sm font-semibold whitespace-nowrap">
                                                                        {formatTokenDisplayAmount(
                                                                            payment.amount,
                                                                        )}{" "}
                                                                        {
                                                                            selectedToken.symbol
                                                                        }
                                                                    </div>
                                                                    <div className="text-xs text-muted-foreground whitespace-nowrap">
                                                                        ≈ $
                                                                        {estimatedUSDValue.toFixed(
                                                                            2,
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center gap-3 justify-end">
                                                                <Button
                                                                    variant="unstyled"
                                                                    size="sm"
                                                                    className="text-muted-foreground hover:text-foreground px-0!"
                                                                    onClick={() =>
                                                                        onEditPayment(
                                                                            index,
                                                                        )
                                                                    }
                                                                >
                                                                    <Edit2 className="w-4 h-4" />{" "}
                                                                    {tBulk(
                                                                        "edit",
                                                                    )}
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
                                                                >
                                                                    <Trash2 className="w-4 h-4" />{" "}
                                                                    {tBulk(
                                                                        "remove",
                                                                    )}
                                                                </Button>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </>
                    )}
                </div>

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
                            {formatTokenDisplayAmount(totalNetworkFee)}{" "}
                            {selectedToken.symbol}
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
                        />
                    </div>
                )}

                {/* Submit Button */}
                {!isValidatingAccounts && (
                    <CreateRequestButton
                        type="button"
                        onClick={handleProceedClick}
                        disabled={hasValidationErrors || isSubmitting}
                        isSubmitting={isSubmitting}
                        permissions={[{ kind: "call", action: "AddProposal" }]}
                        idleMessage={tPay("confirmSubmit")}
                        loadingMessage={tBulk("submittingProposal")}
                    />
                )}
            </ReviewStep>

            {/* Remove Recipient Confirmation Dialog */}
            <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
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
