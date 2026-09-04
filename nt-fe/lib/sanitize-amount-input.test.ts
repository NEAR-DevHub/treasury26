import { describe, expect, it } from "bun:test";
import { sanitizeAmountInput } from "./sanitize-amount-input";

describe("sanitizeAmountInput", () => {
    it("treats comma as a decimal point", () => {
        expect(sanitizeAmountInput(",")).toBe(".");
        expect(sanitizeAmountInput("10,")).toBe("10.");
        expect(sanitizeAmountInput("10,5")).toBe("10.5");
        expect(sanitizeAmountInput("0,50")).toBe("0.50");
    });

    it("keeps an existing dot decimal", () => {
        expect(sanitizeAmountInput("10.5")).toBe("10.5");
        expect(sanitizeAmountInput(".")).toBe(".");
    });

    it("strips non-numeric characters and leading zeros", () => {
        expect(sanitizeAmountInput("$10.5")).toBe("10.5");
        expect(sanitizeAmountInput("0010")).toBe("10");
        expect(sanitizeAmountInput("abc")).toBe("");
    });
});
