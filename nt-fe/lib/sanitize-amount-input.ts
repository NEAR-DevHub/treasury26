/**
 * Normalize typed/pasted amount text to a canonical decimal string.
 * Comma is treated as a decimal point (European keyboards / locales).
 */
export function sanitizeAmountInput(value: string): string {
    return value
        .replace(/,/g, ".")
        .replace(/[^0-9.]/g, "")
        .replace(/^0+(?=\d)/, "");
}
