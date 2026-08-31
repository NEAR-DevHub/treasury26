"use client";

import { ArrowDown02Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { BALANCE_MASK, useIsBalanceMasked } from "@/components/balance-mask";
import { Icon } from "@/components/icon";
import { TokenDisplay } from "@/components/token-display-with-network";
import { Skeleton } from "@/components/ui/skeleton";
import { WRAP_NEAR_TOKEN_ID } from "@/constants/network-ids";
import { useQuoteByDepositAddress } from "@/hooks/use-proposals";
import { useSearchIntentsTokens, useToken } from "@/hooks/use-treasury-queries";
import Big from "@/lib/big";
import {
    calculateExchangeFeeAmount,
    EXCHANGE_FEE_PERCENTAGE,
} from "@/lib/exchange-fee";
import {
    formatBalance,
    formatCurrencyWithSubCent,
    formatTokenDisplayAmount,
} from "@/lib/utils";
import type { SwapRequestData } from "../../types/index";
import { useRequestDisplayContext } from "../expanded-view/common/request-display-context";
import { DetailRow, DetailsCard } from "./primitives";

/**
 * The body of the details sheet for an Exchange request: the two sides of the
 * swap stacked as cards with the direction arrow straddling them, then the
 * terms the quote was struck on.
 */
export function SwapDetails({ data }: { data: SwapRequestData }) {
    const t = useTranslations("proposals.expanded");
    const tExchange = useTranslations("exchange");
    const isExecuted = useRequestDisplayContext()?.isExecuted ?? false;

    // A wrap/unwrap is a 1:1 conversion between NEAR and wNEAR, named by
    // contract and recorded in human-readable units. Every other swap goes
    // through Intents: it names its tokens by asset id and records what it
    // sends in the token's own base units.
    const isWrapConversion = data.source === WRAP_NEAR_TOKEN_ID;
    // New Intents proposals carry both asset ids in their description; older
    // ones only named the symbols, so those have to be resolved by search.
    const hasAddresses = !!(data.tokenInAddress && data.tokenOutAddress);
    const { data: legacyTokensData } = useSearchIntentsTokens(
        {
            tokenIn: data.tokenIn,
            tokenOut: data.tokenOut,
            intentsTokenContractId: data.intentsTokenContractId,
            destinationNetwork: data.destinationNetwork,
        },
        !hasAddresses && !isWrapConversion,
    );
    const tokenInId =
        data.tokenInAddress ||
        legacyTokensData?.tokenIn?.defuseAssetId ||
        data.tokenIn;
    const tokenOutId =
        data.tokenOutAddress ||
        legacyTokensData?.tokenOut?.defuseAssetId ||
        data.tokenOut;

    const { data: tokenIn } = useToken(tokenInId);
    const { data: tokenOut } = useToken(tokenOutId);

    // An executed swap only learns its settled USD values from the quote, so
    // they are fetched when the proposal doesn't already carry them.
    const shouldLoadQuoteUsd =
        isExecuted &&
        !!data.depositAddress &&
        (data.amountInUsd == null || data.amountOutUsd == null);
    const { data: quote } = useQuoteByDepositAddress(
        data.depositAddress || null,
        undefined,
        shouldLoadQuoteUsd,
    );

    const amountIn = isWrapConversion
        ? data.amountIn
        : formatBalance(data.amountIn, tokenIn?.decimals ?? 24);
    const amountOut = data.amountOut;

    const usdIn = resolveUsd(data.amountInUsd, quote?.amountInUsd, {
        amount: amountIn,
        price: tokenIn?.price,
    });
    const usdOut = resolveUsd(data.amountOutUsd, quote?.amountOutUsd, {
        amount: amountOut,
        price: tokenOut?.price,
    });

    const rate = safeBig(amountIn)?.gt(0)
        ? Big(amountOut).div(Big(amountIn))
        : null;
    // A wrap is 1:1 by construction, so there is no market to differ from.
    const priceDifference =
        isWrapConversion || usdIn === null || usdOut === null || usdIn <= 0
            ? null
            : {
                  usd: usdOut - usdIn,
                  percent: ((usdOut - usdIn) / usdIn) * 100,
              };
    const minimumReceived = data.slippage
        ? Big(amountOut)
              .mul(100 - Number(data.slippage))
              .div(100)
        : null;

    return (
        <>
            <div className="relative flex flex-col gap-3">
                <SwapSide
                    amount={amountIn}
                    usdValue={usdIn}
                    symbol={tokenIn?.symbol}
                    icon={tokenIn?.icon}
                />
                <SwapSide
                    amount={amountOut}
                    usdValue={usdOut}
                    symbol={tokenOut?.symbol}
                    icon={tokenOut?.icon}
                />
                <div className="-translate-x-1/2 -translate-y-1/2 absolute left-1/2 top-1/2 flex size-10 items-center justify-center rounded-lg border border-general-border bg-card">
                    <Icon
                        icon={ArrowDown02Icon}
                        className="size-5 text-general-secondary-foreground"
                    />
                </div>
            </div>

            <DetailsCard className="flex flex-col gap-1 p-4">
                {rate && tokenIn && tokenOut && (
                    <DetailRow
                        label={t("exchangeRate")}
                        value={`1 ${tokenIn.symbol} = ${formatTokenDisplayAmount(rate)} ${tokenOut.symbol}`}
                    />
                )}
                {priceDifference && (
                    <DetailRow
                        label={t("priceDifference")}
                        info={t("priceDifferenceTooltip")}
                        value={`${priceDifference.percent >= 0 ? "+" : ""}${priceDifference.percent.toFixed(4)}% (${
                            priceDifference.usd >= 0 ? "+" : "-"
                        }${formatCurrencyWithSubCent(Math.abs(priceDifference.usd))})`}
                    />
                )}
                {data.slippage && (
                    <DetailRow
                        label={t("maxSlippage")}
                        info={t("slippageTooltip")}
                        value={`${data.slippage}%`}
                    />
                )}
                {minimumReceived && (
                    <DetailRow
                        label={t("receiveAtLeast")}
                        info={t("minReceiveTooltip")}
                        value={
                            tokenOut ? (
                                `${formatTokenDisplayAmount(minimumReceived)} ${tokenOut.symbol}`
                            ) : (
                                <Skeleton className="h-5 w-24" />
                            )
                        }
                    />
                )}
                {!isWrapConversion && (
                    <DetailRow
                        label={t("exchangeFee")}
                        info={tExchange("info.exchangeFeeTooltip")}
                        value={
                            tokenIn ? (
                                `${EXCHANGE_FEE_PERCENTAGE}% / ${formatTokenDisplayAmount(
                                    calculateExchangeFeeAmount(amountIn),
                                )} ${tokenIn.symbol}`
                            ) : (
                                <Skeleton className="h-5 w-24" />
                            )
                        }
                    />
                )}
            </DetailsCard>
        </>
    );
}

/** One leg of the swap: the token, what moves, and what it is worth. */
function SwapSide({
    amount,
    usdValue,
    symbol,
    icon,
}: {
    amount: string;
    usdValue: number | null;
    symbol: string | undefined;
    icon: string | undefined;
}) {
    const isMasked = useIsBalanceMasked();

    return (
        <DetailsCard className="flex items-center gap-2.5 rounded-3xl px-4 py-5">
            {symbol ? (
                <TokenDisplay symbol={symbol} icon={icon ?? ""} iconSize="xl" />
            ) : (
                <Skeleton className="size-9 shrink-0 rounded-full" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="flex items-center gap-[5px]">
                    <span className="truncate text-2xl font-semibold leading-[1.2] tracking-[-0.48px]">
                        {isMasked
                            ? BALANCE_MASK
                            : formatTokenDisplayAmount(amount)}
                    </span>
                    <span className="shrink-0 text-xl font-semibold leading-[1.2] tracking-[-0.4px] text-general-muted-foreground">
                        {symbol}
                    </span>
                </p>
                {usdValue !== null && (
                    <p className="text-base font-semibold leading-[1.2] text-general-secondary-foreground">
                        {isMasked
                            ? BALANCE_MASK
                            : formatCurrencyWithSubCent(usdValue)}
                    </p>
                )}
            </div>
        </DetailsCard>
    );
}

/**
 * What a leg of the swap was worth. A proposal only records the figure when the
 * quote was priced at creation; otherwise it falls back to the settled quote
 * and finally to the token's spot price.
 */
function resolveUsd(
    fromProposal: number | null | undefined,
    fromQuote: string | null | undefined,
    spot: { amount: string; price: number | undefined },
): number | null {
    if (fromProposal != null) return fromProposal;

    const quoted = fromQuote ? Number(fromQuote) : Number.NaN;
    if (!Number.isNaN(quoted)) return quoted;

    const amount = safeBig(spot.amount);
    if (!spot.price || !amount) return null;
    return amount.mul(spot.price).toNumber();
}

function safeBig(value: string) {
    try {
        return Big(value);
    } catch {
        return null;
    }
}
