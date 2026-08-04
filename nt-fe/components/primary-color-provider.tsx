"use client";

import { useEffect } from "react";
import { useTreasuryConfig } from "@/hooks/use-treasury-queries";

interface PrimaryColorProviderProps {
    treasuryId?: string;
}

interface Rgb {
    r: number;
    g: number;
    b: number;
}

// Color constants — the label colours are the `--primary-foreground` values the
// themes ship in globals.css.
const COLORS = {
    WHITE: { r: 255, g: 255, b: 255 },
    DARK_TEXT: { r: 25, g: 25, b: 26 },
    LIGHT_TEXT: { r: 250, g: 250, b: 250 },
} as const;

function toCss({ r, g, b }: Rgb) {
    return `rgb(${r}, ${g}, ${b})`;
}

function hexToRgb(hex: string): Rgb | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
        ? {
              r: parseInt(result[1], 16),
              g: parseInt(result[2], 16),
              b: parseInt(result[3], 16),
          }
        : null;
}

/**
 * Component that dynamically applies the primary color from treasury config
 * to the CSS --primary variable for button colors.
 *
 * `--primary` and `--primary-foreground` are always written as a pair: the
 * label has to follow the surface it sits on. Setting only one of them is what
 * left white labels on the white dark-theme buttons.
 */
export function PrimaryColorProvider({
    treasuryId,
}: PrimaryColorProviderProps) {
    const { data: treasury } = useTreasuryConfig(treasuryId);
    const primaryColor = treasury?.metadata?.primaryColor;

    useEffect(() => {
        const root = document.documentElement;
        const clear = () => {
            root.style.removeProperty("--primary");
            root.style.removeProperty("--primary-foreground");
        };

        const rgb = primaryColor ? hexToRgb(primaryColor) : null;
        if (!rgb) {
            // No brand colour — fall back to the theme tokens in globals.css.
            clear();
            return;
        }

        // Black is the only theme-dependent choice: it flips to white in the
        // dark theme so the button stays visible against the dark page. Every
        // other brand colour keeps a white label in both themes.
        const isBlack = rgb.r === 0 && rgb.g === 0 && rgb.b === 0;

        const apply = () => {
            const isDark = root.classList.contains("dark");
            const [surface, foreground] = !isBlack
                ? [rgb, COLORS.WHITE]
                : isDark
                  ? [COLORS.WHITE, COLORS.DARK_TEXT]
                  : [rgb, COLORS.LIGHT_TEXT];

            root.style.setProperty("--primary", toCss(surface));
            root.style.setProperty("--primary-foreground", toCss(foreground));
        };

        apply();

        if (!isBlack) return clear;

        // Re-run when next-themes toggles the `dark` class on <html>.
        const observer = new MutationObserver(apply);
        observer.observe(root, {
            attributes: true,
            attributeFilter: ["class"],
        });

        return () => {
            observer.disconnect();
            clear();
        };
    }, [primaryColor]);

    return null; // This component doesn't render anything
}
