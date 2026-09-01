export interface Rgb {
    r: number;
    g: number;
    b: number;
}

/** Pixels below this alpha are the transparent padding around a logo. */
const ALPHA_FLOOR = 128;
/** 3 bits per channel — coarse enough that anti-aliased edges land in one bucket. */
const BUCKET_SHIFT = 5;
/** A logo's white fill and black outline should not win over its brand colour. */
const NEAR_BLACK_MAX = 32;
const NEAR_WHITE_MIN = 242;
const NEUTRAL_SATURATION = 0.12;
/**
 * Keeps a large flat area competitive with a small vivid mark, while still
 * letting the vivid mark win when the flat area is only slightly bigger.
 */
const SATURATION_WEIGHT_FLOOR = 0.35;

interface Bucket {
    count: number;
    r: number;
    g: number;
    b: number;
}

/** HSV saturation, 0 for any shade of grey. */
function saturationOf(r: number, g: number, b: number): number {
    const max = Math.max(r, g, b);
    if (max === 0) return 0;
    return (max - min3(r, g, b)) / max;
}

function min3(r: number, g: number, b: number): number {
    return Math.min(r, Math.min(g, b));
}

function averageOf(bucket: Bucket): Rgb {
    return {
        r: Math.round(bucket.r / bucket.count),
        g: Math.round(bucket.g / bucket.count),
        b: Math.round(bucket.b / bucket.count),
    };
}

/**
 * The colour a token logo reads as, from RGBA pixel data (4 bytes per pixel,
 * as `CanvasRenderingContext2D.getImageData` returns).
 *
 * Transparent, near-white and near-black pixels are ignored so a mark on a
 * white disc yields the mark's colour rather than the disc. Returns null for
 * icons with no colour to speak of (monochrome or fully transparent), letting
 * callers keep their default styling instead of applying an invisible tint.
 */
export function dominantColorFromPixels(
    pixels: Uint8ClampedArray | number[],
): Rgb | null {
    const buckets = new Map<number, Bucket>();

    for (let i = 0; i + 3 < pixels.length; i += 4) {
        if (pixels[i + 3] < ALPHA_FLOOR) continue;

        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const max = Math.max(r, g, b);
        if (max < NEAR_BLACK_MAX) continue;

        const saturation = saturationOf(r, g, b);
        if (max > NEAR_WHITE_MIN && saturation < NEUTRAL_SATURATION) continue;

        const key =
            ((r >> BUCKET_SHIFT) << 10) |
            ((g >> BUCKET_SHIFT) << 5) |
            (b >> BUCKET_SHIFT);
        const bucket = buckets.get(key);
        if (bucket) {
            bucket.count += 1;
            bucket.r += r;
            bucket.g += g;
            bucket.b += b;
        } else {
            buckets.set(key, { count: 1, r, g, b });
        }
    }

    let best: Rgb | null = null;
    let bestScore = 0;

    for (const bucket of buckets.values()) {
        const average = averageOf(bucket);
        const score =
            bucket.count *
            (SATURATION_WEIGHT_FLOOR +
                saturationOf(average.r, average.g, average.b));
        if (score > bestScore) {
            bestScore = score;
            best = average;
        }
    }

    return best;
}
