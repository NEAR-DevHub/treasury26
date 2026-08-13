"use client";

import { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useImageLoadError } from "@/hooks/use-image-load-error";
import { isIconUrl } from "@/lib/icon-url";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { ScrollArea } from "./ui/scroll-area";

export interface SelectListItem {
    id: string;
    name: string;
    symbol?: string;
    icon: string;
    gradient?: string;
    disabled?: boolean;
}

/** near.com-style list labels: ticker primary, full name secondary when distinct. */
export function getSelectOptionLabels(item: {
    name?: string;
    symbol?: string;
}): { primary: string; secondary: string | null } {
    const primary = item.symbol || item.name || "";
    const secondary =
        item.symbol && item.name && item.name !== item.symbol
            ? item.name
            : null;
    return { primary, secondary };
}

interface SelectListProps<T extends SelectListItem> {
    items: T[];
    onSelect: (item: T) => void;
    isLoading?: boolean;
    selectedId?: string;
    emptyMessage?: string;
    renderIcon?: (item: T) => ReactNode;
    renderContent?: (item: T) => ReactNode;
    renderRight?: (item: T) => ReactNode;
}

export function SelectListSkeleton() {
    return (
        <div className="space-y-1 animate-pulse">
            {[...Array(8)].map((_, i) => (
                <div
                    key={i}
                    className="w-full flex items-center gap-3 py-3 rounded-lg"
                >
                    <div className="w-10 h-10 rounded-full bg-general-unofficial-accent-0 shrink-0" />
                    <div className="flex-1 space-y-2">
                        <div className="h-4 bg-general-unofficial-accent-0 rounded w-24" />
                        <div className="h-3 bg-general-unofficial-accent-0 rounded w-32" />
                    </div>
                </div>
            ))}
        </div>
    );
}

export function SelectListIcon({
    icon,
    gradient,
    alt,
    size = "md",
}: {
    icon?: string;
    gradient?: string;
    alt: string;
    size?: "sm" | "md" | "lg";
}) {
    const iconIsUrl = isIconUrl(icon);
    const { showImage, onError } = useImageLoadError(iconIsUrl ? icon : null);
    const containerSizeClass =
        size === "sm" ? "size-6" : size === "lg" ? "size-14" : "size-12";
    const imagePaddingClass = size === "sm" ? "p-0.5" : "p-2";
    const fallbackSizeClass =
        size === "sm" ? "w-3.5 h-3.5 text-[9px]" : "w-8 h-8";

    const fallbackLabel =
        icon && !iconIsUrl && icon.length <= 2
            ? icon
            : (alt || "?").charAt(0).toUpperCase();

    if (showImage && icon) {
        return (
            <div className={containerSizeClass}>
                <img
                    key={icon}
                    src={icon}
                    alt={alt}
                    className={cn(
                        "w-full h-full object-contain rounded-full",
                        imagePaddingClass,
                    )}
                    onError={onError}
                />
            </div>
        );
    }

    return (
        <div
            className={cn(
                containerSizeClass,
                "flex items-center justify-center",
            )}
        >
            <div
                className={cn(
                    "rounded-full flex items-center justify-center text-white font-normal",
                    fallbackSizeClass,
                    gradient || "bg-brand-blue",
                )}
            >
                <span>{fallbackLabel}</span>
            </div>
        </div>
    );
}

export function SelectList<T extends SelectListItem>({
    items,
    onSelect,
    isLoading = false,
    selectedId,
    emptyMessage,
    renderIcon,
    renderContent,
    renderRight,
}: SelectListProps<T>) {
    const tSelect = useTranslations("selectList");
    const effectiveEmptyMessage = emptyMessage ?? tSelect("noResults");
    if (isLoading) {
        return <SelectListSkeleton />;
    }

    return (
        <ScrollArea className="h-[400px]">
            {items.map((item) => {
                const { primary, secondary } = getSelectOptionLabels(item);
                return (
                    <Button
                        key={item.id}
                        onClick={() => onSelect(item)}
                        variant="ghost"
                        className={cn(
                            "w-full flex items-center gap-1 py-3 rounded-lg h-auto justify-start pl-1!",
                            selectedId === item.id && "bg-muted",
                        )}
                    >
                        {renderIcon ? (
                            renderIcon(item)
                        ) : (
                            <SelectListIcon
                                icon={item.icon}
                                gradient={item.gradient}
                                alt={item.symbol || item.name}
                            />
                        )}
                        {renderContent ? (
                            renderContent(item)
                        ) : (
                            <div className="flex-1 text-left">
                                <div className="font-semibold">{primary}</div>
                                {secondary && (
                                    <div className="text-sm text-muted-foreground">
                                        {secondary}
                                    </div>
                                )}
                            </div>
                        )}
                        {renderRight?.(item)}
                    </Button>
                );
            })}
            {items.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                    {effectiveEmptyMessage}
                </div>
            )}
        </ScrollArea>
    );
}
