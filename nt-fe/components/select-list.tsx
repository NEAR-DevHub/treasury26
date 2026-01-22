import { ReactNode } from "react";
import { Button } from "./button";
import { ScrollArea } from "./ui/scroll-area";
import { cn } from "@/lib/utils";

export interface SelectListItem {
    id: string;
    name: string;
    symbol?: string;
    icon: string;
    gradient?: string;
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
                    <div className="w-10 h-10 rounded-full bg-muted shrink-0" />
                    <div className="flex-1 space-y-2">
                        <div className="h-4 bg-muted rounded w-24" />
                        <div className="h-3 bg-muted rounded w-32" />
                    </div>
                </div>
            ))}
        </div>
    );
}

export function SelectListIcon({ icon, gradient, alt }: { icon: string; gradient?: string; alt: string }) {
    const isImageUrl = icon?.startsWith("http") || icon?.startsWith("data:");

    if (isImageUrl) {
        return (
            <div className="size-12">
                <img
                    src={icon}
                    alt={alt}
                    className="w-full h-full p-2 rounded-full object-cover"
                />
            </div>
        );
    }

    return (
        <div className="size-12 flex items-center justify-center">
            <div
                className={cn(
                    "w-8 h-8 rounded-full flex items-center justify-center text-white font-bold",
                    gradient || "bg-linear-to-br from-blue-500 to-purple-500"
                )}
            >
                <span>{icon}</span>
            </div>
        </div>
    );
}

export function SelectList<T extends SelectListItem>({
    items,
    onSelect,
    isLoading = false,
    selectedId,
    emptyMessage = "No results found",
    renderIcon,
    renderContent,
    renderRight,
}: SelectListProps<T>) {
    if (isLoading) {
        return <SelectListSkeleton />;
    }

    return (
        <ScrollArea className="h-[400px]">
            {items.map((item) => (
                <Button
                    key={item.id}
                    onClick={() => onSelect(item)}
                    variant="ghost"
                    className={cn(
                        "w-full flex items-center gap-1 py-3 rounded-lg h-auto justify-start pl-1!",
                        selectedId === item.id && "bg-muted"
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
                            <div className="font-semibold">
                                {item.symbol || item.name}
                            </div>
                            {item.symbol && (
                                <div className="text-sm text-muted-foreground">
                                    {item.name}
                                </div>
                            )}
                        </div>
                    )}
                    {renderRight?.(item)}
                </Button>
            ))}
            {items.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                    {emptyMessage}
                </div>
            )}
        </ScrollArea>
    );
}
