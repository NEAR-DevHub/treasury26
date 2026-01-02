import { ArrowRight } from "lucide-react";
import { SwapRequestData } from "../../types/index";
import { Amount } from "../amount";
import { useSearchIntentsTokens } from "@/hooks/use-treasury-queries";

interface SwapCellProps {
  data: SwapRequestData;
}

export function SwapCell({ data }: SwapCellProps) {
  // Search for token metadata with network information
  const { data: tokensData } = useSearchIntentsTokens({
    tokenIn: data.tokenIn,
    tokenOut: data.tokenOut,
    intentsTokenContractId: data.intentsTokenContractId,
    destinationNetwork: data.destinationNetwork,
  });

  return (
    <div className="flex items-center gap-2">
      <Amount amount={data.amountIn} tokenId={tokensData?.tokenIn?.defuseAssetId || data.tokenIn} showUSDValue={false} iconSize="sm" />
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
      <Amount amountWithDecimals={data.amountOut} tokenId={tokensData?.tokenOut?.defuseAssetId || data.tokenOut} showUSDValue={false} iconSize="sm" />
    </div>
  );
}
