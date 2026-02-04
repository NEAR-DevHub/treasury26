"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { PageCard } from "@/components/card";
import { StepProps, StepperHeader } from "@/components/step-wizard";
import { PaymentFormSection } from "../../components/payment-form-section";
import type { EditPaymentFormValues, BulkPaymentData } from "../schemas";
import { editPaymentSchema } from "../schemas";
import type { SelectedTokenData } from "@/components/token-select";
import { needsStorageDepositCheck } from "../utils";
import { getBatchStorageDepositIsRegistered } from "@/lib/api";

interface EditPaymentStepProps extends StepProps {
    payment: BulkPaymentData;
    paymentIndex: number;
    selectedToken: SelectedTokenData;
    onSave: (
        index: number,
        data: EditPaymentFormValues,
        isRegistered: boolean,
    ) => void;
    onCancel: () => void;
}

export function EditPaymentStep({
    handleBack,
    payment,
    paymentIndex,
    selectedToken,
    onSave,
    onCancel,
}: EditPaymentStepProps) {
    const [isSaving, setIsSaving] = useState(false);

    const form = useForm<EditPaymentFormValues>({
        resolver: zodResolver(editPaymentSchema),
        defaultValues: {
            recipient: payment.recipient,
            amount: payment.amount,
        },
    });

    const handleSave = async () => {
        const isValid = await form.trigger();
        if (!isValid) return;

        setIsSaving(true);
        try {
            const data = form.getValues();

            // Check storage registration for FT tokens
            let isRegistered = true;
            if (needsStorageDepositCheck(selectedToken)) {
                try {
                    const tokenId = selectedToken.address;
                    const storageResult =
                        await getBatchStorageDepositIsRegistered([
                            {
                                accountId: data.recipient,
                                tokenId: tokenId,
                            },
                        ]);
                    if (storageResult.length > 0) {
                        isRegistered = storageResult[0].isRegistered;
                    }
                } catch (error) {
                    console.error("Error checking storage deposit:", error);
                }
            }

            onSave(paymentIndex, data, isRegistered);
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <PageCard>
            <StepperHeader title="Edit Payment" handleBack={onCancel} />

            <PaymentFormSection
                selectedToken={selectedToken}
                amount={form.watch("amount")}
                onAmountChange={(amount) => form.setValue("amount", amount)}
                recipient={form.watch("recipient")}
                onRecipientChange={(recipient) =>
                    form.setValue("recipient", recipient)
                }
                tokenLocked={true}
                showBalance={true}
                saveButtonText="Save Changes"
                onSave={handleSave}
            />
        </PageCard>
    );
}
