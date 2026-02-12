"use client";

import { useState } from "react";
import { Token } from "@/components/token-input";
import { cn } from "@/lib/utils";
import Big from "@/lib/big";

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

/**
 * Calculate exchange rate between two tokens
 */
function calculateExchangeRate(
    amountIn: string,
    amountOut: string,
    amountInUsd: string,
    amountOutUsd: string,
    sellTokenDecimals: number,
    receiveTokenDecimals: number,
    sellTokenSymbol: string,
    receiveTokenSymbol: string,
    isReversed: boolean = false,
): string {
    const sellAmount = Big(amountIn).div(Big(10).pow(sellTokenDecimals));
    const receiveAmount = Big(amountOut).div(Big(10).pow(receiveTokenDecimals));

    if (sellAmount.lte(0) || receiveAmount.lte(0)) {
        return "N/A";
    }

    if (isReversed) {
        // Show: 1 ReceiveToken ($X) ≈ Y SellToken
        const usdPerReceiveToken = Big(amountOutUsd)
            .div(receiveAmount)
            .toFixed(2);
        const sellPerReceive = sellAmount.div(receiveAmount).toFixed(2);
        return `1 ${receiveTokenSymbol} ($${usdPerReceiveToken}) ≈ ${sellPerReceive} ${sellTokenSymbol}`;
    } else {
        // Show: 1 SellToken ($X) ≈ Y ReceiveToken
        const usdPerSellToken = Big(amountInUsd).div(sellAmount).toFixed(2);
        const receivePerSell = receiveAmount.div(sellAmount).toFixed(2);
        return `1 ${sellTokenSymbol} ($${usdPerSellToken}) ≈ ${receivePerSell} ${receiveTokenSymbol}`;
    }
}

/**
 * Calculate detailed exchange rate with better formatting
 */
function calculateDetailedExchangeRate(
    amountIn: string,
    amountOut: string,
    amountInUsd: string,
    amountOutUsd: string,
    sellTokenDecimals: number,
    receiveTokenDecimals: number,
    sellTokenSymbol: string,
    receiveTokenSymbol: string,
    isReversed: boolean = false,
): string {
    const sellAmount = Big(amountIn).div(Big(10).pow(sellTokenDecimals));
    const receiveAmount = Big(amountOut).div(Big(10).pow(receiveTokenDecimals));

    if (sellAmount.lte(0) || receiveAmount.lte(0)) {
        return "N/A";
    }

    if (isReversed) {
        // Show: 1 ReceiveToken ($X) ≈ Y SellToken
        const usdPerReceiveToken =
            parseFloat(amountOut) > 0
                ? Big(amountOutUsd).div(receiveAmount).toFixed(2)
                : "0";
        const sellPerReceive = receiveAmount.gt(0)
            ? sellAmount.div(receiveAmount).toFixed(2)
            : "0";
        return `1 ${receiveTokenSymbol} ($${usdPerReceiveToken}) ≈ ${sellPerReceive} ${sellTokenSymbol}`;
    } else {
        // Show: 1 SellToken ($X) ≈ Y ReceiveToken
        const usdPerSellToken =
            parseFloat(amountIn) > 0
                ? Big(amountInUsd).div(sellAmount).toFixed(2)
                : "0";
        const receivePerSell = sellAmount.gt(0)
            ? receiveAmount.div(sellAmount).toFixed(2)
            : "0";
        return `1 ${sellTokenSymbol} ($${usdPerSellToken}) ≈ ${receivePerSell} ${receiveTokenSymbol}`;
    }
}

/**
 * Displays the exchange rate with click-to-reverse functionality
 * Manages its own reversed state internally
 */
export function Rate({
    quote,
    sellToken,
    receiveToken,
    detailed = false,
    className = "",
}: RateProps) {
    const [isReversed, setIsReversed] = useState(false);

    if (!quote) return null;

    const calculateRate = detailed
        ? calculateDetailedExchangeRate
        : calculateExchangeRate;

    const rate = calculateRate(
        quote.amountIn,
        quote.amountOut,
        quote.amountInUsd,
        quote.amountOutUsd,
        sellToken.decimals,
        receiveToken.decimals,
        sellToken.symbol,
        receiveToken.symbol,
        isReversed,
    );

    return (
        <div
            className={cn(
                "flex gap-2 justify-between items-center cursor-pointer",
                className,
            )}
            onClick={() => setIsReversed(!isReversed)}
            title="Click to reverse rate"
        >
            <span className="text-muted-foreground">Rate</span>
            <span className="font-medium">{rate}</span>
        </div>
    );
}
