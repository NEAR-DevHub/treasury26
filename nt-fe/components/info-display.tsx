"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import { Tooltip } from "./tooltip";
import { Button } from "./button";
import { cva } from "class-variance-authority";

export interface InfoItem {
    label: string;
    value: string | number | React.ReactNode;
    info?: string;
    afterValue?: React.ReactNode;
    subItem?: boolean;

    style?: "default" | "secondary";
}

interface InfoDisplayProps {
    items: InfoItem[];
    expandableItems?: InfoItem[];
    className?: string;
    style?: "default" | "secondary";
    size?: "default" | "sm";
    hideSeparator?: boolean;
}

const styleVariants = cva("flex flex-col", {
    variants: {
        style: {
            default: "",
            secondary: "bg-general-tertiary text-secondary-foreground",
        },
        size: {
            default: "gap-2",
            sm: "gap-0",
        },
    },
    defaultVariants: {
        style: "default",
        size: "default",
    },
});

const lineVariants = cva("border-b border-border p-1 pb-4", {
    variants: {
        style: {
            default: "",
            secondary: "border-foreground/10",
        },
        size: {
            default: "",
            sm: "p-0 py-1.5",
        },
    },
    defaultVariants: {
        style: "default",
        size: "default",
    },
});

export function InfoDisplay({
    items,
    expandableItems,
    className,
    style = "default",
    size = "default",
    hideSeparator = false,
}: InfoDisplayProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const hasExpandableItems = expandableItems && expandableItems.length > 0;

    const displayItems = isExpanded ? [...items, ...expandableItems!] : items;

    return (
        <div className={styleVariants({ style, size, className })}>
            {displayItems.map((item, index) => (
                <div
                    key={index}
                    className={cn(
                        "flex flex-col gap-2",
                        lineVariants({
                            style,
                            size,
                            className: !hasExpandableItems && "last:border-b-0",
                        }),
                        hideSeparator && "border-b-0",
                        item.subItem && "pl-5",
                    )}
                >
                    <div className="flex justify-between items-center flex-wrap">
                        <div className="flex items-center gap-1">
                            <p className="text-sm text-muted-foreground">
                                {item.label}
                            </p>
                            {item.info && (
                                <Tooltip content={item.info}>
                                    <Info className="size-3 shrink-0 text-muted-foreground" />
                                </Tooltip>
                            )}
                        </div>
                        <div className="text-sm font-medium text-wrap">
                            {item.value}
                        </div>
                    </div>
                    {item.afterValue && (
                        <div className="flex flex-col gap-2">
                            {item.afterValue}
                        </div>
                    )}
                </div>
            ))}
            {hasExpandableItems && (
                <Button
                    variant="ghost"
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="flex gap-2 w-full justify-center mt-2"
                >
                    {isExpanded ? "View Less" : "View All Details"}
                    {isExpanded ? (
                        <ChevronUp className="w-4 h-4" />
                    ) : (
                        <ChevronDown className="w-4 h-4" />
                    )}
                </Button>
            )}
        </div>
    );
}
