import { PaymentRequestData, VestingData, StakingData } from "../../types/index";
import { Amount } from "../amount";
import { TooltipUser } from "@/components/user";
import { TitleSubtitleCell } from "./title-subtitle-cell";

interface TokenCellProps {
  data: PaymentRequestData | VestingData | StakingData;
  prefix?: string;
  isUser?: boolean;
  timestamp?: string;
  textOnly?: boolean;
}


export function TokenCell({ data, prefix = "To:", isUser = true, timestamp, textOnly = false }: TokenCellProps) {
  const title = <Amount amount={data.amount} tokenId={data.tokenId} showUSDValue={false} iconSize="sm" textOnly={textOnly} />;

  const subtitle = data.receiver ? (
    <>
      {prefix}
      {isUser ? <TooltipUser accountId={data.receiver}><span> {data.receiver}</span></TooltipUser> : ` ${data.receiver}`}
    </>
  ) : undefined;

  return (
    <TitleSubtitleCell
      title={title}
      subtitle={subtitle}
      timestamp={timestamp}
    />
  );
}
