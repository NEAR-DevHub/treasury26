import { describe, expect, it } from "bun:test";
import {
    parseUsdOverride,
    tokenToUsdDraft,
    usdToTokenAmount,
} from "./amount-usd";

describe("usdToTokenAmount", () => {
    it("converts USD to tokens and quantizes to display digits", () => {
        expect(usdToTokenAmount("100", 2, 6)).toBe("50");
        expect(usdToTokenAmount("1", 0.5, 2)).toBe("2");
    });

    it("does not dump 24 NEAR decimals into the amount field", () => {
        expect(usdToTokenAmount("10", 1, 24)).toBe("10");
    });

    it("floors spendable token amounts instead of rounding up", () => {
        // $10 / $3 = 3.333… — never write more tokens than the USD draft buys.
        const converted = usdToTokenAmount("10", 3, 24);
        expect(converted).toBe("3.33333");
        expect(converted.includes("3.333333333333")).toBe(false);
    });

    it("returns empty or zero when inputs are missing", () => {
        expect(usdToTokenAmount("", 2, 6)).toBe("");
        expect(usdToTokenAmount("10", 0, 6)).toBe("0");
    });
});

describe("tokenToUsdDraft", () => {
    it("converts token amount to a 2dp USD draft", () => {
        expect(tokenToUsdDraft("50", 2)).toBe("100.00");
        expect(tokenToUsdDraft("1.5", 4)).toBe("6.00");
        expect(tokenToUsdDraft("1.225", 1)).toBe("1.23");
    });

    it("returns empty for empty/invalid amounts", () => {
        expect(tokenToUsdDraft("", 2)).toBe("");
        expect(tokenToUsdDraft("0", 2)).toBe("");
        expect(tokenToUsdDraft(null, 2)).toBe("");
    });
});

describe("parseUsdOverride", () => {
    it("accepts positive finite quote USD values", () => {
        expect(parseUsdOverride("12.34")).toBe(12.34);
        expect(parseUsdOverride(5)).toBe(5);
    });

    it("rejects empty or non-positive values", () => {
        expect(parseUsdOverride(null)).toBeNull();
        expect(parseUsdOverride("0")).toBeNull();
        expect(parseUsdOverride("nope")).toBeNull();
    });
});
