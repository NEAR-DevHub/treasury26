"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { useToken } from "@/hooks/use-treasury-queries";
import Big from "@/lib/big";
import {
    formatBalance,
    formatCurrency,
    formatCurrencyWithSubCent,
} from "@/lib/utils";

interface RateProps {
    tokenIn: string;
    tokenOut: string;
    amountIn?: Big;
    amountInWithDecimals?: string;
    amountInUsd?: number | null;
    amountOut?: Big;
    amountOutWithDecimals?: string;
}

export function Rate({
    tokenIn,
    tokenOut,
    amountIn,
    amountInWithDecimals,
    amountInUsd,
    amountOut,
    amountOutWithDecimals,
}: RateProps) {
    const tCommon = useTranslations("common");
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
            return tCommon("notAvailable");
        }
        return Big(amount2).div(Big(amount1)).toFixed(6);
    }, [amount1, amount2, tCommon]);
    const tokenInUnitUsd = useMemo(() => {
        if (amountInUsd === null) {
            return null;
        }
        if (amountInUsd !== undefined) {
            if (!amount1 || amount1 === "0") {
                return null;
            }
            return formatCurrencyWithSubCent(
                Big(amountInUsd).div(Big(amount1)).toNumber(),
            );
        }
        return formatCurrency(tokenInData?.price || 0);
    }, [amount1, amountInUsd, tokenInData?.price]);

    return (
        <p className="text-sm text-foreground">
            1 {tokenInData?.symbol}
            {tokenInUnitUsd ? ` (${tokenInUnitUsd})` : ""} ≈ {cost}{" "}
            {tokenOutData?.symbol}
        </p>
    );
}
