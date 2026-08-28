import type { ReactNode } from "react";
import { BALANCE_MASK, useIsBalanceMasked } from "@/components/balance-mask";
import { SwapTokenPair } from "@/components/token-pair";
import { WRAP_NEAR_TOKEN_ID } from "@/constants/network-ids";
import { useSearchIntentsTokens, useToken } from "@/hooks/use-treasury-queries";
import { formatBalance, formatTokenDisplayAmount } from "@/lib/utils";
import type { SwapRequestData } from "../../types/index";
import { TitleSubtitleCell } from "./title-subtitle-cell";

interface SwapCellProps {
    data: SwapRequestData;
    timestamp?: string;
    textOnly?: boolean;
}

/** One leg of a swap: its token metadata plus a formatted "1,234.00 USDC". */
function useSwapLeg({
    tokenId,
    amount,
    amountWithDecimals,
}: {
    tokenId: string;
    amount?: string;
    amountWithDecimals?: string;
}) {
    const isMasked = useIsBalanceMasked();
    const { data: token } = useToken(tokenId);
    const rawAmount = amount
        ? formatBalance(amount, token?.decimals || 24)
        : (amountWithDecimals ?? "0");
    const displayAmount = isMasked
        ? BALANCE_MASK
        : formatTokenDisplayAmount(rawAmount);

    return { token, label: `${displayAmount} ${token?.symbol ?? ""}`.trim() };
}

/**
 * Sent amount on a muted first line, received amount emphasised below — the
 * swap reads as one movement rather than two independent amounts.
 */
function SwapAmounts({
    sent,
    received,
    textOnly,
}: {
    sent: ReturnType<typeof useSwapLeg>;
    received: ReturnType<typeof useSwapLeg>;
    textOnly: boolean;
}) {
    return (
        <div className="flex min-w-0 items-center gap-2">
            {!textOnly && (
                <SwapTokenPair sent={sent.token} received={received.token} />
            )}
            <div className="flex min-w-0 flex-col">
                <span className="truncate text-xs font-medium text-general-secondary-foreground">
                    {sent.label}
                </span>
                <span className="truncate text-sm font-semibold">
                    {received.label}
                </span>
            </div>
        </div>
    );
}

function IntentsSwapCell({ data, textOnly = false }: SwapCellProps) {
    // For new proposals with addresses, we don't need the search hook
    const hasAddresses = !!(data.tokenInAddress && data.tokenOutAddress);

    // Only use search hook for legacy proposals without addresses
    const { data: tokensData } = useSearchIntentsTokens(
        {
            tokenIn: data.tokenIn,
            tokenOut: data.tokenOut,
            intentsTokenContractId: data.intentsTokenContractId,
            destinationNetwork: data.destinationNetwork,
        },
        !hasAddresses,
    );

    // Use addresses if available, otherwise fall back to search results
    const tokenInId =
        data.tokenInAddress ||
        tokensData?.tokenIn?.defuseAssetId ||
        data.tokenIn;
    const tokenOutId =
        data.tokenOutAddress ||
        tokensData?.tokenOut?.defuseAssetId ||
        data.tokenOut;

    const sent = useSwapLeg({ tokenId: tokenInId, amount: data.amountIn });
    const received = useSwapLeg({
        tokenId: tokenOutId,
        amountWithDecimals: data.amountOut,
    });

    return <SwapAmounts sent={sent} received={received} textOnly={textOnly} />;
}

function NearWrapSwapCell({ data, textOnly = false }: SwapCellProps) {
    const sent = useSwapLeg({
        tokenId: data.tokenIn,
        amountWithDecimals: data.amountIn,
    });
    const received = useSwapLeg({
        tokenId: data.tokenOut,
        amountWithDecimals: data.amountOut,
    });

    return <SwapAmounts sent={sent} received={received} textOnly={textOnly} />;
}

export function SwapCell(props: SwapCellProps) {
    let title: ReactNode = null;
    switch (props.data.source) {
        case "exchange":
            title = <IntentsSwapCell {...props} />;
            break;
        case WRAP_NEAR_TOKEN_ID:
            title = <NearWrapSwapCell {...props} />;
            break;
        default:
    }

    return <TitleSubtitleCell title={title} timestamp={props.timestamp} />;
}
