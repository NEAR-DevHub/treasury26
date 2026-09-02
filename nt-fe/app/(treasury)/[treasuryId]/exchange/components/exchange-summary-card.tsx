"use client";

import { AmountSummary } from "@/components/amount-summary";
import type { Token } from "@/components/token-input";
import type { AmountValue } from "@/lib/amount-format";

interface ExchangeSummaryCardProps {
    title: string;
    token: Token;
    amount: AmountValue | null;
    usdValue?: AmountValue | null;
}

/**
 * Card component to display token amount and USD value
 * Uses AmountSummary without InputBlock wrapper
 */
export function ExchangeSummaryCard({
    title,
    token,
    amount,
    usdValue,
}: ExchangeSummaryCardProps) {
    return (
        <AmountSummary
            total={amount}
            totalUSD={usdValue}
            token={token}
            title={title}
            useInputBlock={false}
            showNetworkIcon={true}
        />
    );
}
