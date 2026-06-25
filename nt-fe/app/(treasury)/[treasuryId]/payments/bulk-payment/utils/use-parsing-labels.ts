"use client";

import { useTranslations } from "next-intl";
import { translateNearValidationError } from "@/lib/near-validation-i18n";
import type { NearValidationErrorCode } from "@/lib/near-validation";
import type { BulkParsingLabels } from "./parsing";

export function useBulkParsingLabels(): BulkParsingLabels {
    const t = useTranslations("bulkPayment.parsing");
    const tAccountInput = useTranslations("accountInput");
    return {
        rowPrefix: (row, message) => t("rowPrefix", { row, message }),
        rowPrefixOnly: (row) => t("rowPrefix", { row, message: "" }),
        missingRecipientFirstColumn: t("missingRecipientFirstColumn"),
        invalidNearAddress: (address) => t("invalidNearAddress", { address }),
        invalidChainAddress: (address, chain) =>
            t("invalidChainAddress", { address, chain }),
        rowNeedsAmountRecipient: t("rowNeedsAmountRecipient"),
        missingRecipientBeforeComma: t("missingRecipientBeforeComma"),
        missingAmountAfterComma: (recipient) =>
            t("missingAmountAfterComma", { recipient }),
        invalidAmountNumber: (amountStr) =>
            t("invalidAmountNumber", { amountStr }),
        amountGreaterThanZero: (amountStr) =>
            t("amountGreaterThanZero", { amountStr }),
        amountTooLarge: (amountStr) => t("amountTooLarge", { amountStr }),
        invalidAmountFallback: t("invalidAmountFallback"),
        pleaseRemoveChars: (chars) => t("pleaseRemoveChars", { chars }),
        amountCannotBeEmpty: t("amountCannotBeEmpty"),
        tokenMismatch: (provided, expected, suggested) =>
            t("tokenMismatch", { provided, expected, suggested }),
        multipleTokenSymbols: (symbols) =>
            t("multipleTokenSymbols", { symbols }),
        noPaymentDataFound: t("noPaymentDataFound"),
        exceedsRecipientLimit: (count, limit, excess) =>
            t("exceedsRecipientLimit", { count, limit, excess }),
        noPaymentDataProvided: t("noPaymentDataProvided"),
        headerColumnsNotFound: t("headerColumnsNotFound"),
        failedToParseCsv: t("failedToParseCsv"),
        failedToParsePaste: t("failedToParsePaste"),
        failedToValidateAccount: t("failedToValidateAccount"),
        nearValidationError: (errorCode: NearValidationErrorCode) =>
            translateNearValidationError(
                tAccountInput as unknown as ((key: string) => string) & {
                    has: (key: string) => boolean;
                },
                errorCode,
                t("failedToValidateAccount"),
            ),
        feeEstimationFailed: t("feeEstimationFailed"),
        feeEstimationFailedRow: (row, recipient) =>
            t("feeEstimationFailedRow", { row, recipient }),
    };
}
