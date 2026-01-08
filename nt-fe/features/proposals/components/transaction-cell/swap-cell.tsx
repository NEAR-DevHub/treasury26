import { ArrowRight } from "lucide-react";
import { SwapRequestData } from "../../types/index";
import { Amount } from "../amount";
import { useSearchIntentsTokens } from "@/hooks/use-treasury-queries";
import { TitleSubtitleCell } from "./title-subtitle-cell";

interface SwapCellProps {
  data: SwapRequestData;
  timestamp?: string;
  textOnly?: boolean;
}

export function SwapCell({ data, timestamp, textOnly = false }: SwapCellProps) {
  // Search for token metadata with network information
  const { data: tokensData } = useSearchIntentsTokens({
    tokenIn: data.tokenIn,
    tokenOut: data.tokenOut,
    intentsTokenContractId: data.intentsTokenContractId,
    destinationNetwork: data.destinationNetwork,
  });

  const title = (
    <div className="flex items-center gap-2">
      <Amount amount={data.amountIn} tokenId={tokensData?.tokenIn?.defuseAssetId || data.tokenIn} showUSDValue={false} iconSize="sm" textOnly={textOnly} />
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
      <Amount amountWithDecimals={data.amountOut} tokenId={tokensData?.tokenOut?.defuseAssetId || data.tokenOut} showUSDValue={false} iconSize="sm" textOnly={textOnly} />
    </div>
  );

  return (
    <TitleSubtitleCell
      title={title}
      timestamp={timestamp}
    />
  );
}
