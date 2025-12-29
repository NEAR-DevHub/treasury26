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
    if (treasury?.config?.metadata?.primaryColor) {
      const primaryColor = treasury.config.metadata.primaryColor;
      
      // Convert hex to RGB
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

