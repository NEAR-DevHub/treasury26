"use client";

import { useImageLoadError } from "@/hooks/use-image-load-error";
import { isIconUrl } from "@/lib/icon-url";
import { cn } from "@/lib/utils";

export function DepositOptionIcon({
    icon,
    name,
    gradient,
}: {
    icon: string;
    name: string;
    gradient?: string;
}) {
    const iconUrl = isIconUrl(icon) ? icon : null;
    const { showImage, onError } = useImageLoadError(iconUrl);
    const fallbackLabel = (name || icon || "?").charAt(0).toUpperCase();

    if (showImage && iconUrl) {
        return (
            <div className="w-6 h-6 rounded-full overflow-hidden shrink-0">
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
                "w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-normal shrink-0",
                gradient ?? "bg-brand-blue",
            )}
        >
            {iconUrl || !icon || icon.length > 2 ? fallbackLabel : icon}
        </div>
    );
}
