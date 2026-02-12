"use client";

import { Search } from "lucide-react";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";
import { useState, useEffect, useRef } from "react";

interface LargeInputProps extends React.ComponentProps<typeof Input> {
    search?: boolean;
    borderless?: boolean;
    suffix?: string;
    /**
     * When true, font size will dynamically adjust based on input length to prevent overflow.
     * Default: false
     */
    dynamicFontSize?: boolean;
}

export function LargeInput({
    className,
    search,
    borderless,
    suffix,
    value,
    dynamicFontSize = false,
    ...props
}: LargeInputProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const [fontSize, setFontSize] = useState("!text-xl");

    useEffect(() => {
        // Skip dynamic font sizing if not enabled
        if (!dynamicFontSize) {
            setFontSize("!text-xl");
            return;
        }

        const calculateFontSize = () => {
            if (!containerRef.current || !inputRef.current) return;

            const stringValue = value?.toString() || "";
            if (!stringValue || stringValue === "0") {
                setFontSize("!text-3xl");
                return;
            }

            const containerWidth = containerRef.current.offsetWidth;
            // Reserve space for padding and suffix
            const reservedSpace = suffix ? 100 : 20;
            const availableWidth = containerWidth - reservedSpace;

            // Font size options with approximate character widths (in px per character)
            const fontSizes = [
                { class: "!text-3xl", charWidth: 20 }, // ~20px per char
                { class: "!text-2xl", charWidth: 15 }, // ~15px per char
                { class: "!text-xl", charWidth: 12 }, // ~12px per char
                { class: "!text-lg", charWidth: 10 }, // ~10px per char
                { class: "!text-base", charWidth: 8 }, // ~8px per char
            ];

            // Find the largest font size that fits
            for (const size of fontSizes) {
                const estimatedWidth = stringValue.length * size.charWidth;
                if (estimatedWidth <= availableWidth) {
                    setFontSize(size.class);
                    return;
                }
            }

            // If nothing fits, use the smallest
            setFontSize("!text-base");
        };

        calculateFontSize();

        // Observe container size changes
        const resizeObserver = new ResizeObserver(calculateFontSize);
        if (containerRef.current) {
            resizeObserver.observe(containerRef.current);
        }

        return () => {
            resizeObserver.disconnect();
        };
    }, [value, suffix, dynamicFontSize]);

    return (
        <div ref={containerRef} className="relative">
            {search && (
                <div className="absolute left-3 top-1/2 -translate-y-1/2">
                    <Search className="size-4 text-muted-foreground" />
                </div>
            )}
            <Input
                ref={inputRef}
                autoComplete="off"
                autoCorrect="off"
                {...props}
                value={value}
                className={cn(
                    "h-12 shrink-0 p-0 bg-transparent!",
                    search && "pl-10",
                    suffix && "pr-2",
                    borderless &&
                    "border-none focus-visible:ring-0 focus-visible:ring-offset-0",
                    className,
                    fontSize, // Apply dynamic font size last so it takes precedence
                )}
            />
            {suffix && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <span className={cn("text-muted-foreground", fontSize)}>
                        {suffix}
                    </span>
                </div>
            )}
        </div>
    );
}
