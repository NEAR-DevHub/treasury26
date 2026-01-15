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
    differentLine?: boolean;
    afterValue?: React.ReactNode;

    style?: "default" | "secondary";
}

interface InfoDisplayProps {
    items: InfoItem[];
    expandableItems?: InfoItem[];
    className?: string;
    style?: "default" | "secondary";
}

const styleVariants = cva("flex flex-col gap-2", {
    variants: {
        style: {
            default: "",
            secondary: "bg-general-tertiary text-secondary-foreground",
        }
    },
    defaultVariants: {
        style: "default",
    }
})

const lineVariants = cva("border-b border-border p-1 pb-4", {
    variants: {
        style: {
            default: "",
            secondary: "border-foreground/10",
        }
    },
    defaultVariants: {
        style: "default",
    }
})

export function InfoDisplay({ items, expandableItems, className, style = "default" }: InfoDisplayProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const hasExpandableItems = expandableItems && expandableItems.length > 0;

    const displayItems = isExpanded ? [...items, ...expandableItems!] : items;

    return (
        <div className={styleVariants({ style, className })}>
            {displayItems.map((item, index) => (
                <div key={index} className={cn("flex flex-col gap-2", lineVariants({ style, className: !hasExpandableItems && "last:border-b-0" }))}>
                    <div className={cn("flex justify-between items-center flex-wrap", item.differentLine && "flex-col items-start gap-2")}>
                        <div className="flex items-center gap-2">
                            <p className="text-sm text-muted-foreground">{item.label}</p>
                            {item.info && <Tooltip content={item.info}>
                                <Info className="w-4 h-4 text-muted-foreground" />
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
