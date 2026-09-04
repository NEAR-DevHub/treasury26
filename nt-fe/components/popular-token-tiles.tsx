"use client";

import { cn } from "@/lib/utils";
import { Button } from "./button";
import { HighlightedText } from "./highlighted-text";
import { TokenIconImage } from "./token-icon-image";

export type PopularTokenTileItem = {
    id: string;
    icon?: string;
    gradient?: string;
    symbol?: string;
    name?: string;
    disabled?: boolean;
};

export function PopularTokenTiles<T extends PopularTokenTileItem>({
    items,
    searchQuery = "",
    onSelect,
    isItemSelected,
}: {
    items: T[];
    searchQuery?: string;
    onSelect: (item: T) => void;
    isItemSelected?: (item: T) => boolean;
}) {
    return (
        <div className="grid grid-cols-4 gap-2 px-1">
            {items.map((item) => {
                const label = item.symbol || item.name || "";
                const selected = isItemSelected?.(item) ?? false;
                return (
                    <Button
                        key={item.id}
                        type="button"
                        variant="unstyled"
                        disabled={item.disabled}
                        aria-pressed={selected}
                        onClick={() => onSelect(item)}
                        className={cn(
                            "flex h-auto w-full min-w-0 flex-col items-center justify-center gap-2 rounded-xl border border-general-border bg-card p-2 text-foreground hover:bg-card hover:opacity-90 outline-none focus-visible:border-general-border focus-visible:ring-0",
                            selected && "bg-muted",
                            item.disabled && "opacity-60",
                        )}
                    >
                        <TokenIconImage
                            icon={item.icon}
                            alt={label}
                            gradient={item.gradient}
                            className="size-8"
                            objectFit="contain"
                        />
                        <span className="max-w-full truncate text-sm font-semibold leading-tight">
                            <HighlightedText text={label} query={searchQuery} />
                        </span>
                    </Button>
                );
            })}
        </div>
    );
}
