import { FunctionCallData } from "../../types/index";

interface FunctionCallCellProps {
  data: FunctionCallData;
}

export function FunctionCallCell({ data }: FunctionCallCellProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium">{data.methodName || "Function Call"}</span>
      <span className="text-xs text-muted-foreground">
        on {data.receiver}
        {data.actionsCount > 1 && ` (+${data.actionsCount - 1} more)`}
      </span>
    </div>
  );
}
