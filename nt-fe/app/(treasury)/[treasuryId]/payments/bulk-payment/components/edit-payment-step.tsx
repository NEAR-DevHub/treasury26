"use client";

import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { Form } from "@/components/ui/form";
import { PageCard } from "@/components/card";
import { StepProps, StepperHeader } from "@/components/step-wizard";
import { PaymentFormSection } from "../../components/payment-form-section";
import type { EditPaymentFormValues, BulkPaymentData } from "../schemas";
import { buildEditPaymentSchema } from "../schemas";
import type { SelectedTokenData } from "@/components/token-select";
import { needsStorageDepositCheck } from "../utils";
import { getBatchStorageDepositIsRegistered } from "@/lib/api";
import {
    formatRecipientForNearComDestination,
    stripNearComAddressPrefix,
} from "@/lib/nearcom-address";

interface EditPaymentStepProps extends StepProps {
    payment: BulkPaymentData;
    paymentIndex: number;
    selectedToken: SelectedTokenData;
    networkFeePerRecipient: string | null;
    /**
     * Confidential bulk receive-network name. When set, recipient address
     * validation and address-book filtering use this chain (not NEAR / send).
     */
    destinationNetwork?: string;
    /** Network option id — `near.com` keeps nearcom: on the recipient field. */
    destinationNetworkId?: string;
    onSave: (
        index: number,
        data: EditPaymentFormValues,
        isRegistered: boolean,
    ) => Promise<void> | void;
    onCancel: () => void;
}

export function EditPaymentStep({
    payment,
    paymentIndex,
    selectedToken,
    networkFeePerRecipient,
    destinationNetwork,
    destinationNetworkId,
    onSave,
    onCancel,
}: EditPaymentStepProps) {
    const tValidation = useTranslations("paymentForm.validation");
    const editPaymentSchema = useMemo(
        () =>
            buildEditPaymentSchema({
                recipientMin: tValidation("recipientMin"),
                recipientMax: tValidation("recipientMax"),
                amountGreaterThanZero: tValidation("amountGreaterThanZero"),
                selectToken: tValidation("selectToken"),
            }),
        [tValidation],
    );
    const [isSaving, setIsSaving] = useState(false);

    const form = useForm<EditPaymentFormValues>({
        resolver: zodResolver(editPaymentSchema),
        defaultValues: {
            recipient: formatRecipientForNearComDestination(
                payment.recipient,
                destinationNetworkId,
            ),
            amount: payment.amount,
            token: selectedToken,
        },
    });
    const handleSave = async () => {
        const isValid = await form.trigger();
        if (!isValid) return;

        setIsSaving(true);
        try {
            const data = form.getValues();
            const normalizedRecipient = formatRecipientForNearComDestination(
                data.recipient,
                destinationNetworkId,
            );

            let isRegistered = true;
            if (needsStorageDepositCheck(selectedToken)) {
                try {
                    const storageResult =
                        await getBatchStorageDepositIsRegistered([
                            {
                                accountId:
                                    stripNearComAddressPrefix(
                                        normalizedRecipient,
                                    ),
                                tokenId: selectedToken.address,
                            },
                        ]);
                    if (storageResult.length > 0) {
                        isRegistered = storageResult[0].isRegistered;
                    }
                } catch (error) {
                    console.error("Error checking storage deposit:", error);
                }
            }

            onSave(
                paymentIndex,
                { ...data, recipient: normalizedRecipient },
                isRegistered,
            );
        } finally {
            setIsSaving(false);
        }
    };

    const tBulk = useTranslations("bulkPayment.editStep");
    return (
        <PageCard>
            <StepperHeader title={tBulk("title")} handleBack={onCancel} />

            <Form {...form}>
                <PaymentFormSection
                    control={form.control}
                    amountName="amount"
                    tokenName="token"
                    recipientName="recipient"
                    tokenLocked={true}
                    networkFee={networkFeePerRecipient}
                    saveButtonText={tBulk("saveChanges")}
                    onSave={handleSave}
                    hideRecipientNetwork
                    recipientNetworkOverride={destinationNetwork}
                    isSubmitting={isSaving}
                />
            </Form>
        </PageCard>
    );
}
