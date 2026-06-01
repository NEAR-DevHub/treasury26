import { createContext, useContext } from "react";
import { useFormatDate } from "@/components/formatted-date";

export const SubtitleSuffixContext = createContext<React.ReactNode>(null);

interface TitleSubtitleCellProps {
    title: string | React.ReactNode;
    subtitle?: string | React.ReactNode;
    timestamp?: string;
}

export function TitleSubtitleCell({
    title,
    subtitle,
    timestamp,
}: TitleSubtitleCellProps) {
    const formatDate = useFormatDate();
    const subtitleSuffix = useContext(SubtitleSuffixContext);
    const formattedDate = timestamp
        ? formatDate(new Date(parseInt(timestamp) / 1000000))
        : null;
    const trailingSubtitle = subtitleSuffix ?? formattedDate;

    return (
        <div className="flex w-full min-w-0 max-w-full flex-col gap-1 items-start">
            <div className="max-w-full truncate font-medium">{title}</div>
            {(subtitle || trailingSubtitle) && (
                <div className="flex w-full min-w-0 items-center gap-1 text-xs text-muted-foreground">
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
    );
}
