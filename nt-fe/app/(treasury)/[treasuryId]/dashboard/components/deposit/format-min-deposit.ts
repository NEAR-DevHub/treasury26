import {
    decimalFromBaseUnitsOrNull,
    formatTokenQuantity,
} from "@/lib/amount-format";
import Big from "@/lib/big";

/**
 * Format a raw min-deposit amount for UI notices.
 * Hides zero / sub-displayable values (e.g. 1e-7 ETH must not show as "0").
 */
export function formatMinDepositDisplay(
    raw: string | null | undefined,
    decimals: number,
    locale: string = "en-US",
): string | null {
    const amount = decimalFromBaseUnitsOrNull(raw, decimals);
    if (!amount?.gt(0)) return null;

    const formatted = formatTokenQuantity(amount, {
        profile: "standard",
        tokenDecimals: decimals,
        rounding: "up",
        locale,
    });
    if (!formatted.isBelowThreshold) return formatted.display;

    const visibleDecimals = Math.min(decimals, 8);
    const threshold = Big(10).pow(-visibleDecimals);
    return formatTokenQuantity(threshold, {
        profile: "exact",
        tokenDecimals: decimals,
        locale,
    }).display;
}
