"use client";

import { Info } from "lucide-react";
import { Tooltip } from "@/components/tooltip";

interface ExchangeDetailRowProps {
  label: string;
  value: string | React.ReactNode;
  tooltip?: string;
  className?: string;
}

/**
 * Row component to display exchange detail with optional tooltip
 */
export function ExchangeDetailRow({
  label,
  value,
  tooltip,
  className = "",
}: ExchangeDetailRowProps) {
  return (
    <div className={`flex justify-between items-center ${className}`}>
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground">{label}</span>
        {tooltip && (
          <Tooltip content={tooltip}>
            <Info className="size-3 text-muted-foreground" />
          </Tooltip>
        )}
      </div>
      {typeof value === "string" ? (
        <span className="font-medium">{value}</span>
      ) : (
        value
      )}
    </div>
  );
}

