import { describe, expect, it } from "bun:test";
import { formatQuoteErrorMessage } from "./quote-errors";
import { classifyExchangeError } from "./utils";

describe("classifyExchangeError", () => {
    it("maps liquidity failures to noRoute", () => {
        expect(classifyExchangeError("No liquidity available").code).toBe(
            "noRoute",
        );
        expect(
            classifyExchangeError("Insufficient liquidity for pair").code,
        ).toBe("noRoute");
        expect(classifyExchangeError("liquidity unavailable").code).toBe(
            "noRoute",
        );
    });

    it("maps amount-too-low with optional minimum", () => {
        const result = classifyExchangeError(
            "Amount is too low, try at least 10000",
        );
        expect(result.code).toBe("amountTooLow");
        expect(result.minAmountRaw).toBe("10000");
    });

    it("maps unknown messages through as raw", () => {
        const result = classifyExchangeError("something weird happened");
        expect(result.code).toBe("unknown");
        expect(result.raw).toBe("something weird happened");
    });
});

describe("formatQuoteErrorMessage", () => {
    const tEx = (key: string, values?: Record<string, string>) => {
        if (key === "noRoute") {
            return "No exchange found. Try a smaller amount or different token.";
        }
        if (key === "amountTooLowWithMin") {
            return `Enter at least ${values?.min} ${values?.token}.`;
        }
        if (key === "amountTooLow") {
            return "Amount too low for swap.";
        }
        if (key === "fetchFailed") {
            return "Failed to fetch quote";
        }
        return key;
    };

    it("translates no-liquidity into noRoute copy", () => {
        expect(
            formatQuoteErrorMessage(
                new Error("No liquidity available"),
                { decimals: 18, symbol: "ETH" },
                tEx,
            ),
        ).toBe("No exchange found. Try a smaller amount or different token.");
    });

    it("formats amountTooLow with token decimals", () => {
        expect(
            formatQuoteErrorMessage(
                new Error("Amount is too low, try at least 1000000"),
                { decimals: 6, symbol: "USDC" },
                tEx,
            ),
        ).toBe("Enter at least 1 USDC.");
    });
});
