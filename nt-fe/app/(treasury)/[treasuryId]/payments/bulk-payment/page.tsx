"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useForm, FormProvider } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/hooks/use-treasury";
import { useNear } from "@/stores/near-store";
import { toast } from "sonner";
import Big from "big.js";
import { PageComponentLayout } from "@/components/page-component-layout";
import {
  UploadDataStep,
  ReviewPaymentsStep,
  EditPaymentStep,
} from "./components";
import { needsStorageDepositCheck } from "./utils";
import {
  bulkPaymentFormSchema,
  type BulkPaymentFormValues,
  type BulkPaymentData,
  type EditPaymentFormValues,
} from "./schemas";
import {
  generateListId,
  submitPaymentList,
  buildApproveListProposal,
  BULK_PAYMENT_CONTRACT_ID,
} from "@/lib/bulk-payment-api";
import { getBatchStorageDepositIsRegistered } from "@/lib/api";
import { encodeToMarkdown } from "@/lib/utils";
import { NEAR_TOKEN } from "@/constants/token";
import { BulkPaymentToast } from "../components/bulk-payment-toast";

export default function BulkPaymentPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { treasuryId: selectedTreasury } = useTreasury();
  const { createProposal } = useNear();
  const { data: policy } = useTreasuryPolicy(selectedTreasury);

  const [step, setStep] = useState(0);

  const form = useForm<BulkPaymentFormValues>({
    resolver: zodResolver(bulkPaymentFormSchema),
    defaultValues: {
      selectedToken: null,
      comment: "",
      csvData: null,
      pasteDataInput: "",
      activeTab: "upload",
    },
  });

  const selectedToken = form.watch("selectedToken");
  const comment = form.watch("comment");

  const [paymentData, setPaymentData] = useState<BulkPaymentData[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  // Handle continue from upload step
  const handleContinueFromUpload = (payments: BulkPaymentData[]) => {
    setPaymentData(payments);
    setStep(1); // Move to review step
  };

  // Handle edit payment
  const handleEditPayment = (index: number) => {
    setEditingIndex(index);
    setStep(2); // Move to edit step
  };

  // Handle save edit
  const handleSaveEdit = (
    index: number,
    data: EditPaymentFormValues,
    isRegistered: boolean
  ) => {
    const updatedPayments = [...paymentData];
    updatedPayments[index] = {
      ...updatedPayments[index],
      recipient: data.recipient,
      amount: data.amount,
      validationError: undefined,
      isRegistered,
    };
    setPaymentData(updatedPayments);

    // Go back to review step
    setStep(1);
    setEditingIndex(null);
  };

  // Handle cancel edit
  const handleCancelEdit = () => {
    setStep(1);
    setEditingIndex(null);
  };

  // Handle submission
  const onSubmit = async () => {
    if (!selectedTreasury || paymentData.length === 0 || !selectedToken) return;

    const totalAmount = paymentData.reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0
    );

    let loadingToastId: string | number | undefined;

    try {
      // Show loading toast
      loadingToastId = toast(
        <BulkPaymentToast
          steps={[
            { label: "Submitting proposal", status: "loading" },
            { label: "Submitting bulk payment list", status: "pending" },
          ]}
        />,
        {
          duration: Infinity,
          classNames: {
            toast: "!p-3",
          },
        }
      );

      const proposalBond = policy?.proposal_bond || "0";

      // Determine token IDs
      const isNEAR =
        selectedToken.id === NEAR_TOKEN.address &&
        selectedToken.residency.toLowerCase() === "near";

      const tokenIdForHash = isNEAR ? "native" : selectedToken.id;
      const tokenIdForProposal = selectedToken.id;

      // Convert amounts to smallest units
      const payments = paymentData.map((payment) => ({
        recipient: payment.recipient,
        amount: Big(payment.amount || "0")
          .times(Big(10).pow(selectedToken.decimals))
          .toFixed(),
      }));

      // Generate list_id
      const listId = await generateListId(
        selectedTreasury,
        tokenIdForHash,
        payments
      );

      // Build proposal description
      const description = encodeToMarkdown({
        proposal_action: "bulk-payment",
        title: comment || "Bulk Payment Request",
        recipients: paymentData.length,
        contract: selectedToken.symbol,
        amount: totalAmount.toFixed(),
        list_id: listId,
      });

      // Build proposal
      const totalAmountInSmallestUnits = Big(totalAmount)
        .times(Big(10).pow(selectedToken.decimals))
        .toFixed();

      const proposal = await buildApproveListProposal({
        daoAccountId: selectedTreasury,
        listId,
        tokenId: tokenIdForProposal,
        tokenResidency: selectedToken.residency as "Near" | "Ft" | "Intents",
        totalAmount: totalAmountInSmallestUnits,
        description,
        proposalBond,
      });

      // Build storage deposit transactions
      const additionalTransactions: any[] = [];
      if (needsStorageDepositCheck(selectedToken)) {
        const gas = "30000000000000";
        const depositInYocto = Big(0.0125).mul(Big(10).pow(24)).toFixed();

        // Check if bulk payment contract is registered
        const bulkPaymentContractRegistration =
          await getBatchStorageDepositIsRegistered([
            {
              accountId: BULK_PAYMENT_CONTRACT_ID,
              tokenId: selectedToken.id,
            },
          ]);

        const isBulkPaymentContractRegistered =
          bulkPaymentContractRegistration.length > 0 &&
          bulkPaymentContractRegistration[0].is_registered;

        // Add storage deposit for bulk payment contract if needed
        if (!isBulkPaymentContractRegistered) {
          additionalTransactions.push({
            receiverId: selectedToken.id,
            actions: [
              {
                type: "FunctionCall",
                params: {
                  methodName: "storage_deposit",
                  args: {
                    account_id: BULK_PAYMENT_CONTRACT_ID,
                    registration_only: true,
                  } as any,
                  gas,
                  deposit: depositInYocto,
                },
              } as any,
            ],
          });
        }

        // Add storage deposits for unregistered recipients
        const unregisteredRecipients = paymentData.filter(
          (payment) =>
            payment.isRegistered === false && !payment.validationError
        );

        for (const payment of unregisteredRecipients) {
          additionalTransactions.push({
            receiverId: selectedToken.id,
            actions: [
              {
                type: "FunctionCall",
                params: {
                  methodName: "storage_deposit",
                  args: {
                    account_id: payment.recipient,
                    registration_only: true,
                  } as any,
                  gas,
                  deposit: depositInYocto,
                },
              } as any,
            ],
          });
        }
      }

      // Create proposal
      const proposalResults = await createProposal(
        "Bulk payment proposal submitted",
        {
          treasuryId: selectedTreasury,
          proposal: {
            description: proposal.args.proposal.description,
            kind: proposal.args.proposal.kind,
          },
          proposalBond,
          additionalTransactions,
        },
        false
      );

      // Submit payment list if proposal creation was successful
      if (proposalResults && proposalResults.length > 0) {
        // Update toast
        toast(
          <BulkPaymentToast
            steps={[
              { label: "Submitting proposal", status: "completed" },
              { label: "Submitting bulk payment list", status: "loading" },
            ]}
          />,
          {
            id: loadingToastId,
            duration: Infinity,
            classNames: {
              toast: "!p-3",
            },
          }
        );

        // Submit payment list to backend
        try {
          const submitResult = await submitPaymentList({
            listId,
            submitterId: selectedTreasury,
            daoContractId: selectedTreasury,
            tokenId: tokenIdForHash,
            payments,
          });

          if (!submitResult.success) {
            throw new Error(
              submitResult.error || "Failed to submit payment list"
            );
          }

          // Dismiss loading toast
          toast.dismiss(loadingToastId);

          // Show success toast
          toast.success("Bulk Payment Request submitted", {
            duration: 10000,
            action: {
              label: "View Request",
              onClick: () =>
                router.push(`/${selectedTreasury}/requests?tab=pending`),
            },
            classNames: {
              toast: "!p-2 !px-4",
              actionButton:
                "!bg-transparent !text-foreground hover:!bg-muted !border-0",
              title: "!border-r !border-r-border !pr-4",
            },
          });

          // Invalidate credits query to refetch in UploadDataStep
          await queryClient.invalidateQueries({
            queryKey: ["bulkPaymentCredits", selectedTreasury],
          });

          // Reset form and state
          form.reset();
          setStep(0);
          setPaymentData([]);
        } catch (error) {
          console.error("Failed to submit payment list to backend:", error);
          toast.dismiss(loadingToastId);
          toast.error(
            error instanceof Error
              ? error.message
              : "Failed to submit bulk payment list"
          );
          return; // Stop execution here
        }
      } else {
        // Proposal creation failed - createProposal already shows error toast
        toast.dismiss(loadingToastId);
      }
    } catch (error) {
      // Only show error if it's not a wallet rejection (createProposal handles those)
      console.error("Failed to submit bulk payment:", error);
      if (loadingToastId) {
        toast.dismiss(loadingToastId);
      }
      // Don't show additional error toast as createProposal already handles user rejections
    }
  };

  // Editing a single payment
  if (editingIndex !== null && step === 2 && selectedToken) {
    const payment = paymentData[editingIndex];
    return (
      <PageComponentLayout
        title="Payments"
        description="Send and receive funds securely"
      >
        <div className="w-full max-w-3xl mx-auto px-4">
          <EditPaymentStep
            handleBack={handleCancelEdit}
            payment={payment}
            paymentIndex={editingIndex}
            selectedToken={selectedToken}
            onSave={handleSaveEdit}
            onCancel={handleCancelEdit}
          />
        </div>
      </PageComponentLayout>
    );
  }

  return (
    <PageComponentLayout
      title="Payments"
      description="Send and receive funds securely"
    >
      <FormProvider {...form}>
        <div className={`w-full mx-auto px-4 ${step === 1 ? 'max-w-3xl' : 'max-w-7xl'}`}>
          {/* Step 0: Upload Data */}
          {step === 0 && (
            <UploadDataStep
              handleBack={() => router.back()}
              treasuryId={selectedTreasury || ""}
              onContinue={handleContinueFromUpload}
            />
          )}

          {/* Step 1: Review Payments */}
          {step === 1 && (
            <ReviewPaymentsStep
              handleBack={() => setStep(0)}
              initialPaymentData={paymentData}
              onEditPayment={handleEditPayment}
              onPaymentDataChange={setPaymentData}
              onSubmit={onSubmit}
            />
          )}
        </div>
      </FormProvider>
    </PageComponentLayout>
  );
}
