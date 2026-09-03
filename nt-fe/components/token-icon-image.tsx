"use client";

import { useImageLoadError } from "@/hooks/use-image-load-error";
import { isIconUrl } from "@/lib/icon-url";
import { cn } from "@/lib/utils";

const tokenIconSizeClasses = {
    sm: "size-4",
    md: "size-5",
    lg: "size-6",
    xl: "size-9",
    "2xl": "size-10",
    "3xl": "size-11",
} as const;

export type TokenIconSize = keyof typeof tokenIconSizeClasses;

const networkIconSizeClasses = {
    sm: "size-2.5",
    md: "size-3",
    lg: "size-3",
    xl: "size-4",
    "2xl": "size-4",
    "3xl": "size-4",
} as const satisfies Record<TokenIconSize, string>;

const discClassName = "rounded-full shrink-0";

/** Outline the empty circle while the remote image is still fetching. */
const loadingDiscClassName =
    "bg-card ring-1 ring-black/10 dark:ring-white/10 shadow-[0_1px_2px_rgba(0,0,0,0.16)]";

const networkBadgeClassName =
    "absolute right-0 bottom-0 z-10 flex items-center justify-center overflow-hidden rounded-full border-2 border-card bg-card shadow-[0_1px_3px_rgba(0,0,0,0.28)]";

function iconFallbackLabel(icon: string | null | undefined, alt: string) {
    if (icon && !isIconUrl(icon) && icon.length <= 2) return icon;
    // Never fall back to `icon` here: a decorative icon passes a URL and an
    // empty alt, which would paint a path character in the disc.
    return alt.charAt(0).toUpperCase();
}

export function TokenIconImage({
    icon,
    alt,
    size,
    className,
    gradient,
    badge = false,
    objectFit = "cover",
}: {
    icon?: string | null;
    alt: string;
    /** TokenDisplay scale. Omit when the caller already sets width/height. */
    size?: TokenIconSize;
    className?: string;
    gradient?: string;
    /** Sit as the network overlay: card ring, shadow, bottom-right. */
    badge?: boolean;
    objectFit?: "cover" | "contain";
}) {
    const iconUrl = isIconUrl(icon) ? icon : null;
    const image = useImageLoadError(iconUrl);
    const label = iconFallbackLabel(icon, alt);

    if (badge) {
        if (!image.showImage || !iconUrl) return null;
        return (
            <span className={cn(networkBadgeClassName, className)}>
                {/* biome-ignore lint/performance/noImgElement: remote token icons need onError fallback */}
                <img
                    key={iconUrl}
                    src={iconUrl}
                    alt={alt}
                    className={cn(
                        "block shrink-0 rounded-full object-cover",
                        size ? networkIconSizeClasses[size] : "size-full",
                    )}
                    onError={image.onError}
                />
            </span>
        );
    }

    const sizeClass = size && tokenIconSizeClasses[size];

    if (image.showImage && iconUrl) {
        return (
            // biome-ignore lint/performance/noImgElement: remote token icons need onError fallback
            <img
                // Remount on src change so the previous icon's pixels cannot
                // linger under the loading ring.
                key={iconUrl}
                src={iconUrl}
                alt={alt}
                className={cn(
                    discClassName,
                    sizeClass,
                    objectFit === "contain" ? "object-contain" : "object-cover",
                    image.isLoading && loadingDiscClassName,
                    className,
                )}
                // An icon cached before hydration never fires `onLoad`, which
                // would leave the loading ring on for good.
                ref={(el) => {
                    if (el?.complete) image.onLoad();
                }}
                onLoad={image.onLoad}
                onError={image.onError}
            />
        );
    }

    return (
        <div
            aria-hidden="true"
            className={cn(
                discClassName,
                sizeClass,
                "flex items-center justify-center text-xs font-normal text-white",
                gradient || "bg-brand-blue",
                className,
            )}
        >
            {label}
        </div>
    );
}
