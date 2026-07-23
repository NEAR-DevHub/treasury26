"use client";

import { useEffect } from "react";
import { useTreasuryConfig } from "@/hooks/use-treasury-queries";

interface PrimaryColorProviderProps {
    treasuryId?: string;
}

// Color constants
const COLORS = {
    WHITE: "rgb(255, 255, 255)",
    BLACK: "rgb(0, 0, 0)",
    DARK_TEXT: "rgb(25, 25, 26)",
    LIGHT_TEXT: "rgb(250, 250, 250)",
} as const;

/**
 * Component that dynamically applies the primary color from treasury config
 * to the CSS --primary variable for button colors
 */
export function PrimaryColorProvider({
    treasuryId,
}: PrimaryColorProviderProps) {
    const { data: treasury } = useTreasuryConfig(treasuryId);

    useEffect(() => {
        if (treasury?.metadata?.primaryColor) {
            const primaryColor = treasury.metadata.primaryColor;

            // Special handling for black color - use white in dark mode
            if (primaryColor === "#000000") {
                // Check if dark mode is active
                const isDarkMode =
                    document.documentElement.classList.contains("dark");

                if (isDarkMode) {
                    // In dark mode, use white
                    document.documentElement.style.setProperty(
                        "--primary",
                        COLORS.WHITE,
                    );
                    document.documentElement.style.setProperty(
                        "--primary-foreground",
                        COLORS.DARK_TEXT,
                    );
                } else {
                    // In light mode, use black
                    document.documentElement.style.setProperty(
                        "--primary",
                        COLORS.BLACK,
                    );
                    document.documentElement.style.setProperty(
                        "--primary-foreground",
                        COLORS.LIGHT_TEXT,
                    );
                }

                // Listen for theme changes
                const observer = new MutationObserver((mutations) => {
                    mutations.forEach((mutation) => {
                        if (mutation.attributeName === "class") {
                            const isDarkMode =
                                document.documentElement.classList.contains(
                                    "dark",
                                );
                            if (isDarkMode) {
                                document.documentElement.style.setProperty(
                                    "--primary",
                                    COLORS.WHITE,
                                );
                                document.documentElement.style.setProperty(
                                    "--primary-foreground",
                                    COLORS.DARK_TEXT,
                                );
                            } else {
                                document.documentElement.style.setProperty(
                                    "--primary",
                                    COLORS.BLACK,
                                );
                                document.documentElement.style.setProperty(
                                    "--primary-foreground",
                                    COLORS.LIGHT_TEXT,
                                );
                            }
                        }
                    });
                });

                observer.observe(document.documentElement, {
                    attributes: true,
                });

                return () => observer.disconnect();
            }

            // Convert hex to RGB for other colors
            const hexToRgb = (hex: string) => {
                const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(
                    hex,
                );
                return result
                    ? {
                          r: parseInt(result[1], 16),
                          g: parseInt(result[2], 16),
                          b: parseInt(result[3], 16),
                      }
                    : null;
            };

            const rgb = hexToRgb(primaryColor);
            if (rgb) {
                // Set the primary color
                document.documentElement.style.setProperty(
                    "--primary",
                    `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
                );

                // For colored buttons (blue, red, green, etc.), text should always be white
                document.documentElement.style.setProperty(
                    "--primary-foreground",
                    COLORS.WHITE,
                );
            }
        } else {
            // Reset to default when no treasury or no primary color
            document.documentElement.style.removeProperty("--primary");
            document.documentElement.style.removeProperty(
                "--primary-foreground",
            );
        }
    }, [treasury]);

    return null; // This component doesn't render anything
}
