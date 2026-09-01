import { describe, expect, it } from "bun:test";
import { fitFontSize } from "./fit-font-size";

describe("fitFontSize", () => {
    it("keeps the max size when the text already fits", () => {
        expect(
            fitFontSize({
                contentWidth: 80,
                availableWidth: 200,
                maxSize: 24,
                minSize: 14,
            }),
        ).toEqual({ fontSize: 24, truncated: false });
    });

    it("shrinks proportionally while staying at or above the minimum", () => {
        expect(
            fitFontSize({
                contentWidth: 400,
                availableWidth: 300,
                maxSize: 24,
                minSize: 14,
            }),
        ).toEqual({ fontSize: 18, truncated: false });
    });

    it("stops at 14px and marks the text as truncated", () => {
        expect(
            fitFontSize({
                contentWidth: 800,
                availableWidth: 200,
                maxSize: 24,
                minSize: 14,
            }),
        ).toEqual({ fontSize: 14, truncated: true });
    });

    it("does not shrink when measurement is not ready", () => {
        expect(
            fitFontSize({
                contentWidth: 0,
                availableWidth: 200,
                maxSize: 24,
                minSize: 14,
            }),
        ).toEqual({ fontSize: 24, truncated: false });
    });
});
