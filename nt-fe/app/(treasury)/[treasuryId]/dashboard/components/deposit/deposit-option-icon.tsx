"use client";

import { useImageLoadError } from "@/hooks/use-image-load-error";
import { isIconUrl } from "@/lib/icon-url";
import { cn } from "@/lib/utils";

export function DepositOptionIcon({
    icon,
    name,
    gradient,
    className,
}: {
    icon: string;
    name: string;
    gradient?: string;
    className?: string;
}) {
    const iconUrl = isIconUrl(icon) ? icon : null;
    const { showImage, onError } = useImageLoadError(iconUrl);
    const fallbackLabel = (name || icon || "?").charAt(0).toUpperCase();

    if (showImage && iconUrl) {
        return (
            <div
                className={cn(
                    "size-6 rounded-full overflow-hidden shrink-0",
                    className,
                )}
            >
                <img
                    key={iconUrl}
                    src={iconUrl}
                    alt={name}
                    className="w-full h-full rounded-full object-contain"
                    onError={onError}
                />
            </div>
        );
    }

    return (
        <div
            className={cn(
                "size-6 rounded-full flex items-center justify-center text-white text-xs font-normal shrink-0",
                gradient ?? "bg-brand-blue",
                className,
            )}
        >
            {iconUrl || !icon || icon.length > 2 ? fallbackLabel : icon}
        </div>
    );
}
