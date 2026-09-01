import { decimalFromBaseUnitsOrNull, decimalOrNull } from "@/lib/amount-format";
import Big from "@/lib/big";

/**
 * Exact decimal string of `amountOut * (1 - slippagePercent / 100)`.
 * Returns null when the amount or slippage cannot be parsed.
 */
export function minimumReceivedDecimal(
    amountOut: string | null | undefined,
    slippagePercent: number | string | null | undefined,
): string | null {
    const amount = decimalOrNull(amountOut);
    const slip = decimalOrNull(slippagePercent);
    if (!amount || slip == null || slip.lt(0)) return null;
    if (slip.gte(100)) return "0";
    return amount.mul(Big(1).minus(slip.div(100))).toFixed();
}

/** Same as `minimumReceivedDecimal` for a raw on-chain amount. */
export function minimumReceivedFromRaw(
    rawAmountOut: string | null | undefined,
    tokenDecimals: number,
    slippagePercent: number | string | null | undefined,
): string | null {
    const amount = decimalFromBaseUnitsOrNull(rawAmountOut, tokenDecimals);
    if (!amount) return null;
    return minimumReceivedDecimal(amount.toFixed(), slippagePercent);
}
