"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { PageComponentLayout } from "@/components/page-component-layout";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { default_near_token } from "@/constants/token";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { trackEvent } from "@/lib/analytics";
import { getBatchStorageDepositIsRegistered } from "@/lib/api";
import Big from "@/lib/big";
import {
    BULK_PAYMENT_CONTRACT_ID,
    buildApproveListProposal,
    generateListId,
    submitPaymentList,
} from "@/lib/bulk-payment-api";
import { encodeToMarkdown } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import { BulkPaymentToast } from "../components/bulk-payment-toast";
import {
    EditPaymentStep,
    ReviewPaymentsStep,
    UploadDataStep,
} from "./components";
import {
    type BulkPaymentData,
    type BulkPaymentFormValues,
    buildBulkPaymentFormSchema,
    type EditPaymentFormValues,
} from "./schemas";
import { needsStorageDepositCheck } from "./utils";

export default function BulkPaymentPage() {
    const t = useTranslations("pages.payments");
    const tBulk = useTranslations("bulkPayment");
    const tReq = useTranslations("requests.actions");
    const tPaymentValidation = useTranslations("paymentForm.validation");
    const bulkPaymentFormSchema = useMemo(
        () =>
            buildBulkPaymentFormSchema({
                selectToken: tPaymentValidation("selectToken"),
            }),
        [tPaymentValidation],
    );
    const router = useRouter();
    const queryClient = useQueryClient();
    const { treasuryId: selectedTreasury, isConfidential } = useTreasury();
    const pageTitle = isConfidential ? t("confidentialTitle") : t("title");
    const { createProposal } = useNear();
    const { data: policy } = useTreasuryPolicy(selectedTreasury);

    useEffect(() => {
        if (isConfidential) {
            toast.warning(tBulk("comingSoonToast"));
            router.replace(`/${selectedTreasury}/payments`);
        }
    }, [isConfidential, selectedTreasury, router]);

    const [step, setStep] = useState(0);

    const form = useForm<BulkPaymentFormValues>({
        resolver: zodResolver(bulkPaymentFormSchema),
        defaultValues: {
            selectedToken: null,
            comment: "",
            csvData: null,
            pasteDataInput: "",
            activeTab: "upload",
            uploadedFileName: null,
        },
    });

    const selectedToken = form.watch("selectedToken");
    const comment = form.watch("comment");

    const [paymentData, setPaymentData] = useState<BulkPaymentData[]>([]);
    const [networkFeePerRecipient, setNetworkFeePerRecipient] = useState<
        string | null
    >(null);
    const [editingIndex, setEditingIndex] = useState<number | null>(null);
    const [isSubmittingProposal, setIsSubmittingProposal] = useState(false);
    const isSubmittingProposalRef = useRef(false);

    const trackReviewStepEnter = (
        source: "upload_continue" | "edit_save" | "edit_cancel",
        recipientsCount: number,
    ) => {
        trackEvent("bulk-payments-review-step-view", {
            source,
            treasury_id: selectedTreasury ?? "",
            recipients_count: recipientsCount,
        });
    };

    // Handle continue from upload step
    const handleContinueFromUpload = (
        payments: BulkPaymentData[],
        fee: string | null,
    ) => {
        setPaymentData(payments);
        setNetworkFeePerRecipient(fee);
        trackReviewStepEnter("upload_continue", payments.length);
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
        isRegistered: boolean,
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
        trackReviewStepEnter("edit_save", updatedPayments.length);
        setStep(1);
        setEditingIndex(null);
    };

    // Handle cancel edit
    const handleCancelEdit = () => {
        trackReviewStepEnter("edit_cancel", paymentData.length);
        setStep(1);
        setEditingIndex(null);
    };

    // Handle submission
    const onSubmit = async () => {
        if (isSubmittingProposalRef.current) {
            return;
        }
        if (!selectedTreasury || paymentData.length === 0 || !selectedToken)
            return;
        isSubmittingProposalRef.current = true;
        setIsSubmittingProposal(true);

        const totalAmount = paymentData.reduce(
            (sum, item) => sum.add(Big(item.amount || "0")),
            Big(0),
        );

        let loadingToastId: string | number | undefined;

        try {
            // Show loading toast
            loadingToastId = toast(
                <BulkPaymentToast
                    steps={[
                        {
                            label: tBulk("submittingList"),
                            status: "loading",
                        },
                        {
                            label: tBulk("submittingProposal"),
                            status: "pending",
                        },
                    ]}
                />,
                {
                    duration: Infinity,
                    classNames: {
                        toast: "!p-3",
                    },
                },
            );

            const proposalBond = policy?.proposal_bond || "0";

            // Determine token IDs
            const isNEAR =
                selectedToken.address === default_near_token(false).address &&
                selectedToken.residency?.toLowerCase() === NEAR_NETWORK_ID;

            const tokenIdForHash = isNEAR ? "native" : selectedToken.address;
            const tokenIdForProposal = selectedToken.address;

            // Convert amounts to smallest units
            const payments = paymentData.map((payment) => ({
                recipient: payment.recipient,
                amount: Big(payment.amount || "0")
                    .times(Big(10).pow(selectedToken.decimals))
                    .toFixed(0),
            }));

            // Generate timestamp for unique list_id
            const timestamp = Date.now();

            // Generate list_id with timestamp
            const listId = await generateListId(
                selectedTreasury,
                tokenIdForHash,
                payments,
                timestamp,
            );

            // Build proposal description
            const description = encodeToMarkdown({
                proposal_action: "bulk-payment",
                notes: comment || "",
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
                tokenResidency: selectedToken.residency as
                    | "Near"
                    | "Ft"
                    | "Intents",
                totalAmount: totalAmountInSmallestUnits,
                description,
                proposalBond,
            });

            // Build storage deposit transactions
            const additionalTransactions: any[] = [];
            if (needsStorageDepositCheck(selectedToken)) {
                const gas = "30000000000000";
                const depositInYocto = Big(0.00125)
                    .mul(Big(10).pow(24))
                    .toFixed();

                // Check if bulk payment contract is registered
                const bulkPaymentContractRegistration =
                    await getBatchStorageDepositIsRegistered([
                        {
                            accountId: BULK_PAYMENT_CONTRACT_ID,
                            tokenId: selectedToken.address,
                        },
                    ]);

                const isBulkPaymentContractRegistered =
                    bulkPaymentContractRegistration.length > 0 &&
                    bulkPaymentContractRegistration[0].isRegistered;

                // Add storage deposit for bulk payment contract if needed
                if (!isBulkPaymentContractRegistered) {
                    additionalTransactions.push({
                        receiverId: selectedToken.address,
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
                        payment.isRegistered === false &&
                        !payment.validationError,
                );

                for (const payment of unregisteredRecipients) {
                    additionalTransactions.push({
                        receiverId: selectedToken.address,
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

            // Submit payment list to backend first.
            const submitResult = await submitPaymentList({
                listId,
                timestamp,
                submitterId: selectedTreasury,
                daoContractId: selectedTreasury,
                tokenId: tokenIdForHash,
                payments,
            });

            if (!submitResult.success) {
                throw new Error(
                    submitResult.error || tBulk("submitListFailed"),
                );
            }

            // Update toast after successful list submission.
            toast(
                <BulkPaymentToast
                    steps={[
                        {
                            label: tBulk("submittingList"),
                            status: "completed",
                        },
                        {
                            label: tBulk("submittingProposal"),
                            status: "loading",
                        },
                    ]}
                />,
                {
                    id: loadingToastId,
                    duration: Infinity,
                    classNames: {
                        toast: "!p-3",
                    },
                },
            );

            // Create proposal (throws on failure)
            await createProposal(
                tBulk("proposalSubmitted"),
                {
                    treasuryId: selectedTreasury,
                    proposal: {
                        description: proposal.args.proposal.description,
                        kind: proposal.args.proposal.kind,
                    },
                    proposalBond,
                    additionalTransactions,
                    proposalType: "payment",
                },
                false,
            );

            trackEvent("bulk-payment-submitted", {
                treasury_id: selectedTreasury ?? "",
                token_symbol: selectedToken.symbol,
                recipients_count: paymentData.length,
            });

            toast.dismiss(loadingToastId);

            toast.success(tBulk("proposalSubmitted"), {
                duration: 10000,
                action: {
                    label: tReq("viewRequest"),
                    onClick: () =>
                        router.push(
                            `/${selectedTreasury}/requests?tab=InProgress`,
                        ),
                },
                classNames: {
                    toast: "!p-2 !px-4",
                    actionButton:
                        "!bg-transparent !text-foreground hover:!bg-muted !border-0",
                    title: "!border-r !border-r-border !pr-4",
                },
            });

            await queryClient.invalidateQueries({
                queryKey: ["subscription", selectedTreasury],
            });

            form.reset();
            setStep(0);
            setPaymentData([]);
            setNetworkFeePerRecipient(null);
        } catch (error) {
            console.error("Failed to submit bulk payment:", error);
            if (loadingToastId) {
                toast.dismiss(loadingToastId);
            }
            // createProposal already handles wallet rejection UI; submit list errors need a toast.
            toast.error(
                error instanceof Error ? error.message : tBulk("submitFailed"),
            );
        } finally {
            isSubmittingProposalRef.current = false;
            setIsSubmittingProposal(false);
        }
    };

    // Editing a single payment
    if (editingIndex !== null && step === 2 && selectedToken) {
        const payment = paymentData[editingIndex];
        return (
            <PageComponentLayout
                title={pageTitle}
                description={t("description")}
            >
                <div className="w-full max-w-[600px] mx-auto">
                    <EditPaymentStep
                        handleBack={handleCancelEdit}
                        payment={payment}
                        paymentIndex={editingIndex}
                        selectedToken={selectedToken}
                        networkFeePerRecipient={networkFeePerRecipient}
                        onSave={handleSaveEdit}
                        onCancel={handleCancelEdit}
                    />
                </div>
            </PageComponentLayout>
        );
    }

    return (
        <PageComponentLayout title={pageTitle} description={t("description")}>
            <FormProvider {...form}>
                <div
                    className={`w-full mx-auto ${step === 1 ? "max-w-3xl" : "max-w-7xl"}`}
                >
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
                            networkFeePerRecipient={networkFeePerRecipient}
                            onEditPayment={handleEditPayment}
                            onPaymentDataChange={setPaymentData}
                            onSubmit={onSubmit}
                            isSubmitting={isSubmittingProposal}
                        />
                    )}
                </div>
            </FormProvider>
        </PageComponentLayout>
    );
}
