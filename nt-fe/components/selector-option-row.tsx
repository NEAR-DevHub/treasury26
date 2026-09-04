"use client";

import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/button";
import { HighlightedText } from "@/components/highlighted-text";
import { cn } from "@/lib/utils";

const primaryClassName =
    "text-base font-semibold leading-[1.2] text-foreground";
const secondaryClassName =
    "text-sm font-medium leading-[1.5] text-general-secondary-foreground";

function OptionLine({
    value,
    query,
    className,
}: {
    value: ReactNode;
    query?: string;
    className?: string;
}) {
    if (value == null || value === false) return null;
    if (typeof value === "string") {
        return (
            <HighlightedText text={value} query={query} className={className} />
        );
    }
    return <span className={className}>{value}</span>;
}

/** Symbol / name column used by picker rows and trigger previews. */
export function SelectorOptionLabels({
    primary,
    secondary,
    highlightQuery,
    primaryClassName: primaryClassNameOverride,
}: {
    primary: ReactNode;
    secondary?: ReactNode | null;
    highlightQuery?: string;
    primaryClassName?: string;
}) {
    return (
        <div className="min-w-0 flex-1 text-left">
            <div className={cn(primaryClassName, primaryClassNameOverride)}>
                <OptionLine value={primary} query={highlightQuery} />
            </div>
            {secondary ? (
                <div className={secondaryClassName}>
                    <OptionLine value={secondary} query={highlightQuery} />
                </div>
            ) : null}
        </div>
    );
}

/** Trailing token amount + USD (or USD + token) in picker rows. */
export function SelectorOptionBalance({
    primary,
    secondary,
}: {
    primary: ReactNode;
    secondary?: ReactNode | null;
}) {
    if (primary == null && (secondary == null || secondary === false)) {
        return null;
    }
    return (
        <div className="flex shrink-0 flex-col items-end">
            <span className={primaryClassName}>{primary}</span>
            {secondary != null && secondary !== false ? (
                <span className={secondaryClassName}>{secondary}</span>
            ) : null}
        </div>
    );
}

/** Token / network option row in picker lists. */
export function SelectorOptionRow({
    selected = false,
    icon,
    primary,
    secondary,
    highlightQuery,
    primaryClassName,
    trailing,
    children,
    className,
    disabled,
    type = "button",
    ...props
}: {
    selected?: boolean;
    icon?: ReactNode;
    primary?: ReactNode;
    secondary?: ReactNode | null;
    highlightQuery?: string;
    primaryClassName?: string;
    trailing?: ReactNode;
    children?: ReactNode;
} & Omit<ComponentProps<typeof Button>, "variant" | "children">) {
    return (
        <Button
            type={type}
            variant="ghost"
            disabled={disabled}
            className={cn(
                // Ghost buttons inherit the mint `--ring` focus ring. Opening
                // the picker focuses the first row, which drew that outline
                // around the first token. Keep a muted fill so
                // keyboard focus is still visible.
                "mx-1 my-1 h-14 w-full items-center justify-start gap-3 rounded-lg px-3! outline-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:bg-muted",
                selected && "bg-muted hover:bg-muted",
                className,
            )}
            {...props}
        >
            {icon}
            {children !== undefined ? (
                children
            ) : (
                <SelectorOptionLabels
                    primary={primary}
                    secondary={secondary}
                    highlightQuery={highlightQuery}
                    primaryClassName={primaryClassName}
                />
            )}
            {trailing}
        </Button>
    );
}
