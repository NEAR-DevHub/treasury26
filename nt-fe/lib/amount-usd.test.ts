import { describe, expect, it } from "bun:test";
import {
    parseUsdOverride,
    tokenToUsdDraft,
    usdToTokenAmount,
} from "./amount-usd";

describe("usdToTokenAmount", () => {
    it("converts USD to tokens via price", () => {
        expect(usdToTokenAmount("100", 2, 6)).toBe("50.000000");
        expect(usdToTokenAmount("1", 0.5, 2)).toBe("2.00");
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
