import { useToken } from "@/hooks/use-treasury-queries";
import { formatBalance } from "@/lib/utils";
import { Coins } from "lucide-react";
import { PaymentRequestData, VestingData, StakingData } from "../../types/index";
import { Amount } from "../amount";

interface TokenCellProps {
  data: PaymentRequestData | VestingData | StakingData;
}


export function TokenCell({ data }: TokenCellProps) {
  const network = (data as PaymentRequestData).network || "NEAR";
  return (
    <div className="flex flex-col items-start gap-1">
      <Amount amount={data.amount} tokenId={data.tokenId} network={network} showUSDValue={false} iconSize="sm" />
      {data.receiver && <span className="text-xs text-muted-foreground">To: {data.receiver}</span>}
    </div>
  );
}
