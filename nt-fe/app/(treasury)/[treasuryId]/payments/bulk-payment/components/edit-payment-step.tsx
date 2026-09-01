"use client";

import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { Form } from "@/components/ui/form";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { StepProps } from "@/components/step-wizard";
import { PaymentFormSection } from "../../components/payment-form-section";
import type { EditPaymentFormValues, BulkPaymentData } from "../schemas";
import { buildEditPaymentSchema } from "../schemas";
import type { SelectedTokenData } from "@/components/token-select";
import type { BridgeAsset } from "@/hooks/use-bridge-tokens";
import { needsStorageDepositCheck } from "../utils";
import { getBatchStorageDepositIsRegistered } from "@/lib/api";
import { NEAR_COM_NETWORK_ID } from "@/constants/network-ids";
import {
    formatRecipientForNearComDestination,
    hasNearComAddressPrefix,
    stripNearComAddressPrefix,
    withNearComAddressPrefix,
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
    bridgeAssets?: BridgeAsset[];
    isBridgeAssetsLoading?: boolean;
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
    bridgeAssets = [],
    isBridgeAssetsLoading = false,
    onSave,
    onCancel,
}: EditPaymentStepProps) {
    const tValidation = useTranslations("paymentForm.validation");
    const tBulk = useTranslations("bulkPayment.editStep");
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
            recipient: hasNearComAddressPrefix(payment.recipient)
                ? withNearComAddressPrefix(payment.recipient)
                : formatRecipientForNearComDestination(
                      payment.recipient,
                      destinationNetworkId,
                  ),
            amount: payment.amount,
            token: selectedToken,
            destinationNetwork: destinationNetworkId ?? "",
            destinationNetworkName: destinationNetwork ?? "",
        },
    });
    const handleSave = async () => {
        const isValid = await form.trigger();
        if (!isValid) return;

        setIsSaving(true);
        try {
            const data = form.getValues();
            // Keep nearcom: for FE display when the user typed it (public has
            // no network picker). Confidential near.com destination also keeps it.
            const normalizedRecipient =
                hasNearComAddressPrefix(data.recipient) ||
                destinationNetworkId === NEAR_COM_NETWORK_ID
                    ? withNearComAddressPrefix(data.recipient)
                    : stripNearComAddressPrefix(data.recipient);

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

    return (
        <div className="flex flex-col gap-4">
            <Button
                type="button"
                variant="ghost"
                onClick={onCancel}
                className="h-auto w-fit gap-1 self-start px-0 text-sm font-semibold text-foreground hover:bg-transparent"
            >
                <Icon icon={ArrowLeft01Icon} className="size-4 stroke-2" />
                {tBulk("back")}
            </Button>

            <Form {...form}>
                <PaymentFormSection
                    control={form.control}
                    amountName="amount"
                    tokenName="token"
                    recipientName="recipient"
                    destinationNetworkName="destinationNetwork"
                    destinationNetworkNameFieldName="destinationNetworkName"
                    tokenLocked
                    destinationLocked
                    hideRecipientNetwork={false}
                    recipientNetworkOverride={destinationNetwork}
                    requireNearComPrefix={
                        destinationNetworkId === NEAR_COM_NETWORK_ID
                    }
                    networkFee={networkFeePerRecipient}
                    bridgeAssets={bridgeAssets}
                    isBridgeAssetsLoading={isBridgeAssetsLoading}
                    saveButtonText={tBulk("saveChanges")}
                    onSave={handleSave}
                    isSubmitting={isSaving}
                />
            </Form>
        </div>
    );
}
