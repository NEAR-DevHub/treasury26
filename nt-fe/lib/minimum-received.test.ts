import { describe, expect, it } from "bun:test";
import {
    minimumReceivedDecimal,
    minimumReceivedFromRaw,
} from "./minimum-received";

describe("minimumReceivedDecimal", () => {
    it("applies slippage to the quoted output", () => {
        expect(minimumReceivedDecimal("7.515465", 0.5)).toBe("7.477887675");
    });

    it("returns the full amount at 0% slippage", () => {
        expect(minimumReceivedDecimal("10", 0)).toBe("10");
    });

    it("returns 0 when slippage is 100% or more", () => {
        expect(minimumReceivedDecimal("10", 100)).toBe("0");
        expect(minimumReceivedDecimal("10", 150)).toBe("0");
    });

    it("returns null for missing or invalid inputs", () => {
        expect(minimumReceivedDecimal(null, 0.5)).toBeNull();
        expect(minimumReceivedDecimal("bad", 0.5)).toBeNull();
        expect(minimumReceivedDecimal("10", null)).toBeNull();
        expect(minimumReceivedDecimal("10", -1)).toBeNull();
    });
});

describe("minimumReceivedFromRaw", () => {
    it("converts raw units before applying slippage", () => {
        expect(
            minimumReceivedFromRaw("7515465000000000000000000", 24, 0.5),
        ).toBe("7.477887675");
    });

    it("returns null for malformed raw amounts", () => {
        expect(minimumReceivedFromRaw("nope", 24, 0.5)).toBeNull();
    });
});
