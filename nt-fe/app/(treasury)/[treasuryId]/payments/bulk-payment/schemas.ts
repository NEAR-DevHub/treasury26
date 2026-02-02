import { z } from "zod";
import type { TreasuryAsset } from "@/lib/api";

export interface BulkPaymentData {
  recipient: string;
  amount: string;
  memo?: string;
  isRegistered?: boolean;
  validationError?: string;
}

// Schema for the token selection
export const tokenSchema = z.custom<TreasuryAsset>(
  (val) => val !== null && typeof val === "object",
  {
    message: "Please select a token",
  }
);

// Schema for the bulk payment form
export const bulkPaymentFormSchema = z.object({
  selectedToken: tokenSchema.nullable(),
  comment: z.string().optional(),
  csvData: z.string().nullable(),
  pasteDataInput: z.string(),
  activeTab: z.enum(["upload", "paste"]),
});

export type BulkPaymentFormValues = z.infer<typeof bulkPaymentFormSchema>;

// Schema for editing a single payment
export const editPaymentSchema = z.object({
  recipient: z
    .string()
    .min(2, "Recipient should be at least 2 characters")
    .max(64, "Recipient must be less than 64 characters"),
  amount: z
    .string()
    .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
      message: "Amount must be greater than 0",
    }),
});

export type EditPaymentFormValues = z.infer<typeof editPaymentSchema>;

