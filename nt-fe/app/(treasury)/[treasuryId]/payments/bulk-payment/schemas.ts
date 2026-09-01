import { z } from "zod";
import type { SelectedTokenData } from "@/components/token-select";

export interface BulkPaymentData {
    row?: number;
    recipient: string;
    amount: string;
    memo?: string;
    isRegistered?: boolean;
    validationError?: string;
}

export function buildTokenSchema(selectTokenMessage: string) {
    return z.custom<SelectedTokenData>(
        (val) => val !== null && typeof val === "object",
        {
            message: selectTokenMessage,
        },
    );
}

export function buildBulkPaymentFormSchema(messages: { selectToken: string }) {
    return z.object({
        selectedToken: buildTokenSchema(messages.selectToken).nullable(),
        comment: z.string().optional(),
        csvData: z.string().nullable(),
        pasteDataInput: z.string(),
        activeTab: z.enum(["upload", "paste"]),
        uploadedFileName: z.string().nullable(),
    });
}

export type BulkPaymentFormValues = z.infer<
    ReturnType<typeof buildBulkPaymentFormSchema>
>;

export function buildEditPaymentSchema(messages: {
    recipientMin: string;
    recipientMax: string;
    amountGreaterThanZero: string;
    selectToken: string;
}) {
    return z.object({
        recipient: z
            .string()
            .min(2, messages.recipientMin)
            .max(128, messages.recipientMax),
        amount: z
            .string()
            .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
                message: messages.amountGreaterThanZero,
            }),
        token: buildTokenSchema(messages.selectToken),
        destinationNetwork: z.string().optional(),
        destinationNetworkName: z.string().optional(),
    });
}

export type EditPaymentFormValues = z.infer<
    ReturnType<typeof buildEditPaymentSchema>
>;
