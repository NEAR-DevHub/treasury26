"use client";

import { useTranslations } from "next-intl";
import type { IntentsFeeLabels } from "@/lib/intents-fee";

export function useIntentsFeeLabels(): IntentsFeeLabels {
    const t = useTranslations("intentsFee");
    return {
        amountTooLowForFee: (prefix, fee, symbol, addMore) =>
            t("amountTooLowForFee", { prefix, fee, symbol, addMore }),
        insufficientBalanceForFee: (prefix, fee, symbol, shortfall) =>
            t("insufficientBalanceForFee", { prefix, fee, symbol, shortfall }),
    };
}
