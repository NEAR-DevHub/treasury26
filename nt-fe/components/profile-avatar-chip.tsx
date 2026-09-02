"use client";

import { User02Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

interface ProfileAvatarChipProps {
    /** The account's own picture. Falls back to the icon when absent/broken. */
    imageUrl?: string;
    /** Alt text for the picture. */
    name?: string;
    className?: string;
}

/**
 * The 28px account chip used by the sidebar's profile-menu trigger and the
 * address tooltip: the account's picture when it has one, otherwise a user
 * glyph on brand green. `rounded-sm` is the design's 8px — this project rebases
 * the radius scale on `--radius: 0.75rem`, so `rounded-lg` would be 12px.
 */
export function ProfileAvatarChip({
    imageUrl,
    name,
    className,
}: ProfileAvatarChipProps) {
    // Keyed by URL rather than a boolean so a changed picture gets a fresh try.
    // The URL that failed stays broken for the lifetime of this mounted
    // instance, though, so a flaky host that recovers keeps showing the glyph
    // until the chip remounts.
    const [brokenImageUrl, setBrokenImageUrl] = useState<string>();

    const containerClass = cn("size-7 shrink-0 rounded-sm", className);

    if (imageUrl && imageUrl !== brokenImageUrl) {
        return (
            // biome-ignore lint/performance/noImgElement: arbitrary remote hosts, which `next/image` cannot optimise
            <img
                src={imageUrl}
                alt={name ?? ""}
                className={cn(containerClass, "object-cover")}
                onError={() => setBrokenImageUrl(imageUrl)}
            />
        );
    }

    return (
        <span
            className={cn(
                containerClass,
                "flex items-center justify-center bg-green-700 text-white",
            )}
        >
            <Icon icon={User02Icon} fill="white" />
        </span>
    );
}
