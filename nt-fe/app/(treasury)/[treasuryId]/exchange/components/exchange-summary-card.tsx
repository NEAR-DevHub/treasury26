"use client";

import { FittingFormattedAmount } from "@/components/fitting-text";
import { FormattedAmount } from "@/components/formatted-amount";
import { TokenDisplay } from "@/components/token-display-with-network";
import type { Token } from "@/components/token-input";
import { type AmountValue, decimalOrNull } from "@/lib/amount-format";

interface ExchangeSummaryCardProps {
    token: Token;
    amount: AmountValue | null;
    usdValue?: AmountValue | null;
}

export function ExchangeSummaryCard({
    token,
    amount,
    usdValue,
}: ExchangeSummaryCardProps) {
    const parsedTotal = decimalOrNull(amount);
    const parsedTotalUSD = decimalOrNull(usdValue);
    const unitPriceUsd =
        parsedTotalUSD && parsedTotal?.gt(0)
            ? parsedTotalUSD.div(parsedTotal)
            : null;

    return (
        <div className="flex min-h-40 min-w-0 flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-general-border bg-card px-4 py-6 text-center">
            <TokenDisplay
                symbol={token.symbol}
                icon={token.icon || ""}
                chainIcons={token.chainIcons}
                iconSize="xl"
                className="size-[2.125rem]"
            />
            <div className="flex w-full min-w-0 flex-col items-center gap-0.5">
                <div className="w-full min-w-0">
                    <FittingFormattedAmount
                        value={parsedTotal}
                        symbol={token.symbol}
                        tokenDecimals={token.decimals}
                        unitPriceUsd={unitPriceUsd}
                        maxPx={24}
                        minPx={14}
                        className="text-center font-semibold tracking-tight text-general-foreground"
                    />
                </div>
                {parsedTotalUSD ? (
                    <p className="break-all text-center text-base font-semibold leading-[1.2] text-general-secondary-foreground">
                        <FormattedAmount kind="fiat" value={parsedTotalUSD} />
                    </p>
                ) : null}
            </div>
        </div>
    );
}
