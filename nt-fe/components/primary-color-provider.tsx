"use client";

import { useTreasuryConfig } from "@/hooks/use-treasury-queries";
import { useEffect } from "react";

interface PrimaryColorProviderProps {
  treasuryId?: string;
}

/**
 * Component that dynamically applies the primary color from treasury config
 * to the CSS --primary variable for button colors
 */
export function PrimaryColorProvider({ treasuryId }: PrimaryColorProviderProps) {
  const { data: treasury } = useTreasuryConfig(treasuryId);

  useEffect(() => {
    if (treasury?.metadata?.primaryColor) {
      const primaryColor = treasury.metadata.primaryColor;

      // Special handling for black color - use white in dark mode
      if (primaryColor === "#000000") {
        // Check if dark mode is active
        const isDarkMode = document.documentElement.classList.contains("dark");

        if (isDarkMode) {
          // In dark mode, use white
          document.documentElement.style.setProperty("--primary", "rgb(255, 255, 255)");
          document.documentElement.style.setProperty("--primary-foreground", "rgb(25, 25, 26)");
        } else {
          // In light mode, use black
          document.documentElement.style.setProperty("--primary", "rgb(0, 0, 0)");
          document.documentElement.style.setProperty("--primary-foreground", "rgb(250, 250, 250)");
        }

        // Listen for theme changes
        const observer = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            if (mutation.attributeName === "class") {
              const isDarkMode = document.documentElement.classList.contains("dark");
              if (isDarkMode) {
                document.documentElement.style.setProperty("--primary", "rgb(255, 255, 255)");
                document.documentElement.style.setProperty("--primary-foreground", "rgb(25, 25, 26)");
              } else {
                document.documentElement.style.setProperty("--primary", "rgb(0, 0, 0)");
                document.documentElement.style.setProperty("--primary-foreground", "rgb(250, 250, 250)");
              }
            }
          });
        });

        observer.observe(document.documentElement, { attributes: true });

        return () => observer.disconnect();
      }

      // Convert hex to RGB for other colors
      const hexToRgb = (hex: string) => {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
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
          `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`
        );

        // Calculate foreground color (white or black based on luminance)
        const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
        const foregroundColor = luminance > 0.5 ? "rgb(25, 25, 26)" : "rgb(250, 250, 250)";

        document.documentElement.style.setProperty(
          "--primary-foreground",
          foregroundColor
        );
      }
    } else {
      // Reset to default when no treasury or no primary color
      document.documentElement.style.removeProperty("--primary");
      document.documentElement.style.removeProperty("--primary-foreground");
    }
  }, [treasury]);

  return null; // This component doesn't render anything
}

