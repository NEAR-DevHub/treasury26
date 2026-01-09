import { formatDate } from "@/lib/utils";
import Big from "big.js";

interface TitleSubtitleCellProps {
  title: string | React.ReactNode;
  subtitle?: string | React.ReactNode;
  timestamp?: string;
}

export function TitleSubtitleCell({ title, subtitle, timestamp }: TitleSubtitleCellProps) {
  const formattedDate = timestamp ? formatDate(Big(timestamp)) : null;

  return (
    <div className="flex flex-col gap-1 items-start">
      <span className="font-medium">{title}</span>
      {(subtitle || formattedDate) && (
        <span className="text-xs text-muted-foreground">
          {subtitle}
          {subtitle && formattedDate && <span className="ml-2">• {formattedDate}</span>}
          {!subtitle && formattedDate}
        </span>
      )}
    </div>
  );
}
