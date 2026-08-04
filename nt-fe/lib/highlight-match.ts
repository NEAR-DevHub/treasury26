export type HighlightPart = {
    text: string;
    match: boolean;
};

/**
 * Split `text` into parts where substrings matching `query` (case-insensitive)
 * are marked for highlighting. Preserves original casing in the output.
 */
export function getHighlightParts(
    text: string,
    query?: string,
): HighlightPart[] {
    if (!text) return [];
    const normalizedQuery = query?.trim();
    if (!normalizedQuery) {
        return [{ text, match: false }];
    }

    const lowerText = text.toLowerCase();
    const lowerQuery = normalizedQuery.toLowerCase();
    const parts: HighlightPart[] = [];
    let start = 0;
    let index = lowerText.indexOf(lowerQuery, start);

    while (index !== -1) {
        if (index > start) {
            parts.push({ text: text.slice(start, index), match: false });
        }
        parts.push({
            text: text.slice(index, index + lowerQuery.length),
            match: true,
        });
        start = index + lowerQuery.length;
        index = lowerText.indexOf(lowerQuery, start);
    }

    if (start < text.length) {
        parts.push({ text: text.slice(start), match: false });
    }

    return parts.length > 0 ? parts : [{ text, match: false }];
}
