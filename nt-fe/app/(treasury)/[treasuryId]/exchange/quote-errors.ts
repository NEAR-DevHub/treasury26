import Big from "@/lib/big";
import { classifyExchangeError } from "./utils";

/**
 * Turns a raw quote/API failure into a user-facing exchange error string.
 */
export function formatQuoteErrorMessage(
    error: unknown,
    amountToken: { decimals: number; symbol: string },
    tEx: (key: string, values?: Record<string, string>) => string,
): string {
    const rawMessage =
        error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : tEx("fetchFailed");

    const { code, raw, minAmountRaw } = classifyExchangeError(rawMessage);
    let message = code === "unknown" ? raw : tEx(code);

    if (code === "amountTooLow" && minAmountRaw) {
        try {
            const threshold = Big(minAmountRaw);
            const parsedAmount = minAmountRaw.includes(".")
                ? threshold
                : threshold.div(Big(10).pow(amountToken.decimals));
            const min = parsedAmount
                .toFixed(amountToken.decimals)
                .replace(/\.?0+$/, "");
            message = tEx("amountTooLowWithMin", {
                min,
                token: amountToken.symbol,
            });
        } catch {
            // Fall back to the generic low-amount message.
        }
    }

    return message;
}

export function isAbortError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const name = "name" in error ? String(error.name) : "";
    const code =
        "code" in error ? String((error as { code?: string }).code) : "";
    return (
        name === "AbortError" ||
        name === "CanceledError" ||
        code === "ERR_CANCELED"
    );
}
