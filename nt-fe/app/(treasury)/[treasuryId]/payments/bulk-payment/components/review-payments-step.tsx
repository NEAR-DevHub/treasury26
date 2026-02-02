"use client";

import { useState, useEffect } from "react";
import { useFormContext } from "react-hook-form";
import { PageCard } from "@/components/card";
import { Button } from "@/components/button";
import { Textarea } from "@/components/textarea";
import { Edit2, Trash2 } from "lucide-react";
import { StepProps, ReviewStep } from "@/components/step-wizard";
import { WarningAlert } from "@/components/warning-alert";
import Big from "big.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/modal";
import type { BulkPaymentFormValues, BulkPaymentData } from "../schemas";
import { formatBalance } from "@/lib/utils";
import { availableBalance } from "@/lib/balance";
import { validateAccountsAndStorage } from "../utils";

interface ReviewPaymentsStepProps extends StepProps {
  initialPaymentData: BulkPaymentData[];
  onEditPayment: (index: number) => void;
  onPaymentDataChange: (data: BulkPaymentData[]) => void;
  onSubmit: () => void;
}

export function ReviewPaymentsStep({
  handleBack,
  initialPaymentData,
  onEditPayment,
  onPaymentDataChange,
  onSubmit,
}: ReviewPaymentsStepProps) {
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

  // Validate accounts on mount
  useEffect(() => {
    if (!selectedToken || validationComplete || paymentData.length === 0)
      return;

    const validateAccounts = async () => {
      setIsValidatingAccounts(true);
      try {
        const validatedPayments = await validateAccountsAndStorage(
          paymentData,
          selectedToken
        );
        setPaymentData(validatedPayments);
        onPaymentDataChange(validatedPayments);
        setValidationComplete(true);
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

  if (!selectedToken) {
    return null;
  }

  const totalAmount = paymentData.reduce(
    (sum, item) => sum + Number(item.amount || 0),
    0
  );

  const hasUnregisteredRecipients = paymentData.some(
    (payment) => payment.isRegistered === false
  );

  const hasValidationErrors = paymentData.some(
    (payment) => payment.validationError
  );

  // Calculate total USD value and check insufficient balance
  let totalUSDValue = 0;
  let hasInsufficientBalance = false;
  
  if (selectedToken?.balance) {
    try {
      const balanceBig = availableBalance(selectedToken.balance);
      const balanceFormattedString = formatBalance(
        balanceBig.toString(),
        selectedToken.decimals
      );
      const balanceFormattedBig = Big(balanceFormattedString);
      
      hasInsufficientBalance = Big(totalAmount).gt(balanceFormattedBig);
      
      // Calculate USD value only if price is available
      if (selectedToken?.balanceUSD && balanceFormattedBig.gt(0)) {
        const pricePerToken = selectedToken.balanceUSD / Number(balanceFormattedString);
        totalUSDValue = totalAmount * pricePerToken;
      }
    } catch (error) {
      console.error("Error calculating total USD value:", error);
      totalUSDValue = 0;
    }
  }

  return (
    <PageCard>
      <ReviewStep reviewingTitle="Review Your Payment" handleBack={handleBack}>
        {/* Total Summary */}
        <div className="px-3.5 py-3 rounded-xl bg-muted">
          <div className="flex flex-col gap-2 p-2 text-xs text-muted-foreground text-center justify-center items-center">
            <p>You are sending a total of</p>
            <img
              src={selectedToken.icon || ""}
              alt={selectedToken.symbol}
              className="size-10 shrink-0 rounded-full"
            />
            <p className="text-foreground">
              <span className="text-xl font-semibold">
                {totalAmount} {selectedToken.symbol}
              </span>

              {totalUSDValue > 0 && (
                <p className="text-sm text-muted-foreground">
                  ≈ ${totalUSDValue.toFixed(2)} USD
                </p>
              )}
            </p>

            {hasInsufficientBalance && (
              <p className="text-general-info-foreground text-sm">
                Insufficient tokens. You can submit the request and top up before approval.
              </p>
            )}

            <div>
              <p>
                to {paymentData.length} recipient
                {paymentData.length !== 1 ? "s" : ""}
              </p>
            </div>
          </div>
        </div>

        {/* Recipients List */}
        <div className="space-y-4 mb-2">
          <h3 className="text-sm text-muted-foreground mb-6">Recipients</h3>

          {isValidatingAccounts ? (
            // Loading skeleton while validating
            <>
              {paymentData.map((_, index) => (
                <div key={index} className="space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="flex items-center justify-center w-6 h-6 rounded-full text-sm font-semibold shrink-0 bg-secondary text-foreground">
                      {index + 1}
                    </div>
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
                if (selectedToken?.balanceUSD && selectedToken.balance) {
                  try {
                    const balanceBig = availableBalance(selectedToken.balance);
                    const balanceFormatted = Number(
                      formatBalance(
                        balanceBig.toString(),
                        selectedToken.decimals
                      )
                    );
                    if (balanceFormatted > 0) {
                      const pricePerToken =
                        selectedToken.balanceUSD / balanceFormatted;
                      estimatedUSDValue =
                        Number(payment.amount) * pricePerToken;
                    }
                  } catch (error) {
                    console.error("Error calculating USD value:", error);
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
                      <div
                        className={`flex items-center justify-center w-6 h-6 rounded-full text-sm font-semibold shrink-0 ${
                          payment.validationError
                            ? "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"
                            : "bg-secondary text-foreground"
                        }`}
                      >
                        {index + 1}
                      </div>
                      <div className="flex-1">
                        <div className="flex justify-between mb-2">
                          <div className="flex flex-col gap-2 justify-between">
                            <div className="flex gap-2">
                              <span className="font-semibold text-sm text-foreground">
                                {payment.recipient}
                              </span>
                              {payment.isRegistered === false &&
                                !payment.validationError && (
                                  <span className="px-2 py-1 text-xs font-medium bg-general-warning-background-faded text-general-warning-foreground rounded-full">
                                    Unregistered
                                  </span>
                                )}
                            </div>
                            {payment.validationError && (
                              <div className="text-xs text-red-600 dark:text-red-400 mb-2">
                                {payment.validationError}
                              </div>
                            )}
                          </div>

                          <div>
                            <div className="flex flex-col gap-2 items-end">
                              <div className="flex items-center gap-2">
                                <img
                                  src={selectedToken.icon || ""}
                                  alt={selectedToken.symbol}
                                  className="w-5 h-5 rounded-full"
                                />
                                <div className="text-right">
                                  <div className="text-sm font-semibold">
                                    {payment.amount} {selectedToken.symbol}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    ≈ ${estimatedUSDValue.toFixed(2)}
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center gap-3 justify-end">
                                <Button
                                  variant="unstyled"
                                  size="sm"
                                  className="text-muted-foreground hover:text-foreground px-0!"
                                  onClick={() => onEditPayment(index)}
                                >
                                  <Edit2 className="w-4 h-4" /> Edit
                                </Button>
                                <Button
                                  variant="unstyled"
                                  size="sm"
                                  className="text-muted-foreground hover:text-foreground px-0!"
                                  onClick={() =>
                                    handleRemoveClick(index, payment.recipient)
                                  }
                                >
                                  <Trash2 className="w-4 h-4" /> Remove
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

        {/* Comment */}
        {!isValidatingAccounts && (
          <div className="mb-2">
            <Textarea
              value={comment}
              onChange={(e) => form.setValue("comment", e.target.value)}
              placeholder="Add a comment (optional)..."
              rows={3}
              className="resize-none"
            />
          </div>
        )}

        {/* Storage Deposit Warning */}
        {!isValidatingAccounts && hasUnregisteredRecipients && (
          <WarningAlert
            className="mb-2"
            message={
              <div>
                <h4 className="font-semibold">Storage Deposit Required</h4>
                <p>
                  A one-time gas fee of 0.0125 NEAR per{" "}
                  <span className="font-semibold">1 recipient</span> is required
                  to create their payment contract. You can pay now or continue
                  without these recipients.
                </p>
              </div>
            }
          />
        )}

        {/* Submit Button */}
        {!isValidatingAccounts && (
          <Button
            type="button"
            className="w-full"
            size="lg"
            onClick={onSubmit}
            disabled={hasValidationErrors}
          >
            Confirm and Submit Request
          </Button>
        )}
      </ReviewStep>

      {/* Remove Recipient Confirmation Dialog */}
      <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <DialogContent className="max-w-md gap-4">
          <DialogHeader>
            <DialogTitle className="text-left">Remove Recipient</DialogTitle>
          </DialogHeader>

          <DialogDescription>
            {recipientToRemove && (
              <p className="text-base">
                Are you sure you want to remove the payment to{" "}
                <span className="font-semibold">
                  {recipientToRemove.recipient}
                </span>
                ? This action cannot be undone.
              </p>
            )}
          </DialogDescription>
          <DialogFooter>
            <Button
              type="button"
              variant="destructive"
              className="w-full"
              size="lg"
              onClick={() =>
                recipientToRemove &&
                handleRemovePayment(recipientToRemove.index)
              }
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageCard>
  );
}
