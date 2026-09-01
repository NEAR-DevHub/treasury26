"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useAmountFormat } from "@/hooks/use-amount-format";
import {
    type AmountProfile,
    type AmountValue,
    decimalOrNull,
} from "@/lib/amount-format";
import { fitFontSize } from "@/lib/fit-font-size";
import { cn } from "@/lib/utils";
import { Tooltip } from "./tooltip";

interface FittingTextProps {
    text: string;
    className?: string;
    containerClassName?: string;
    minPx?: number;
    maxPx?: number;
}

/** Shrinks to `minPx` (default 14). If it still overflows, ellipsizes and shows a tooltip. */
export function FittingText({
    text,
    className,
    containerClassName,
    minPx = 14,
    maxPx = 24,
}: FittingTextProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const sizerRef = useRef<HTMLSpanElement>(null);
    const [fontSize, setFontSize] = useState(maxPx);
    const [truncated, setTruncated] = useState(false);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const sizer = sizerRef.current;
        if (!container || !sizer) return;

        const measure = () => {
            const next = fitFontSize({
                contentWidth: text ? sizer.scrollWidth : 0,
                availableWidth: container.clientWidth,
                maxSize: maxPx,
                minSize: minPx,
            });
            setFontSize(next.fontSize);
            setTruncated(next.truncated);
        };

        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        return () => observer.disconnect();
    }, [text, minPx, maxPx]);

    const visible = (
        <span
            className={cn(
                "block max-w-full leading-tight",
                truncated && "truncate",
                className,
            )}
            style={{ fontSize: `${fontSize}px` }}
        >
            {text}
        </span>
    );

    return (
        <div
            ref={containerRef}
            className={cn(
                "relative w-full min-w-0 overflow-hidden",
                containerClassName,
            )}
        >
            <span
                ref={sizerRef}
                aria-hidden
                className={cn(
                    "pointer-events-none invisible absolute top-0 left-0 whitespace-nowrap leading-tight",
                    className,
                )}
                style={{ fontSize: `${maxPx}px` }}
            >
                {text}
            </span>
            {truncated ? (
                <Tooltip
                    content={text}
                    contentProps={{ className: "max-w-72 break-all" }}
                >
                    <button
                        type="button"
                        className="block w-full min-w-0 cursor-default"
                    >
                        {visible}
                    </button>
                </Tooltip>
            ) : (
                visible
            )}
        </div>
    );
}

interface FittingFormattedAmountProps {
    value: AmountValue | null | undefined;
    symbol?: string;
    tokenDecimals?: number;
    unitPriceUsd?: AmountValue | null;
    profile?: AmountProfile;
    className?: string;
    containerClassName?: string;
    minPx?: number;
    maxPx?: number;
}

export function FittingFormattedAmount({
    value,
    symbol,
    tokenDecimals,
    unitPriceUsd,
    profile = "standard",
    className,
    containerClassName,
    minPx = 14,
    maxPx = 24,
}: FittingFormattedAmountProps) {
    const amountFormat = useAmountFormat();
    const parsed = decimalOrNull(value);
    const parsedUnitPrice = decimalOrNull(unitPriceUsd);
    const formatted = amountFormat.token(parsed, {
        profile,
        tokenDecimals,
        unitPriceUsd: parsedUnitPrice,
    });
    const text = `${formatted.display}${symbol ? ` ${symbol}` : ""}`;

    return (
        <FittingText
            text={text}
            className={className}
            containerClassName={containerClassName}
            minPx={minPx}
            maxPx={maxPx}
        />
    );
}
