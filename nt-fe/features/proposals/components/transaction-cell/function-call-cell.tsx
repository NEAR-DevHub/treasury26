import { FunctionCallData } from "../../types/index";
import { TitleSubtitleCell } from "./title-subtitle-cell";

interface FunctionCallCellProps {
  data: FunctionCallData;
  timestamp?: string;
  textOnly?: boolean;
}

export function FunctionCallCell({ data, timestamp }: FunctionCallCellProps) {
  const subtitle = `on ${data.receiver}${data.actionsCount > 1 ? ` (+${data.actionsCount - 1} more)` : ""}`;

  return (
    <TitleSubtitleCell
      title={data.methodName || "Function Call"}
      subtitle={subtitle}
      timestamp={timestamp}
    />
  );
}
