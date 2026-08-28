import { createContext, useContext } from "react";
import { useFormatDate } from "@/components/formatted-date";

export const SubtitleSuffixContext = createContext<React.ReactNode>(null);

interface TitleSubtitleCellProps {
    title: string | React.ReactNode;
    subtitle?: string | React.ReactNode;
    /**
     * Leading glyph — usually the token icon. It sits beside both text lines
     * rather than inline with the title, so a two-line cell stays 42px tall.
     */
    icon?: React.ReactNode;
    timestamp?: string;
}

export function TitleSubtitleCell({
    title,
    subtitle,
    icon,
    timestamp,
}: TitleSubtitleCellProps) {
    const formatDate = useFormatDate();
    const subtitleSuffix = useContext(SubtitleSuffixContext);
    const formattedDate = timestamp
        ? formatDate(new Date(parseInt(timestamp) / 1000000))
        : null;
    const trailingSubtitle = subtitleSuffix ?? formattedDate;

    return (
        <div className="flex w-full min-w-0 max-w-full items-center gap-2">
            {icon}
            <div className="flex min-w-0 flex-1 flex-col items-start">
                <div className="max-w-full truncate font-semibold">{title}</div>
                {(subtitle || trailingSubtitle) && (
                    <div className="flex w-full min-w-0 items-center gap-1 text-sm font-medium text-general-secondary-foreground">
                        {subtitle && (
                            <div className="min-w-0 truncate">{subtitle}</div>
                        )}
                        {subtitle && trailingSubtitle && (
                            <span className="shrink-0">•</span>
                        )}
                        {trailingSubtitle && (
                            <span className="shrink-0">{trailingSubtitle}</span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
