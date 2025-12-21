import { ArrowRight, } from "lucide-react";
import { SwapRequestData } from "../../types/index";
import { Amount } from "../amount";

interface SwapCellProps {
  data: SwapRequestData;
}

export function SwapCell({ data }: SwapCellProps) {

  return (
    <div className="flex items-center gap-2">
      <Amount amount={data.amountIn} tokenId={data.tokenIn} network={data.sourceNetwork} showUSDValue={false} iconSize="sm" />
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
      <Amount amountWithDecimals={data.amountOut} tokenId={data.tokenOut} network={data.destinationNetwork} showUSDValue={false} iconSize="sm" />
    </div>
  );
}
