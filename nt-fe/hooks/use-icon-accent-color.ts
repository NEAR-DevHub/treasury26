"use client";

import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { dominantColorFromPixels, type Rgb } from "@/lib/dominant-color";
import { iconSampleSources } from "@/lib/icon-sample-sources";
import { isIconUrl } from "@/lib/icon-url";

/** Logos are flat art, so a small sample is enough and keeps the read cheap. */
const SAMPLE_SIZE = 24;

/** Icon URLs are stable, so a result is worth keeping for the whole session. */
const colorCache = new Map<string, Rgb | null>();
const pending = new Map<string, Promise<Rgb | null>>();

/** `null` colour means "read it, no colour to use"; `unread` means "try elsewhere". */
type SampleResult = { read: true; color: Rgb | null } | { read: false };

const UNREAD: SampleResult = { read: false };

function sampleSource(src: string): Promise<SampleResult> {
    return new Promise((resolve) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = SAMPLE_SIZE;
                canvas.height = SAMPLE_SIZE;
                const context = canvas.getContext("2d", {
                    willReadFrequently: true,
                });
                if (!context) {
                    resolve(UNREAD);
                    return;
                }
                context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
                const { data } = context.getImageData(
                    0,
                    0,
                    SAMPLE_SIZE,
                    SAMPLE_SIZE,
                );
                resolve({ read: true, color: dominantColorFromPixels(data) });
            } catch {
                // Cross-origin art without CORS headers taints the canvas, and
                // an SVG with no intrinsic size cannot be drawn at all.
                resolve(UNREAD);
            }
        };
        image.onerror = () => resolve(UNREAD);
        image.src = src;
    });
}

async function readIconColor(url: string): Promise<Rgb | null> {
    for (const src of iconSampleSources(url)) {
        const result = await sampleSource(src);
        if (result.read) return result.color;
    }
    return null;
}

function loadIconColor(url: string): Promise<Rgb | null> {
    const inFlight = pending.get(url);
    if (inFlight) return inFlight;

    const request = readIconColor(url).then((color) => {
        colorCache.set(url, color);
        pending.delete(url);
        return color;
    });
    pending.set(url, request);
    return request;
}

/**
 * The dominant colour of a token icon, or null while it loads and for icons
 * with no usable colour (monochrome art, or one no source could decode).
 */
export function useIconAccentColor(icon?: string | null): Rgb | null {
    const url = isIconUrl(icon) ? (icon as string) : null;
    const [color, setColor] = useState<Rgb | null>(() =>
        url ? (colorCache.get(url) ?? null) : null,
    );

    useEffect(() => {
        if (!url) {
            setColor(null);
            return;
        }
        if (colorCache.has(url)) {
            setColor(colorCache.get(url) ?? null);
            return;
        }

        let active = true;
        setColor(null);
        loadIconColor(url).then((next) => {
            if (active) setColor(next);
        });
        return () => {
            active = false;
        };
    }, [url]);

    return color;
}

/**
 * Custom properties for a surface tinted by an icon's colour. Returns undefined
 * when there is no colour, so the element keeps whatever background it declares.
 */
export function iconTintVars(color: Rgb | null): CSSProperties | undefined {
    if (!color) return undefined;
    const { r, g, b } = color;
    return {
        "--icon-tint": `rgb(${r} ${g} ${b} / 0.12)`,
        "--icon-tint-hover": `rgb(${r} ${g} ${b} / 0.2)`,
    } as CSSProperties;
}
