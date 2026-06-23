const MARKDOWN_HEADING_PATTERN = /^#{1,6}\s+/;

type ParsedWarningMessage = {
    primary: string;
    secondary: string;
    hasHeading: boolean;
};

/** Split stored user_message into primary (### line or plain) and secondary body. */
function parseWarningMessage(message: string | null): ParsedWarningMessage {
    const trimmed = message?.trim();
    if (!trimmed) {
        return { primary: "", secondary: "", hasHeading: false };
    }

    const lines = trimmed.split("\n");
    const headingIdx = lines.findIndex((line) =>
        MARKDOWN_HEADING_PATTERN.test(line.trim()),
    );

    if (headingIdx < 0) {
        return { primary: trimmed, secondary: "", hasHeading: false };
    }

    return {
        primary: lines[headingIdx].replace(MARKDOWN_HEADING_PATTERN, "").trim(),
        secondary: lines
            .slice(headingIdx + 1)
            .join("\n")
            .trim(),
        hasHeading: true,
    };
}

export type InlineWarningCopy = {
    inlineText: string | null;
    tooltipText: string | null;
};

/** Form-field copy: inline text + optional tooltip (only when a secondary body exists). */
export function extractInlineWarningCopy(
    message: string | null,
): InlineWarningCopy {
    const { primary, secondary } = parseWarningMessage(message);
    if (!primary && !secondary) {
        return { inlineText: null, tooltipText: null };
    }

    return {
        inlineText: primary || secondary,
        tooltipText: secondary || null,
    };
}

/** Banner copy: bold heading + visible paragraph (SlotWarning). */
export function extractBannerWarningCopy(message: string | null): {
    heading: string | null;
    body: string;
} {
    const { primary, secondary, hasHeading } = parseWarningMessage(message);
    if (!primary && !secondary) {
        return { heading: null, body: "" };
    }

    if (hasHeading) {
        return { heading: primary || null, body: secondary };
    }

    return { heading: null, body: primary };
}
