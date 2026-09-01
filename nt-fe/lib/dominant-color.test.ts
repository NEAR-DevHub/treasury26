import { describe, expect, it } from "bun:test";
import { dominantColorFromPixels } from "./dominant-color";

/** Flattens `[r, g, b, a]` swatches into an RGBA buffer. */
function pixels(...swatches: [number, number, number, number][]): number[] {
    return swatches.flat();
}

function repeat(
    swatch: [number, number, number, number],
    times: number,
): [number, number, number, number][] {
    return Array.from({ length: times }, () => swatch);
}

const USDC_BLUE: [number, number, number, number] = [39, 117, 202, 255];
const NEAR_GREEN: [number, number, number, number] = [0, 236, 151, 255];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BLACK: [number, number, number, number] = [10, 10, 10, 255];
const TRANSPARENT: [number, number, number, number] = [123, 45, 67, 0];

describe("dominantColorFromPixels", () => {
    it("returns the only colour present", () => {
        expect(
            dominantColorFromPixels(pixels(...repeat(USDC_BLUE, 4))),
        ).toEqual({ r: 39, g: 117, b: 202 });
    });

    it("ignores the white fill of a logo disc", () => {
        const data = pixels(...repeat(WHITE, 30), ...repeat(NEAR_GREEN, 6));
        expect(dominantColorFromPixels(data)).toEqual({
            r: 0,
            g: 236,
            b: 151,
        });
    });

    it("ignores a black outline", () => {
        const data = pixels(...repeat(BLACK, 30), ...repeat(USDC_BLUE, 6));
        expect(dominantColorFromPixels(data)).toEqual({
            r: 39,
            g: 117,
            b: 202,
        });
    });

    it("ignores transparent padding", () => {
        const data = pixels(
            ...repeat(TRANSPARENT, 40),
            ...repeat(USDC_BLUE, 2),
        );
        expect(dominantColorFromPixels(data)).toEqual({
            r: 39,
            g: 117,
            b: 202,
        });
    });

    it("picks the more prominent of two brand colours", () => {
        const data = pixels(...repeat(USDC_BLUE, 20), ...repeat(NEAR_GREEN, 4));
        expect(dominantColorFromPixels(data)).toEqual({
            r: 39,
            g: 117,
            b: 202,
        });
    });

    it("averages anti-aliased shades of the same colour", () => {
        const data = pixels([40, 118, 200, 255], [38, 116, 204, 255]);
        expect(dominantColorFromPixels(data)).toEqual({
            r: 39,
            g: 117,
            b: 202,
        });
    });

    it("returns null for a monochrome icon so callers keep their default", () => {
        const data = pixels(...repeat(WHITE, 10), ...repeat(BLACK, 10));
        expect(dominantColorFromPixels(data)).toBeNull();
    });

    it("returns null for a fully transparent icon", () => {
        expect(
            dominantColorFromPixels(pixels(...repeat(TRANSPARENT, 8))),
        ).toBeNull();
    });

    it("returns null for empty pixel data", () => {
        expect(dominantColorFromPixels([])).toBeNull();
    });

    it("ignores a trailing partial pixel", () => {
        const data = [...pixels(...repeat(USDC_BLUE, 1)), 255, 0];
        expect(dominantColorFromPixels(data)).toEqual({
            r: 39,
            g: 117,
            b: 202,
        });
    });
});
