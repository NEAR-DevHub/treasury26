"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import { Tooltip } from "./tooltip";
import { Button } from "./ui/button";

export interface InfoItem {
    label: string;
    value: string | number | React.ReactNode;
    info?: string;
    differentLine?: boolean;
}

interface InfoDisplayProps {
    items: InfoItem[];
    expandableItems?: InfoItem[];
    className?: string;
}

export function InfoDisplay({ items, expandableItems, className }: InfoDisplayProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const hasExpandableItems = expandableItems && expandableItems.length > 0;

    const displayItems = isExpanded ? [...items, ...expandableItems!] : items;

    return (
        <div className={`flex flex-col gap-2 ${className || ""}`}>
            {displayItems.map((item, index) => (
                <div key={index} className={cn("flex justify-between items-center border-b border-border pb-4", item.differentLine && "flex-col items-start gap-2")}>
                    <div className="flex items-center gap-2">
                        <p className="text-sm text-muted-foreground">{item.label}</p>
                        {item.info && <Tooltip content={item.info}>
                            <Info className="w-4 h-4 text-muted-foreground" />
                        </Tooltip>}
                    </div>
                    <div className="text-sm font-medium">{item.value}</div>
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
