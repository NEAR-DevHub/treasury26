"use client";

import type { ComponentProps } from "react";
import { NetworkBadge } from "@/components/network-badge";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type NetworkBadgeProps = ComponentProps<typeof NetworkBadge>;

export interface NetworkListItem {
    key: string;
    name: string;
    icon: string;
}

interface NetworkListProps {
    chains: NetworkListItem[];
    maxVisible?: number;
    className?: string;
    badgeVariant?: NetworkBadgeProps["variant"];
    badgeSize?: NetworkBadgeProps["size"];
    badgeIconOnly?: boolean;
    popoverAlign?: "start" | "center" | "end";
    popoverContentClassName?: string;
}

export function NetworkList({
    chains,
    maxVisible = 3,
    className,
    badgeVariant,
    badgeSize = "sm",
    badgeIconOnly = false,
    popoverAlign = "end",
    popoverContentClassName,
}: NetworkListProps) {
    if (chains.length === 0) {
        return null;
    }

    const visibleChains = chains.slice(0, maxVisible);
    const hiddenChains = chains.slice(maxVisible);

    return (
        <div className={cn("flex flex-wrap items-center gap-1", className)}>
            {visibleChains.map((chain) => (
                <NetworkBadge
                    key={chain.key}
                    name={chain.name}
                    variant={badgeVariant}
                    iconOnly={badgeIconOnly}
                    size={badgeSize}
                    icon={chain.icon}
                />
            ))}

            {hiddenChains.length > 0 && (
                <Popover>
                    <PopoverTrigger
                        onClick={(event) => event.stopPropagation()}
                    >
                        <NetworkBadge
                            name={`+${hiddenChains.length}`}
                            variant={badgeVariant}
                            size={badgeSize}
                            className="cursor-pointer"
                        />
                    </PopoverTrigger>
                    <PopoverContent
                        align={popoverAlign}
                        className={cn(
                            "w-auto max-w-56 h-[200px] p-2",
                            popoverContentClassName,
                        )}
                        onClick={(event) => event.stopPropagation()}
                    >
                        <ScrollArea className="h-full">
                            <div className="flex flex-col gap-1">
                                {hiddenChains.map((chain) => (
                                    <NetworkBadge
                                        key={chain.key}
                                        name={chain.name}
                                        variant={"secondary"}
                                        size={"sm"}
                                        icon={chain.icon}
                                        className="w-full justify-start"
                                    />
                                ))}
                            </div>
                        </ScrollArea>
                    </PopoverContent>
                </Popover>
            )}
        </div>
    );
}
