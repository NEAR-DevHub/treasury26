import { z } from "zod";
import { tokenSchema } from "@/components/token-input";
import type { ExchangeSwapType } from "./hooks/use-exchange-quote";

function isPositiveAmount(val: string): boolean {
    return !isNaN(Number(val)) && Number(val) > 0;
}

export function buildExchangeFormSchema(messages: {
    amountGreaterThanZero: string;
}) {
    return z
        .object({
            sellAmount: z.string(),
            sellToken: tokenSchema,
            receiveAmount: z.string().optional(),
            receiveToken: tokenSchema,
            slippageTolerance: z.number().optional(),
            amountMode: z.enum(["EXACT_INPUT", "EXACT_OUTPUT"]),
        })
        .superRefine((data, ctx) => {
            // Validate the user-entered side; the other amount is quote-derived.
            if (data.amountMode === "EXACT_INPUT") {
                if (!isPositiveAmount(data.sellAmount)) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: messages.amountGreaterThanZero,
                        path: ["sellAmount"],
                    });
                }
            } else if (!isPositiveAmount(data.receiveAmount || "")) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: messages.amountGreaterThanZero,
                    path: ["receiveAmount"],
                });
            }
        });
}

export type ExchangeFormValues = z.infer<
    ReturnType<typeof buildExchangeFormSchema>
>;

export type { ExchangeSwapType };
