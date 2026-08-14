"use client";

import { useImageLoadError } from "@/hooks/use-image-load-error";
import type { ChainIcons } from "@/lib/api";
import { isIconUrl } from "@/lib/icon-url";
import { cn } from "@/lib/utils";

interface TokenDisplayProps {
    symbol: string;
    icon: string;
    chainIcons?: ChainIcons;
    iconSize?: "sm" | "md" | "lg" | "xl";
}

const iconSizeClasses = {
    sm: "size-4",
    md: "size-5",
    lg: "size-6",
    xl: "size-9",
};

const networkIconSizeClasses = {
    sm: "size-2.5",
    md: "size-3",
    lg: "size-3",
    xl: "size-4",
};

export const TokenDisplay = ({
    symbol,
    icon,
    chainIcons,
    iconSize = "md",
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
                    )}
                    onError={tokenImage.onError}
                />
            ) : (
                <div
                    className={cn(
                        "rounded-full bg-brand-blue flex items-center justify-center text-xs text-white font-normal shrink-0",
                        iconSizeClasses[iconSize],
                    )}
                >
                    {tokenIconUrl || !icon
                        ? symbol.charAt(0).toUpperCase()
                        : icon}
                </div>
            )}
            {networkImage.showImage && networkIcon && (
                <div className="absolute -right-1 -bottom-1 flex items-center justify-center rounded-full bg-muted border border-border">
                    <img
                        key={networkIcon}
                        src={networkIcon}
                        alt="network"
                        className={cn(
                            "shrink-0 p-0.5",
                            networkIconSizeClasses[iconSize],
                        )}
                        onError={networkImage.onError}
                    />
                </div>
            )}
        </div>
    );
};
