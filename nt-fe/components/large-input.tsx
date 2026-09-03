"use client";
import { Icon } from "@/components/icon";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";
import { useState, useEffect, useRef } from "react";

interface LargeInputProps extends React.ComponentProps<typeof Input> {
    search?: boolean;
    borderless?: boolean;
    suffix?: string;
    suffixClassName?: string;
    textSizeClassName?: string;
    containerClassName?: string;
    /**
     * When true, font size will dynamically adjust based on input length to prevent overflow.
     * Default: false
     */
    dynamicFontSize?: boolean;
    /**
     * Starting scale when `dynamicFontSize` is on.
     * `hero` matches the Send amount card (~2.25rem → smaller).
     */
    dynamicFontScale?: "default" | "hero";
}

const DEFAULT_FONT_SIZES = [
    { class: "!text-3xl", charWidth: 20 },
    { class: "!text-2xl", charWidth: 15 },
    { class: "!text-xl", charWidth: 12 },
    { class: "!text-lg", charWidth: 10 },
    { class: "!text-base", charWidth: 8 },
] as const;

/** Amount + symbol pairs — symbol stays ~2/3 of amount. */
const HERO_FONT_SIZES = [
    {
        class: "!text-4xl !leading-10",
        suffixClass: "!text-2xl !leading-tight",
        charWidth: 22,
    },
    {
        class: "!text-3xl !leading-9",
        suffixClass: "!text-xl !leading-tight",
        charWidth: 18,
    },
    {
        class: "!text-2xl !leading-8",
        suffixClass: "!text-base !leading-tight",
        charWidth: 15,
    },
    {
        class: "!text-xl !leading-7",
        suffixClass: "!text-sm !leading-tight",
        charWidth: 12,
    },
    {
        class: "!text-lg !leading-6",
        suffixClass: "!text-xs !leading-tight",
        charWidth: 10,
    },
    {
        class: "!text-base !leading-5",
        suffixClass: "!text-xs !leading-tight",
        charWidth: 8,
    },
] as const;

export function LargeInput({
    className,
    search,
    borderless,
    suffix,
    suffixClassName,
    textSizeClassName,
    containerClassName,
    value,
    dynamicFontSize = false,
    dynamicFontScale = "default",
    style,
    ...props
}: LargeInputProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const suffixRef = useRef<HTMLSpanElement>(null);
    const [fontSize, setFontSize] = useState(
        dynamicFontScale === "hero" ? HERO_FONT_SIZES[0].class : "!text-xl",
    );
    const [suffixFontSize, setSuffixFontSize] = useState(
        dynamicFontScale === "hero"
            ? HERO_FONT_SIZES[0].suffixClass
            : "!text-xl",
    );
    const [suffixWidth, setSuffixWidth] = useState(0);

    useEffect(() => {
        if (suffixRef.current) {
            setSuffixWidth(suffixRef.current.offsetWidth + 12); // 12px = right-3 offset
        } else {
            setSuffixWidth(0);
        }
    }, [suffix, fontSize, suffixFontSize]);

    useEffect(() => {
        // Skip dynamic font sizing if not enabled
        if (!dynamicFontSize) {
            if (dynamicFontScale === "hero") {
                setFontSize(HERO_FONT_SIZES[0].class);
                setSuffixFontSize(HERO_FONT_SIZES[0].suffixClass);
            } else {
                setFontSize("!text-xl");
                setSuffixFontSize("!text-xl");
            }
            return;
        }

        const calculateFontSize = () => {
            if (!containerRef.current || !inputRef.current) return;

            const stringValue = value?.toString() || "";

            if (dynamicFontScale === "hero") {
                if (!stringValue || stringValue === "0") {
                    setFontSize(HERO_FONT_SIZES[0].class);
                    setSuffixFontSize(HERO_FONT_SIZES[0].suffixClass);
                    return;
                }
                const len =
                    stringValue.length + Math.ceil((suffix?.length ?? 0) * 0.6);
                const index = Math.min(
                    HERO_FONT_SIZES.length - 1,
                    Math.max(0, Math.floor((len - 6) / 4)),
                );
                setFontSize(HERO_FONT_SIZES[index].class);
                setSuffixFontSize(HERO_FONT_SIZES[index].suffixClass);
                return;
            }

            if (!stringValue || stringValue === "0") {
                setFontSize(DEFAULT_FONT_SIZES[0].class);
                return;
            }

            const containerWidth = containerRef.current.offsetWidth;
            const reservedSpace = suffix ? Math.max(suffixWidth, 48) + 8 : 20;
            const availableWidth = Math.max(containerWidth - reservedSpace, 40);

            for (const size of DEFAULT_FONT_SIZES) {
                const estimatedWidth = stringValue.length * size.charWidth;
                if (estimatedWidth <= availableWidth) {
                    setFontSize(size.class);
                    return;
                }
            }

            setFontSize(
                DEFAULT_FONT_SIZES[DEFAULT_FONT_SIZES.length - 1].class,
            );
        };

        calculateFontSize();

        const resizeObserver = new ResizeObserver(calculateFontSize);
        if (containerRef.current) {
            resizeObserver.observe(containerRef.current);
        }

        return () => {
            resizeObserver.disconnect();
        };
    }, [value, suffix, suffixWidth, dynamicFontSize, dynamicFontScale]);

    const isHero = dynamicFontScale === "hero";

    return (
        <div
            ref={containerRef}
            className={cn(
                "relative",
                isHero && "flex w-full items-baseline justify-center gap-1.5",
                containerClassName,
            )}
        >
            {search && (
                <div className="absolute left-3 top-1/2 -translate-y-1/2">
                    <Icon
                        icon={Search01Icon}
                        className="text-muted-foreground"
                    />
                </div>
            )}
            <Input
                ref={inputRef}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                {...props}
                value={value}
                style={
                    suffix && !isHero
                        ? { ...style, paddingRight: suffixWidth }
                        : style
                }
                className={cn(
                    "h-12 shrink-0 p-0",
                    "transition-[font-size] duration-200 ease-in-out",
                    search && "pl-10",
                    borderless &&
                        "border-none bg-transparent shadow-none dark:bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0",
                    isHero &&
                        "w-auto min-w-[1ch] max-w-full field-sizing-content",
                    fontSize,
                    textSizeClassName,
                    className,
                )}
                {...(isHero
                    ? {
                          size: Math.max(1, (value?.toString() || "0").length),
                      }
                    : {})}
            />
            {suffix && (
                <div
                    className={cn(
                        isHero
                            ? "shrink-0"
                            : "absolute right-0 top-1/2 -translate-y-1/2",
                    )}
                >
                    <span
                        ref={suffixRef}
                        className={cn(
                            "text-muted-foreground transition-[font-size] duration-200 ease-in-out",
                            isHero ? suffixFontSize : fontSize,
                            suffixClassName,
                        )}
                    >
                        {suffix}
                    </span>
                </div>
            )}
        </div>
    );
}
