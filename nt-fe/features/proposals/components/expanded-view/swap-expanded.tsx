import { Amount } from "../amount";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { SwapRequestData } from "../../types/index";
import { formatBalance } from "@/lib/utils";
import { useMemo } from "react";
import Big from "big.js";
import { Address } from "@/components/address";
import { Rate } from "@/components/rate";
import { useSearchIntentsTokens } from "@/hooks/use-treasury-queries";
import { FormattedDate } from "@/components/formatted-date";

interface SwapExpandedProps {
  data: SwapRequestData;
}

function IntentsSwapExpanded({ data }: SwapExpandedProps) {
  const { data: tokensData } = useSearchIntentsTokens({
    tokenIn: data.tokenIn,
    tokenOut: data.tokenOut,
    intentsTokenContractId: data.intentsTokenContractId,
    destinationNetwork: data.destinationNetwork,
  });
  const minimumReceived = useMemo(() => {
    return Big(data.amountOut).mul(Big(100 - Number(data.slippage || 0))).div(100);
  }, [data.amountOut, data.slippage]);

  const infoItems: InfoItem[] = [
    {
      label: "Send",
      value: <Amount amount={data.amountIn} showNetwork tokenId={tokensData?.tokenIn?.defuseAssetId || data.tokenIn} />
    },
    {
      label: "Receive",
      value: <Amount amountWithDecimals={data.amountOut} showNetwork tokenId={tokensData?.tokenOut?.defuseAssetId || data.tokenOut} />
    },
    {
      label: "Rate",
      value: <Rate tokenIn={tokensData?.tokenIn?.unifiedAssetId || data.tokenIn} tokenOut={tokensData?.tokenOut?.defuseAssetId || data.tokenOut} amountIn={Big(data.amountIn)} amountOutWithDecimals={data.amountOut} />,
    }
  ];

  let expandableItems: InfoItem[] = [];

  if (data.slippage) {
    expandableItems.push({
      label: "Price Slippage Limit",
      value: <span>{data.slippage}%</span>,
      info: "This is the slippage limit defined for this request. If the market rate changes beyond this threshold during execution, the request will automatically fail."
    });
  }

  if (data.timeEstimate) {
    expandableItems.push({
      label: "Estimated Time",
      value: <span>{data.timeEstimate}</span>,
      info: "Estimated time for the swap to be executed after the deposit transaction is confirmed."
    });
  }

  expandableItems.push({
    label: "Minimum Received",
    value: <Amount amountWithDecimals={minimumReceived.toString()} showNetwork tokenId={tokensData?.tokenOut?.defuseAssetId || data.tokenOut} />,
    info: "This is the minimum amount you'll receive from this exchange, based on the slippage limit set for the request."
  });

  if (data.depositAddress) {
    expandableItems.push({
      label: "Deposit Address",
      value: <Address address={data.depositAddress} copyable={true} />,
      info: "The 1Click deposit address where tokens will be sent for the cross-chain swap execution."
    });
  }

  if (data.quoteSignature) {
    expandableItems.push({
      label: "Quote Signature",
      value: <Address address={data.quoteSignature} copyable={true} prefixLength={16} />,
      info: "The cryptographic signature from 1Click API that validates this quote."
    });
  }

  if (data.quoteDeadline) {
    expandableItems.push({
      label: "1-Click Quote Deadline",
      value: <FormattedDate date={data.quoteDeadline} />,
      info: "Time when the deposit address becomes inactive and funds may be lost."
    });
  }

  return (
    <InfoDisplay items={infoItems} expandableItems={expandableItems} />
  );
}

function NearWrapSwapExpanded({ data }: SwapExpandedProps) {

  const infoItems: InfoItem[] = [
    {
      label: "Send",
      value: <Amount amount={data.amountIn} showNetwork tokenId={data.tokenIn} />
    },
    {
      label: "Receive",
      value: <Amount amount={data.amountOut} showNetwork tokenId={data.tokenOut} />
    },
    {
      label: "Rate",
      value: <Rate tokenIn={data.tokenIn} tokenOut={data.tokenOut} amountIn={Big(data.amountIn)} amountOut={Big(data.amountOut)} />,
    }
  ];

  let expandableItems: InfoItem[] = [];

  if (data.slippage) {
    expandableItems.push({
      label: "Price Slippage Limit",
      value: <span>{data.slippage}%</span>,
      info: "This is the slippage limit defined for this request. If the market rate changes beyond this threshold during execution, the request will automatically fail."
    });
  }

  if (data.timeEstimate) {
    expandableItems.push({
      label: "Estimated Time",
      value: <span>{data.timeEstimate}</span>,
      info: "Estimated time for the swap to be executed after the deposit transaction is confirmed."
    });
  }

  expandableItems.push({
    label: "Minimum Received",
    value: <Amount amount={data.amountOut} showNetwork tokenId={data.tokenOut} />,
    info: "This is the minimum amount you'll receive from this exchange, based on the slippage limit set for the request."
  });

  if (data.depositAddress) {
    expandableItems.push({
      label: "Deposit Address",
      value: <Address address={data.depositAddress} copyable={true} />,
      info: "The 1Click deposit address where tokens will be sent for the cross-chain swap execution."
    });
  }

  if (data.quoteSignature) {
    expandableItems.push({
      label: "Quote Signature",
      value: <Address address={data.quoteSignature} copyable={true} prefixLength={16} />,
      info: "The cryptographic signature from 1Click API that validates this quote."
    });
  }

  if (data.quoteDeadline) {
    expandableItems.push({
      label: "1-Click Quote Deadline",
      value: <FormattedDate date={data.quoteDeadline} />,
      info: "Time when the deposit address becomes inactive and funds may be lost."
    });
  }
  return (
    <InfoDisplay items={infoItems} expandableItems={expandableItems} />
  );
}

export function SwapExpanded({ data }: SwapExpandedProps) {
  switch (data.source) {
    case "exchange":
      return <IntentsSwapExpanded data={data} />;
    case "wrap.near":
      return <NearWrapSwapExpanded data={data} />;
    default:
      return null;
  }
}
