import { InfoDisplay, InfoItem } from "@/components/info-display";
import { User } from "@/components/user";
import { formatGas, formatNearAmount } from "@/lib/utils";
import { FunctionCallData } from "../../types/index";

interface FunctionCallExpandedProps {
  data: FunctionCallData;
}

export function FunctionCallExpanded({ data }: FunctionCallExpandedProps) {
  let items: InfoItem[] = [
    {
      label: "Recipient",
      value: <User accountId={data.receiver} />
    },
    {
      label: "Method",
      value: <span>{data.methodName}</span>
    },
    {
      label: "Gas",
      value: <span>{formatGas(data.gas)} TGas</span>
    }
  ];

  if (data.deposit && data.deposit !== "0") {
    items.push({
      label: "Deposit",
      value: <span>{formatNearAmount(data.deposit)}</span>
    });
  }

  items.push({
    label: "Arguments",
    differentLine: true,
    value: <pre className="overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">
      <code className="text-foreground/90">
        {JSON.stringify(data.args, null, 2)}
      </code>
    </pre>
  });

  return (
    <InfoDisplay items={items} />
  );
}
