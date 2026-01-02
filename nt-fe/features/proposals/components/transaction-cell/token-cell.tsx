import { PaymentRequestData, VestingData, StakingData } from "../../types/index";
import { Amount } from "../amount";
import { TooltipUser } from "@/components/user";

interface TokenCellProps {
  data: PaymentRequestData | VestingData | StakingData;
  prefix?: string;
  isUser?: boolean;
}


export function TokenCell({ data, prefix = "To:", isUser = true }: TokenCellProps) {
  return (
    <div className="flex flex-col items-start gap-1">
      <Amount amount={data.amount} tokenId={data.tokenId} showUSDValue={false} iconSize="sm" />
      {data.receiver && <span className="text-xs text-muted-foreground">{prefix}
        {isUser ? <TooltipUser accountId={data.receiver}><span> {data.receiver}</span></TooltipUser > : data.receiver}

      </span>}
    </div>
  );
}
