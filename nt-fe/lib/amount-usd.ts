import {
    decimalOrNull,
    quantizeFiatAmount,
    quantizeTokenAmount,
} from "@/lib/amount-format";

/** Convert a USD draft to a token amount string using oracle/market price. */
export function usdToTokenAmount(
    usd: string,
    tokenPrice: number,
    decimals: number,
): string {
    if (!usd) return "";
    const price = decimalOrNull(tokenPrice);
    if (!price || price.lte(0)) return "0";
    const usdAmount = decimalOrNull(usd);
    if (!usdAmount) return "";
    return (
        quantizeTokenAmount(usdAmount.div(price), {
            tokenDecimals: decimals,
            unitPriceUsd: price,
            rounding: "down",
        }) ?? ""
    );
}

/** Convert a token amount to a USD draft (2 dp) using oracle/market price. */
export function tokenToUsdDraft(
    amount: string | number | null | undefined,
    tokenPrice: number,
): string {
    const parsed = decimalOrNull(amount);
    const price = decimalOrNull(tokenPrice);
    if (!parsed || !price || parsed.lte(0) || price.lte(0)) return "";
    return quantizeFiatAmount(parsed.mul(price)) ?? "";
}

/** Parse a quote/oracle USD override into a positive finite number. */
export function parseUsdOverride(
    value: number | string | null | undefined,
): number | null {
    if (value == null || value === "") return null;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}
