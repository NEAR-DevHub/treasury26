import { Amount } from "@/features/proposals/components/amount";
import { useToken } from "@/hooks/use-treasury-queries";
import { formatBalance, formatCurrency } from "@/lib/utils";
import Big from "@/lib/big";
import { useMemo } from "react";

interface RateProps {
    tokenIn: string;
    tokenOut: string;
    amountIn?: Big;
    amountInWithDecimals?: string;
    amountOut?: Big;
    amountOutWithDecimals?: string;
}

export function Rate({
    tokenIn,
    tokenOut,
    amountIn,
    amountInWithDecimals,
    amountOut,
    amountOutWithDecimals,
}: RateProps) {
    const { data: tokenInData } = useToken(tokenIn);
    const { data: tokenOutData } = useToken(tokenOut);
    const amount1 = amountIn
        ? formatBalance(amountIn.toString(), tokenInData?.decimals || 24)
        : amountInWithDecimals;
    const amount2 = amountOut
        ? formatBalance(amountOut.toString(), tokenOutData?.decimals || 24)
        : amountOutWithDecimals;

    const cost = useMemo(() => {
        if (!amount1 || !amount2 || amount1 === "0" || amount2 === "0") {
            return "N/A";
        }
        return Big(amount2).div(Big(amount1)).toFixed(6);
    }, [amount1, amount2]);

    return (
        <p className="text-sm text-foreground">
            1 {tokenInData?.symbol} ({formatCurrency(tokenInData?.price || 0)})
            ≈ {cost} {tokenOutData?.symbol}
        </p>
    );
}
