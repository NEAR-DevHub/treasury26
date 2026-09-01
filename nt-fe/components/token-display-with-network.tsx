"use client";

import { useImageLoadError } from "@/hooks/use-image-load-error";
import type { ChainIcons } from "@/lib/api";
import { isIconUrl } from "@/lib/icon-url";
import { cn } from "@/lib/utils";

const iconSizeClasses = {
    sm: "size-4",
    md: "size-5",
    lg: "size-6",
    xl: "size-9",
    "2xl": "size-10 border border-[rgba(23,23,23,0.1)]",
    "3xl": "size-11 border border-[rgba(23,23,23,0.1)]",
} as const;

export type TokenIconSize = keyof typeof iconSizeClasses;

const networkIconSizeClasses = {
    sm: "size-2.5",
    md: "size-3",
    lg: "size-3",
    xl: "size-4",
    "2xl": "size-4",
    "3xl": "size-4",
} as const satisfies Record<TokenIconSize, string>;

interface TokenDisplayProps {
    symbol: string;
    icon: string;
    chainIcons?: ChainIcons;
    iconSize?: TokenIconSize;
    /** Overrides the icon geometry when a call site needs an off-scale size. */
    className?: string;
}

export const TokenDisplay = ({
    symbol,
    icon,
    chainIcons,
    iconSize = "md",
    className,
}: TokenDisplayProps) => {
    const tokenIconUrl = isIconUrl(icon) ? icon : null;
    const networkIcon = chainIcons?.icon ?? null;
    const tokenImage = useImageLoadError(tokenIconUrl);
    const networkImage = useImageLoadError(networkIcon);

    return (
        <div className="relative flex">
            {tokenImage.showImage && tokenIconUrl ? (
                <img
                    key={tokenIconUrl}
                    src={tokenIconUrl}
                    alt={symbol}
                    className={cn(
                        "rounded-full shrink-0",
                        iconSizeClasses[iconSize],
                        className,
                    )}
                    onError={tokenImage.onError}
                />
            ) : (
                <div
                    className={cn(
                        "rounded-full bg-brand-blue flex items-center justify-center text-xs text-white font-normal shrink-0",
                        iconSizeClasses[iconSize],
                        className,
                    )}
                >
                    {tokenIconUrl || !icon
                        ? symbol.charAt(0).toUpperCase()
                        : icon}
                </div>
            )}
            {networkImage.showImage && networkIcon && (
                <div className="absolute -right-0 -bottom-0 flex items-center justify-center overflow-hidden rounded-full border-1 border-card bg-card">
                    <img
                        key={networkIcon}
                        src={networkIcon}
                        alt="network"
                        className={cn(
                            "shrink-0 overflow-hidden rounded-full object-cover",
                            networkIconSizeClasses[iconSize],
                        )}
                        onError={networkImage.onError}
                    />
                </div>
            )}
        </div>
    );
};
