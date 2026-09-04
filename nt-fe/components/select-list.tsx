"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { isIconUrl } from "@/lib/icon-url";
import { cn } from "@/lib/utils";
import { EmptySelectorIcon } from "./selector-field";
import { SelectorOptionRow } from "./selector-option-row";
import { TokenIconImage } from "./token-icon-image";
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

const SELECT_LIST_SKELETON_IDS = [
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
] as const;

export function SelectListSkeleton() {
    return (
        <div className="space-y-1 animate-pulse">
            {SELECT_LIST_SKELETON_IDS.map((skeletonId) => (
                <div
                    key={skeletonId}
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
    const containerSizeClass =
        size === "sm"
            ? "size-6"
            : size === "lg"
              ? "size-14"
              : "size-10 aspect-square";
    // Remote artwork fills more of the container than a one- or two-character
    // glyph does, so the two kinds of icon are sized differently.
    const imageSizeClass =
        size === "sm" ? "size-5" : size === "lg" ? "size-10" : "size-10";
    const emptyIcon = <EmptySelectorIcon className={containerSizeClass} />;

    if (!isIconUrl(icon)) {
        return emptyIcon;
    }

    return (
        <div
            className={cn(
                containerSizeClass,
                "flex items-center justify-center",
            )}
        >
            <TokenIconImage
                icon={icon}
                alt={alt}
                gradient={gradient || "bg-brand-blue"}
                className={imageSizeClass}
                objectFit="contain"
                fallback={emptyIcon}
            />
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
                    <SelectorOptionRow
                        key={item.id}
                        selected={selectedId === item.id}
                        onClick={() => onSelect(item)}
                        icon={
                            renderIcon ? (
                                renderIcon(item)
                            ) : (
                                <SelectListIcon
                                    icon={item.icon}
                                    gradient={item.gradient}
                                    alt={item.symbol || item.name}
                                />
                            )
                        }
                        trailing={renderRight?.(item)}
                        {...(renderContent
                            ? { children: renderContent(item) }
                            : { primary, secondary })}
                    />
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
