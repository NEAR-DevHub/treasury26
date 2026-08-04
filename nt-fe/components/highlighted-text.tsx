import { cn } from "@/lib/utils";
import { getHighlightParts } from "@/lib/highlight-match";

interface HighlightedTextProps {
    text: string;
    query?: string;
    className?: string;
    markClassName?: string;
}

/**
 * Renders text with case-insensitive search-query matches highlighted.
 * When there is no query (or no matches), renders plain text without mark nodes.
 */
export function HighlightedText({
    text,
    query,
    className,
    markClassName,
}: HighlightedTextProps) {
    if (!text) return null;

    const normalizedQuery = query?.trim();
    if (!normalizedQuery) {
        return <span className={className}>{text}</span>;
    }

    const parts = getHighlightParts(text, normalizedQuery);
    if (parts.length === 0) return null;
    if (parts.length === 1 && !parts[0].match) {
        return <span className={className}>{text}</span>;
    }

    return (
        <span className={className}>
            {parts.map((part, index) =>
                part.match ? (
                    <mark
                        key={index}
                        className={cn(
                            "bg-search-match-highlight text-inherit",
                            markClassName,
                        )}
                    >
                        {part.text}
                    </mark>
                ) : (
                    <span key={index}>{part.text}</span>
                ),
            )}
        </span>
    );
}
