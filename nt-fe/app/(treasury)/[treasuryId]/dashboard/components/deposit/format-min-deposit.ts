import Big from "@/lib/big";
import { formatBalance } from "@/lib/utils";

/**
 * Format a raw min-deposit amount for UI notices.
 * Hides zero / sub-displayable values (e.g. 1e-7 ETH must not show as "0").
 */
export function formatMinDepositDisplay(
    raw: string | null | undefined,
    decimals: number,
): string | null {
    if (!raw) return null;
    try {
        if (!Big(raw).gt(0)) return null;
    } catch {
        return null;
    }
    // Small mins (e.g. 1e-7 ETH) round to "0" with the default 5 decimals.
    const formatted = formatBalance(raw, decimals, 10);
    return formatted === "0" ? null : formatted;
}
