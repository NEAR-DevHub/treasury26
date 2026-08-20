import { HugeiconsIcon, type HugeiconsIconProps } from "@hugeicons/react";
import { cn } from "@/lib/utils";

/**
 * App-wide icon. Renders a Hugeicons glyph at the standard 15x15 size with a
 * thicker stroke than the 1.5 the icon sets ship at. Pass a Tailwind size utility via
 * `className` to opt out — `cn` lets it win over the default.
 */
export function Icon({
    className,
    strokeWidth = 2,
    ...props
}: HugeiconsIconProps) {
    return (
        <HugeiconsIcon
            {...props}
            strokeWidth={strokeWidth}
            className={cn("size-[15px]", className)}
        />
    );
}
