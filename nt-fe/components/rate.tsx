"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { FormattedAmount } from "@/components/formatted-amount";
import { useToken } from "@/hooks/use-treasury-queries";
import {
    type AmountValue,
    decimalFromBaseUnitsOrNull,
    decimalOrNull,
} from "@/lib/amount-format";

interface RateProps {
    tokenIn: string;
    tokenOut: string;
    amountIn?: AmountValue;
    amountInWithDecimals?: string;
    amountInUsd?: number | null;
    amountOut?: AmountValue;
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
        ? decimalFromBaseUnitsOrNull(amountIn, tokenInData?.decimals || 24)
        : amountInWithDecimals
          ? decimalOrNull(amountInWithDecimals)
          : null;
    const amount2 = amountOut
        ? decimalFromBaseUnitsOrNull(amountOut, tokenOutData?.decimals || 24)
        : amountOutWithDecimals
          ? decimalOrNull(amountOutWithDecimals)
          : null;

    const cost = useMemo(() => {
        if (!amount1 || !amount2 || amount1.eq(0) || amount2.eq(0)) return null;
        return amount2.div(amount1);
    }, [amount1, amount2]);
    const tokenInUnitUsd = useMemo(() => {
        if (amountInUsd === null) {
            return null;
        }
        if (amountInUsd !== undefined) {
            if (!amount1 || amount1.eq(0)) return null;
            const parsedAmountUsd = decimalOrNull(amountInUsd);
            return parsedAmountUsd ? parsedAmountUsd.div(amount1) : null;
        }
        return decimalOrNull(tokenInData?.price);
    }, [amount1, amountInUsd, tokenInData?.price]);

    return (
        <p className="text-sm text-foreground">
            1 {tokenInData?.symbol}
            {tokenInUnitUsd ? (
                <>
                    {" "}
                    (
                    <FormattedAmount kind="unit-price" value={tokenInUnitUsd} />
                    )
                </>
            ) : null}{" "}
            ≈{" "}
            {cost ? (
                <FormattedAmount kind="rate" value={cost} />
            ) : (
                tCommon("notAvailable")
            )}{" "}
            {tokenOutData?.symbol}
        </p>
    );
}
