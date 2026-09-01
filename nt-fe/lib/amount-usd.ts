import Big from "@/lib/big";

/** Convert a USD draft to a token amount string using oracle/market price. */
export function usdToTokenAmount(
    usd: string,
    tokenPrice: number,
    decimals: number,
): string {
    if (!usd || !tokenPrice) return usd ? "0" : "";
    try {
        return Big(usd).div(tokenPrice).toFixed(decimals);
    } catch {
        return "";
    }
}

/** Convert a token amount to a USD draft (2 dp) using oracle/market price. */
export function tokenToUsdDraft(
    amount: string | number | null | undefined,
    tokenPrice: number,
): string {
    if (amount == null || amount === "" || !tokenPrice) return "";
    try {
        const n = typeof amount === "number" ? amount : Number(amount);
        if (!Number.isFinite(n) || n <= 0) return "";
        return Big(amount).mul(tokenPrice).toFixed(2);
    } catch {
        return "";
    }
}

/** Parse a quote/oracle USD override into a positive finite number. */
export function parseUsdOverride(
    value: number | string | null | undefined,
): number | null {
    if (value == null || value === "") return null;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}
