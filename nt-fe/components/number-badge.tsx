"use client";

import { cva } from "class-variance-authority";
import { useTranslations } from "next-intl";

const styles = cva("flex items-center justify-center text-xs font-semibold", {
    variants: {
        variant: {
            default: "bg-orange-500 text-white",
            secondary: "bg-muted text-muted-foreground",
            accent: "bg-general-unofficial-border text-foreground",
            outline:
                "border border-general-border bg-card font-medium text-general-secondary-foreground",
            error: "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400",
        },
        sizes: {
            default: "min-w-5 h-5 px-2 py-[3px]",
            sm: "min-w-4 h-4 px-1 py-px",
        },
        shape: {
            default: "rounded-[8px]",
            pill: "rounded-full",
        },
    },
    defaultVariants: {
        variant: "default",
        sizes: "default",
        shape: "default",
    },
});

export function NumberBadge({
    number,
    variant = "default",
    sizes = "default",
    shape = "default",
    ariaLabel,
}: {
    number: number;
    variant?: "default" | "secondary" | "accent" | "error" | "outline";
    sizes?: "default" | "sm";
    shape?: "default" | "pill";
    ariaLabel?: string;
}) {
    const t = useTranslations("numberBadge");
    return (
        <span
            aria-label={ariaLabel ?? t("pendingRequests", { count: number })}
            className={styles({ variant, sizes, shape })}
        >
            {number}
        </span>
    );
}
