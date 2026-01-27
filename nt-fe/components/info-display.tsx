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

    style?: "default" | "secondary";
}

interface InfoDisplayProps {
    items: InfoItem[];
    expandableItems?: InfoItem[];
    className?: string;
    style?: "default" | "secondary";
    showBorders?: boolean;
    spacing?: "default" | "compact"; 
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
    }
})

const lineVariants = cva("", {
    variants: {
        style: {
            default: "",
            secondary: "border-foreground/10",
        },
        showBorders: {
            true: "border-b border-border",
            false: "",
        },
        spacing: {
            default: "p-1 pb-4",
            compact: "p-1 pb-2",
        }
    },
    defaultVariants: {
        style: "default",
        showBorders: true,
        spacing: "default",
    }
})

export function InfoDisplay({ items, expandableItems, className, style = "default", showBorders = true, spacing = "default" }: InfoDisplayProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const hasExpandableItems = expandableItems && expandableItems.length > 0;

    const displayItems = isExpanded ? [...items, ...expandableItems!] : items;

    return (
        <div className={cn(styleVariants({ style }), className)}>
            {displayItems.map((item, index) => (
                <div key={index} className={cn("flex flex-col gap-2", lineVariants({ style, showBorders, spacing, className: !hasExpandableItems && showBorders && "last:border-b-0" }))}>
                    <div className="flex justify-between items-center flex-wrap">
                        <div className="flex items-center gap-1">
                            <p className="text-sm text-muted-foreground">{item.label}</p>
                            {item.info && <Tooltip content={item.info}>
                                <Info className="size-3 shrink-0 text-muted-foreground" />
                            </Tooltip>}
                        </div>
                        <div className="text-sm font-medium text-wrap">{item.value}</div>
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
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </Button>
            )}
        </div>
    );
}
