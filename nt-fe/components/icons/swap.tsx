import { cn } from "@/lib/utils";

/**
 * Swap glyph from the design system: a rounded square holding two opposing
 * arrows. Drawn locally because lucide has no boxed left/right arrow pair.
 */
export function SwapIcon({ className, ...props }: React.ComponentProps<"svg">) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            className={cn(className)}
            {...props}
        >
            <rect x="3" y="3" width="18" height="18" rx="5.5" />
            <path d="M16.5 10h-8" />
            <path d="m10.5 8-2 2 2 2" />
            <path d="M7.5 14h8" />
            <path d="m13.5 12 2 2-2 2" />
        </svg>
    );
}
