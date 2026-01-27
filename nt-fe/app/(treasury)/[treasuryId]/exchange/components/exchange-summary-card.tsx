"use client";

import { Token } from "@/components/token-input";

interface ExchangeSummaryCardProps {
  title: string;
  token: Token;
  amount: string;
  usdValue: number;
}

/**
 * Card component to display token amount and USD value
 */
export function ExchangeSummaryCard({
  title,
  token,
  amount,
  usdValue,
}: ExchangeSummaryCardProps) {
  return (
    <div className="flex-1 rounded-lg border bg-muted p-4 flex flex-col items-center gap-2">
      <p className="text-sm text-muted-foreground font-medium">{title}</p>
      <img
        src={token.icon}
        alt={token.symbol}
        className="size-10 rounded-full"
      />
      <p className="text-lg font-semibold">
        {amount}{" "}
        <span className="text-muted-foreground text-xs font-normal">
          {token.symbol}
        </span>
      </p>
      <p className="text-xs text-muted-foreground">
        ≈ $
        {usdValue.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </p>
    </div>
  );
}

