import { useMemo } from "react";
import Big from "@/lib/big";
import { formatTokenAmount } from "@/lib/utils";

interface FormatQuoteAmountParams {
    amount: string;
    amountFormatted: string;
    amountUsd: string;
    tokenDecimals: number;
}

/**
 * Formats a quote amount with enough precision to represent ~$0.01,
 * using USD value from the quote to infer token price.
 */
export function useFormatQuoteAmount(
    params: FormatQuoteAmountParams | null,
): string {
    return useMemo(() => {
        if (!params) {
            return "";
        }

        const { amount, amountFormatted, amountUsd, tokenDecimals } = params;

        try {
            const usdValue = parseFloat(amountUsd || "0");
            const tokenAmountDecimal = Big(amount).div(
                Big(10).pow(tokenDecimals),
            );
            const tokenPrice = tokenAmountDecimal.gt(0)
                ? usdValue / Number(tokenAmountDecimal.toString())
                : 0;

            return formatTokenAmount(amount, tokenDecimals, tokenPrice);
        } catch (error) {
            console.error("Error formatting quote amount:", error);
            return amountFormatted;
        }
    }, [params]);
}
