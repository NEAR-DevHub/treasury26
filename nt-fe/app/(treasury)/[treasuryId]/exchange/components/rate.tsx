"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormattedAmount } from "@/components/formatted-amount";
import type { Token } from "@/components/token-input";
import { decimalFromBaseUnits } from "@/lib/amount-format";
import Big from "@/lib/big";
import { cn } from "@/lib/utils";

interface Quote {
    amountIn: string;
    amountOut: string;
    amountInUsd: string;
    amountOutUsd: string;
}

interface RateProps {
    quote: Quote | null;
    sellToken: Token;
    receiveToken: Token;
    detailed?: boolean;
    className?: string;
}

export function Rate({
    quote,
    sellToken,
    receiveToken,
    detailed: _detailed = false,
    className = "",
}: RateProps) {
    const t = useTranslations("exchangeRate");
    const tCommon = useTranslations("common");
    const [isReversed, setIsReversed] = useState(false);

    if (!quote) return null;

    let baseSymbol: string;
    let quoteSymbol: string;
    let unitUsd: Big | null = null;
    let quotePerBase: Big | null = null;

    try {
        const sellAmount = decimalFromBaseUnits(
            quote.amountIn,
            sellToken.decimals,
        );
        const receiveAmount = decimalFromBaseUnits(
            quote.amountOut,
            receiveToken.decimals,
        );
        if (isReversed) {
            baseSymbol = receiveToken.symbol;
            quoteSymbol = sellToken.symbol;
            if (receiveAmount.gt(0)) {
                unitUsd = Big(quote.amountOutUsd).div(receiveAmount);
                quotePerBase = sellAmount.div(receiveAmount);
            }
        } else {
            baseSymbol = sellToken.symbol;
            quoteSymbol = receiveToken.symbol;
            if (sellAmount.gt(0)) {
                unitUsd = Big(quote.amountInUsd).div(sellAmount);
                quotePerBase = receiveAmount.div(sellAmount);
            }
        }
    } catch {
        baseSymbol = isReversed ? receiveToken.symbol : sellToken.symbol;
        quoteSymbol = isReversed ? sellToken.symbol : receiveToken.symbol;
    }

    return (
        <button
            type="button"
            className={cn(
                "flex w-full gap-2 justify-between items-center cursor-pointer text-left",
                className,
            )}
            onClick={() => setIsReversed(!isReversed)}
            title={t("clickToReverse")}
        >
            <span className="text-muted-foreground">{t("rate")}</span>
            <span className="font-medium">
                {quotePerBase && unitUsd ? (
                    <>
                        1 {baseSymbol} (
                        <FormattedAmount kind="unit-price" value={unitUsd} />) ≈{" "}
                        <FormattedAmount kind="rate" value={quotePerBase} />{" "}
                        {quoteSymbol}
                    </>
                ) : (
                    tCommon("notAvailable")
                )}
            </span>
        </button>
    );
}
