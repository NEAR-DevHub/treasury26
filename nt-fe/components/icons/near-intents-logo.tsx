"use client";

import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

interface NearIntentsLogoProps {
    className?: string;
}

/**
 * Theme-aware NEAR Intents brand logo.
 */
export function NearIntentsLogo({ className }: NearIntentsLogoProps) {
    const { resolvedTheme } = useTheme();
    const src =
        resolvedTheme === "dark"
            ? "/near-intents-dark.svg"
            : "/near-intents-light.svg";

    return (
        <img src={src} alt="NEAR Intents" className={cn("h-4", className)} />
    );
}
