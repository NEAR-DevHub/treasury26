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

export function IntentsSwapCell({ data, textOnly = false }: SwapCellProps) {
  // For new proposals with addresses, we don't need the search hook
  const hasAddresses = !!(data.tokenInAddress && data.tokenOutAddress);

  // Only use search hook for legacy proposals without addresses
  const { data: tokensData } = useSearchIntentsTokens({
    tokenIn: data.tokenIn,
    tokenOut: data.tokenOut,
    intentsTokenContractId: data.intentsTokenContractId,
    destinationNetwork: data.destinationNetwork,
  }, !hasAddresses);

  // Use addresses if available, otherwise fall back to search results
  const tokenInId = data.tokenInAddress || tokensData?.tokenIn?.defuseAssetId || data.tokenIn;
  const tokenOutId = data.tokenOutAddress || tokensData?.tokenOut?.defuseAssetId || data.tokenOut;

  return (
    <div className="flex items-center gap-2">
      <Amount amount={data.amountIn} tokenId={tokenInId} showUSDValue={false} iconSize="sm" textOnly={textOnly} />
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
      <Amount amountWithDecimals={data.amountOut} tokenId={tokenOutId} showUSDValue={false} iconSize="sm" textOnly={textOnly} />
    </div>
  );
}

export function NearWrapSwapCell({ data, textOnly = false }: SwapCellProps) {
  return (
    <div className="flex items-center gap-2">
      <Amount amount={data.amountIn} tokenId={data.tokenIn} showUSDValue={false} iconSize="sm" textOnly={textOnly} />
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
      <Amount amount={data.amountOut} tokenId={data.tokenOut} showUSDValue={false} iconSize="sm" textOnly={textOnly} />
    </div>
  );
}

export function SwapCell(props: SwapCellProps) {
  let title;
  switch (props.data.source) {
    case "exchange":
      title = (<IntentsSwapCell {...props} />);
      break;
    case "wrap.near":
      title = (<NearWrapSwapCell {...props} />);
      break;
    default:
  }

  return (
    <TitleSubtitleCell
      title={title}
      timestamp={props.timestamp}
    />
  );
}
