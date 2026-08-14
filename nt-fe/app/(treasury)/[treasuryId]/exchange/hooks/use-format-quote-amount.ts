import { useMemo } from "react";
import { decimalFromBaseUnitsOrNull, decimalOrNull } from "@/lib/amount-format";

interface QuoteDecimalAmountParams {
    amount: string;
    amountFormatted: string;
    tokenDecimals: number;
}

export function quoteDecimalAmount(
    params: QuoteDecimalAmountParams | null,
): string | null {
    if (!params) return null;

    const { amount, amountFormatted, tokenDecimals } = params;
    const amountDecimal = decimalFromBaseUnitsOrNull(amount, tokenDecimals);
    if (amountDecimal) return amountDecimal.toFixed();

    return decimalOrNull(amountFormatted)?.toFixed() ?? null;
}

/**
 * Returns an exact, ungrouped quote amount for form state and calculations.
 * Presentation formatting must happen only at the render boundary.
 */
export function useQuoteDecimalAmount(
    params: QuoteDecimalAmountParams | null,
): string | null {
    return useMemo(() => quoteDecimalAmount(params), [params]);
}
