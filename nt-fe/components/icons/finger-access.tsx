import { cn } from "@/lib/utils";

/**
 * "Finger access" glyph from the design system: a fingerprint spiral with an
 * outer ridge and a short inner tail. Drawn locally because the icon sets we
 * ship only carry multi-ridge fingerprint glyphs.
 */
export function FingerAccessIcon({
    className,
    ...props
}: React.ComponentProps<"svg">) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            className={cn(className)}
            {...props}
        >
            <path d="M18 12C18 8.69 15.31 6 12 6C8.69 6 6 8.69 6 12C6 15.31 7 17.5 9 20" />
            <path d="M15 21C9.5 17.5 9 13.66 9 12C9 10.34 10.34 9 12 9C13.66 9 15 10.34 15 12C15 13.66 16.34 15 18 15C19.66 15 21 13.66 21 12C21 7.03 16.97 3 12 3C7.03 3 3 7.03 3 12C3 12.69 3.08 13.36 3.22 14" />
            <path d="M12 12C12.5 17 17.5 19 17.5 19" />
        </svg>
    );
}
