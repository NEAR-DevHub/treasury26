import { describe, expect, it } from "bun:test";
import { quoteDecimalAmount } from "./use-format-quote-amount";

describe("quoteDecimalAmount", () => {
    it("returns exact canonical values instead of localized display strings", () => {
        expect(
            quoteDecimalAmount({
                amount: "5000000000",
                amountFormatted: "5,000",
                tokenDecimals: 6,
            }),
        ).toBe("5000");
    });

    it("keeps dust exact for editable exchange fields", () => {
        expect(
            quoteDecimalAmount({
                amount: "1",
                amountFormatted: "<0.00000001",
                tokenDecimals: 24,
            }),
        ).toBe("0.000000000000000000000001");
    });

    it("does not accept a localized or threshold fallback as data", () => {
        expect(
            quoteDecimalAmount({
                amount: "bad",
                amountFormatted: "1,234.56",
                tokenDecimals: 6,
            }),
        ).toBeNull();
        expect(
            quoteDecimalAmount({
                amount: "bad",
                amountFormatted: "<0.00000001",
                tokenDecimals: 24,
            }),
        ).toBeNull();
    });
});
