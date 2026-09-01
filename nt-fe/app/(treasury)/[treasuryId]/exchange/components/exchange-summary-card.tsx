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
        <div className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl border border-general-border bg-card px-4 py-4 sm:min-h-40 sm:flex-col sm:items-center sm:justify-center sm:gap-3 sm:py-6 sm:text-center">
            <TokenDisplay
                symbol={token.symbol}
                icon={token.icon || ""}
                chainIcons={token.chainIcons}
                iconSize="xl"
                className="size-[2.125rem]"
            />
            <div className="flex min-w-0 flex-col items-start gap-0.5 sm:w-full sm:items-center">
                <div className="sm:hidden">
                    <span className="text-sm font-semibold leading-normal text-general-foreground">
                        <FormattedAmount
                            kind="token"
                            value={parsedTotal}
                            symbol={token.symbol}
                            tokenDecimals={token.decimals}
                            unitPriceUsd={unitPriceUsd}
                            profile="standard"
                        />
                    </span>
                </div>
                <div className="hidden w-full min-w-0 sm:block">
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
                    <p className="break-all text-sm font-semibold leading-4 text-general-secondary-foreground sm:text-center sm:text-base sm:leading-[1.2]">
                        <FormattedAmount kind="fiat" value={parsedTotalUSD} />
                    </p>
                ) : null}
            </div>
        </div>
    );
}
