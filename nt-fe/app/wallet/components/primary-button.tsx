import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * The popup's primary action button, pinned to the bottom of the step via
 * `mt-auto` (every step is a flex column filling the window).
 */
export function PrimaryButton({
    className,
    ...props
}: ComponentProps<"button">) {
    return (
        <button
            type="button"
            className={cn(
                "mt-auto w-full py-[9.5px] px-6 leading-[25px] bg-primary text-primary-foreground rounded-lg font-medium cursor-pointer hover:bg-primary/90 active:bg-primary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                className,
            )}
            {...props}
        />
    );
}
