import { useFormatDate } from "@/components/formatted-date";

interface TitleSubtitleCellProps {
    title: string | React.ReactNode;
    subtitle?: string | React.ReactNode;
    subtitleSuffix?: React.ReactNode;
    timestamp?: string;
}

export function TitleSubtitleCell({
    title,
    subtitle,
    subtitleSuffix,
    timestamp,
}: TitleSubtitleCellProps) {
    const formatDate = useFormatDate();
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
                        <span className="flex min-w-0 items-center overflow-hidden whitespace-nowrap">
                            {typeof subtitle === "string" ? (
                                <span className="truncate">{subtitle}</span>
                            ) : (
                                subtitle
                            )}
                        </span>
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
