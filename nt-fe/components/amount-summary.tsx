"use client";

import { useTranslations } from "next-intl";
import { type AmountValue, decimalOrNull } from "@/lib/amount-format";
import type { ChainIcons } from "@/lib/api";
import { FormattedAmount } from "./formatted-amount";
import { SummaryBlock } from "./summary-block";
import { TokenDisplay } from "./token-display-with-network";
import type { Token } from "./token-input";

interface AmountSummaryProps {
    total: AmountValue | null | undefined;
    totalUSD?: AmountValue | null;
    token: Token;
    title?: string;
    children?: React.ReactNode;
    /**
     * When false, renders without the bordered summary card wrapper
     * Default: true
     */
    useInputBlock?: boolean;
    /**
     * When true, shows network icon badge on token
     * Default: false
     */
    showNetworkIcon?: boolean;
    /**
     * Network badge icons. When omitted, `token.chainIcons` is used.
     */
    chainIcons?: ChainIcons;
}

export function AmountSummary({
    total,
    token,
    title,
    totalUSD,
    children,
    useInputBlock = true,
    showNetworkIcon = false,
    chainIcons,
}: AmountSummaryProps) {
    const t = useTranslations("amountSummary");
    const parsedTotal = decimalOrNull(total);
    const parsedTotalUSD = decimalOrNull(totalUSD);
    const unitPriceUsd =
        parsedTotalUSD && parsedTotal?.gt(0)
            ? parsedTotalUSD.div(parsedTotal)
            : null;

    return (
        <SummaryBlock
            title={title ?? t("defaultTitle")}
            useInputBlock={useInputBlock}
            icon={
                <TokenDisplay
                    symbol={token.symbol}
                    icon={token.icon || ""}
                    chainIcons={
                        showNetworkIcon
                            ? (chainIcons ?? token.chainIcons)
                            : undefined
                    }
                    iconSize="xl"
                />
            }
            secondRow={
                <p className="break-all text-center text-2xl font-semibold leading-tight tracking-tight text-general-foreground">
                    <FormattedAmount
                        kind="token"
                        value={parsedTotal}
                        symbol={token.symbol}
                        tokenDecimals={token.decimals}
                        unitPriceUsd={unitPriceUsd}
                        profile="standard"
                    />
                </p>
            }
            subRow={
                parsedTotalUSD ? (
                    <p className="break-all text-center text-base font-semibold leading-tight text-general-secondary-foreground">
                        ≈<FormattedAmount kind="fiat" value={parsedTotalUSD} />
                    </p>
                ) : undefined
            }
        >
            {children}
        </SummaryBlock>
    );
}
