import { describe, expect, it } from "bun:test";
import { parseAmount } from "./parsing";

const labels = {
    pleaseRemoveChars: (chars: string) => `Please remove: ${chars}`,
    amountCannotBeEmpty: "Amount cannot be empty",
};

describe("parseAmount thousand separators", () => {
    it("parses a single 3-digit comma group as thousands, not decimal", () => {
        // Regression for #758: "1,000" must become 1000, not 1.0
        expect(parseAmount("1,000", labels).amount).toBe("1000");
        expect(parseAmount("2,500", labels).amount).toBe("2500");
    });

    it("keeps multi-group thousands separators working", () => {
        expect(parseAmount("1,000,000", labels).amount).toBe("1000000");
    });

    it("still treats a non-3-digit comma group as a decimal", () => {
        expect(parseAmount("10,5", labels).amount).toBe("10.5");
        expect(parseAmount("10,50", labels).amount).toBe("10.50");
        expect(parseAmount("1,2345", labels).amount).toBe("1.2345");
    });

    it("treats a 3-digit group after a leading zero as a decimal", () => {
        // "0,500" is only meaningful as 0.5, never as 500
        expect(parseAmount("0,500", labels).amount).toBe("0.500");
    });

    it("still handles mixed comma+dot formats", () => {
        expect(parseAmount("1,000.50", labels).amount).toBe("1000.50");
        expect(parseAmount("1.000,50", labels).amount).toBe("1000.50");
    });
});
