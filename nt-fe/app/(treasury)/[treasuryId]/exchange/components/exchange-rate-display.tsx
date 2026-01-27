"use client";

import { useState } from "react";
import { calculateExchangeRate, calculateDetailedExchangeRate } from "../utils";
import { Token } from "@/components/token-input";

interface Quote {
  amountIn: string;
  amountOut: string;
  amountInUsd: string;
  amountOutUsd: string;
}

interface ExchangeRateDisplayProps {
  quote: Quote | null;
  sellToken: Token;
  receiveToken: Token;
  detailed?: boolean;
  className?: string;
}

/**
 * Displays the exchange rate with click-to-reverse functionality
 * Manages its own reversed state internally
 */
export function ExchangeRateDisplay({
  quote,
  sellToken,
  receiveToken,
  detailed = false,
  className = "",
}: ExchangeRateDisplayProps) {
  const [isReversed, setIsReversed] = useState(false);

  if (!quote) return null;

  const calculateRate = detailed ? calculateDetailedExchangeRate : calculateExchangeRate;

  const rate = calculateRate(
    quote.amountIn,
    quote.amountOut,
    quote.amountInUsd,
    quote.amountOutUsd,
    sellToken.decimals,
    receiveToken.decimals,
    sellToken.symbol,
    receiveToken.symbol,
    isReversed
  );

  return (
    <div
      className={`flex justify-between items-center cursor-pointer ${className}`}
      onClick={() => setIsReversed(!isReversed)}
      title="Click to reverse rate"
    >
      <span className="text-muted-foreground">Rate</span>
      <span className="font-medium">{rate}</span>
    </div>
  );
}
