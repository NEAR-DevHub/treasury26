import { Amount } from "@/features/proposals/components/amount";
import { useToken } from "@/hooks/use-treasury-queries";
import { formatBalance } from "@/lib/utils";
import Big from "big.js";
import { useMemo } from "react";

interface RateProps {
    tokenIn: string;
    networkIn: string;
    tokenOut: string;
    networkOut: string;
    amountIn?: Big;
    amountInWithDecimals?: string;
    amountOut?: Big;
    amountOutWithDecimals?: string;
}

export function Rate({ tokenIn, networkIn, tokenOut, networkOut, amountIn, amountInWithDecimals, amountOut, amountOutWithDecimals }: RateProps) {
    const { data: tokenInData } = useToken(tokenIn, networkIn);
    const { data: tokenOutData } = useToken(tokenOut, networkOut);
    const amount1 = amountIn ? formatBalance(amountIn.toString(), tokenInData?.decimals || 24) : amountInWithDecimals;
    const amount2 = amountOut ? formatBalance(amountOut.toString(), tokenOutData?.decimals || 24) : amountOutWithDecimals;

    const cost = useMemo(() => {
        if (!amount1 || !amount2) {
            return "N/A";
        }
        return Big(amount2).div(Big(amount1)).toFixed(6);
    }, [amount1, amount2]);



    return (
        <p className="text-sm text-primary">
            1 {tokenInData?.symbol} (${tokenInData?.price?.toFixed(2)}) ≈ {cost} {tokenOutData?.symbol}
        </p>
    );
}
