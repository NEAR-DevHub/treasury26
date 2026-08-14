import { describe, expect, it } from "bun:test";
import { formatMinDepositDisplay } from "./format-min-deposit";

describe("formatMinDepositDisplay", () => {
    it("suppresses zero and invalid minimums", () => {
        expect(formatMinDepositDisplay("0", 24)).toBeNull();
        expect(formatMinDepositDisplay("bad", 24)).toBeNull();
    });

    it("rounds a minimum upward", () => {
        expect(formatMinDepositDisplay("1000000000000000001", 18)).toBe(
            "1.00001",
        );
    });

    it("shows an actionable visible threshold for tiny minimums", () => {
        expect(formatMinDepositDisplay("1", 24)).toBe("0.00000001");
        expect(formatMinDepositDisplay("1", 24, "de")).toBe("0,00000001");
    });
});
