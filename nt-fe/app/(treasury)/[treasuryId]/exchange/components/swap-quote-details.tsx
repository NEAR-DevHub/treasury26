"use client";

import {
    HelpCircleIcon,
    SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { FormattedAmount } from "@/components/formatted-amount";
import { Icon } from "@/components/icon";
import type { Token } from "@/components/token-input";
import { Tooltip } from "@/components/tooltip";
import { minimumReceivedFromRaw } from "@/lib/minimum-received";
import { quoteDecimalAmount } from "../hooks/use-format-quote-amount";
import { ExchangeSettingsModal } from "./exchange-settings-modal";
import {
    quoteRowHelpClass,
    quoteRowLabelClass,
    quoteRowValueClass,
} from "./quote-row";
import { Rate } from "./rate";

interface Quote {
    amountIn: string;
    amountOut: string;
    amountInUsd: string;
    amountOutUsd: string;
    amountOutFormatted?: string;
}

interface SwapQuoteDetailsProps {
    quote: Quote;
    sellToken: Token;
    receiveToken: Token;
    slippageTolerance: number;
    onSlippageChange: (value: number) => void;
}

export function SwapQuoteDetails({
    quote,
    sellToken,
    receiveToken,
    slippageTolerance,
    onSlippageChange,
}: SwapQuoteDetailsProps) {
    const t = useTranslations("exchange");
    const receiveAmount = quoteDecimalAmount({
        amount: quote.amountOut,
        amountFormatted: quote.amountOutFormatted ?? "",
        tokenDecimals: receiveToken.decimals,
    });
    const minReceived = minimumReceivedFromRaw(
        quote.amountOut,
        receiveToken.decimals,
        slippageTolerance,
    );

    return (
        <div className="flex flex-col gap-2.5">
            <Rate
                quote={quote}
                sellToken={sellToken}
                receiveToken={receiveToken}
                variant="compact"
                preferReceiveBase
            />
            <div className="flex items-center justify-between gap-3">
                <span className={quoteRowLabelClass}>
                    {t("maxSlippage")}
                    <Tooltip
                        content={t("maxSlippageTooltip")}
                        contentProps={{ className: "max-w-72" }}
                    >
                        <button
                            type="button"
                            className={quoteRowHelpClass}
                            aria-label={t("maxSlippage")}
                        >
                            <Icon icon={HelpCircleIcon} className="size-3.5" />
                        </button>
                    </Tooltip>
                </span>
                <ExchangeSettingsModal
                    id="exchange-settings-btn"
                    slippageTolerance={slippageTolerance}
                    onSlippageChange={onSlippageChange}
                    receiveAmount={receiveAmount}
                    receiveSymbol={receiveToken.symbol}
                    receiveDecimals={receiveToken.decimals}
                    receivePrice={receiveToken.price}
                    trigger={
                        <button
                            type="button"
                            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-semibold leading-[1.3125rem] text-general-secondary-foreground hover:bg-general-unofficial-ghost-hover"
                        >
                            <FormattedAmount
                                kind="percent"
                                value={slippageTolerance}
                            />
                            <Icon
                                icon={SlidersHorizontalIcon}
                                className="size-3.5"
                            />
                        </button>
                    }
                />
            </div>
            <div className="flex items-center justify-between gap-3">
                <span className={quoteRowLabelClass}>
                    {t("receiveAtLeast")}
                    <Tooltip
                        content={t("receiveAtLeastTooltip")}
                        contentProps={{ className: "max-w-72" }}
                    >
                        <button
                            type="button"
                            className={quoteRowHelpClass}
                            aria-label={t("receiveAtLeast")}
                        >
                            <Icon icon={HelpCircleIcon} className="size-3.5" />
                        </button>
                    </Tooltip>
                </span>
                <span className={quoteRowValueClass}>
                    {minReceived ? (
                        <FormattedAmount
                            kind="token"
                            value={minReceived}
                            symbol={receiveToken.symbol}
                            tokenDecimals={receiveToken.decimals}
                            unitPriceUsd={receiveToken.price}
                            profile="standard"
                            rounding="down"
                        />
                    ) : (
                        "—"
                    )}
                </span>
            </div>
        </div>
    );
}
