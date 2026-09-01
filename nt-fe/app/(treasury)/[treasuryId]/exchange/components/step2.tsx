"use client";

import {
    ArrowDown01Icon,
    ArrowRight01Icon,
    HelpCircleIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useFormContext } from "react-hook-form";
import { CreateRequestButton } from "@/components/create-request-button";
import { FormattedAmount } from "@/components/formatted-amount";
import { Icon } from "@/components/icon";
import { Input } from "@/components/input";
import { ReviewStep, type StepProps } from "@/components/step-wizard";
import { Tooltip } from "@/components/tooltip";
import { FormField } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { useTreasury } from "@/hooks/use-treasury";
import { decimalOrNull } from "@/lib/amount-format";
import {
    calculateExchangeFeeAmount,
    EXCHANGE_FEE_PERCENTAGE,
} from "@/lib/exchange-fee";
import { minimumReceivedFromRaw } from "@/lib/minimum-received";
import { cn } from "@/lib/utils";
import { PROPOSAL_REFRESH_INTERVAL } from "../constants";
import type { ExchangeFormValues } from "../exchange-form";
import { useCountdownTimer } from "../hooks/use-countdown-timer";
import { useExchangeAmountQuote } from "../hooks/use-exchange-amount-quote";
import { useQuoteDecimalAmount } from "../hooks/use-format-quote-amount";
import { calculateMarketPriceDifference, isNEARWrapConversion } from "../utils";
import { ExchangeSummaryCard } from "./exchange-summary-card";
import {
    quoteRowHelpClass,
    quoteRowLabelClass,
    quoteRowValueClass,
} from "./quote-row";
import { Rate } from "./rate";

function DetailRow({
    label,
    info,
    children,
}: {
    label: string;
    info?: string;
    children: ReactNode;
}) {
    return (
        <div className="flex items-center justify-between gap-3">
            <span className={quoteRowLabelClass}>
                {label}
                {info ? (
                    <Tooltip
                        content={info}
                        contentProps={{ className: "max-w-72" }}
                    >
                        <button
                            type="button"
                            className={quoteRowHelpClass}
                            aria-label={label}
                        >
                            <Icon icon={HelpCircleIcon} className="size-3.5" />
                        </button>
                    </Tooltip>
                ) : null}
            </span>
            <span className={cn("text-right", quoteRowValueClass)}>
                {children}
            </span>
        </div>
    );
}

export function Step2({ handleBack }: StepProps) {
    const tEx = useTranslations("exchange");
    const tPay = useTranslations("payments");
    const form = useFormContext<ExchangeFormValues>();
    const { treasuryId: selectedTreasury, isConfidential } = useTreasury();

    const {
        sellToken,
        receiveToken,
        slippageTolerance,
        quoteData: localLiveQuoteData,
        quoteError: liveQuoteError,
        isLoadingQuote: isLoadingLiveQuote,
        isFetchingQuote: isFetchingLiveQuote,
    } = useExchangeAmountQuote({
        form,
        selectedTreasury,
        isConfidential,
        isDryRun: false,
        refetchInterval: PROPOSAL_REFRESH_INTERVAL,
    });

    const sellAmount = useQuoteDecimalAmount(
        localLiveQuoteData?.quote
            ? {
                  amount: localLiveQuoteData.quote.amountIn,
                  amountFormatted: localLiveQuoteData.quote.amountInFormatted,
                  tokenDecimals: sellToken.decimals,
              }
            : null,
    );
    const receiveAmount = useQuoteDecimalAmount(
        localLiveQuoteData?.quote
            ? {
                  amount: localLiveQuoteData.quote.amountOut,
                  amountFormatted: localLiveQuoteData.quote.amountOutFormatted,
                  tokenDecimals: receiveToken.decimals,
              }
            : null,
    );

    const timeUntilRefresh = useCountdownTimer(
        !!localLiveQuoteData && !isFetchingLiveQuote,
        PROPOSAL_REFRESH_INTERVAL,
        localLiveQuoteData?.quote.depositAddress,
    );

    const isWrapConversion = isNEARWrapConversion(sellToken, receiveToken);

    const marketPriceDifference = localLiveQuoteData
        ? isWrapConversion
            ? {
                  percentDifference: "0",
                  usdDifference: "0",
                  isFavorable: true,
                  hasMarketData: true,
              }
            : calculateMarketPriceDifference(
                  localLiveQuoteData.quote.amountInUsd,
                  localLiveQuoteData.quote.amountOutUsd,
              )
        : null;

    const minReceived = localLiveQuoteData
        ? minimumReceivedFromRaw(
              localLiveQuoteData.quote.amountOut,
              receiveToken.decimals,
              slippageTolerance,
          )
        : null;
    const feeAmount = sellAmount
        ? calculateExchangeFeeAmount(sellAmount)
        : null;
    const priceUsdAbs =
        decimalOrNull(marketPriceDifference?.usdDifference)?.abs() ?? null;

    return (
        <ReviewStep reviewingTitle={tEx("review")} handleBack={handleBack}>
            <div className="flex flex-col gap-4">
                {isLoadingLiveQuote ? (
                    <div className="relative mb-2 flex flex-col gap-2 sm:flex-row sm:items-stretch">
                        <Skeleton className="h-16 w-full rounded-2xl sm:h-40 sm:flex-1" />
                        <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
                            <Skeleton className="size-8 rounded-lg" />
                        </div>
                        <Skeleton className="h-16 w-full rounded-2xl sm:h-40 sm:flex-1" />
                    </div>
                ) : localLiveQuoteData ? (
                    <>
                        <div className="relative flex flex-col gap-2 sm:flex-row sm:items-stretch">
                            <ExchangeSummaryCard
                                token={sellToken}
                                amount={sellAmount}
                                usdValue={localLiveQuoteData.quote.amountInUsd}
                            />
                            <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
                                <div className="flex size-8 items-center justify-center rounded-lg border border-general-border bg-card text-muted-foreground">
                                    <Icon
                                        icon={ArrowDown01Icon}
                                        className="sm:hidden"
                                    />
                                    <Icon
                                        icon={ArrowRight01Icon}
                                        className="hidden sm:block"
                                    />
                                </div>
                            </div>
                            <ExchangeSummaryCard
                                token={receiveToken}
                                amount={receiveAmount}
                                usdValue={localLiveQuoteData.quote.amountOutUsd}
                            />
                        </div>

                        <div className="flex flex-col gap-2.5">
                            <Rate
                                quote={localLiveQuoteData.quote}
                                sellToken={sellToken}
                                receiveToken={receiveToken}
                                variant="compact"
                                preferReceiveBase
                            />
                            {marketPriceDifference?.hasMarketData ? (
                                <DetailRow
                                    label={tEx("info.priceDifference")}
                                    info={tEx("info.priceDifferenceTooltip")}
                                >
                                    <FormattedAmount
                                        kind="percent"
                                        value={
                                            marketPriceDifference.percentDifference
                                        }
                                        signDisplay="auto"
                                    />{" "}
                                    (
                                    {marketPriceDifference.isFavorable
                                        ? "+"
                                        : "-"}
                                    <FormattedAmount
                                        kind="fiat"
                                        value={priceUsdAbs}
                                    />
                                    )
                                </DetailRow>
                            ) : null}
                            <DetailRow
                                label={tEx("maxSlippage")}
                                info={tEx("maxSlippageTooltip")}
                            >
                                <FormattedAmount
                                    kind="percent"
                                    value={slippageTolerance}
                                />
                            </DetailRow>
                            <DetailRow
                                label={tEx("receiveAtLeast")}
                                info={tEx("receiveAtLeastTooltip")}
                            >
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
                            </DetailRow>
                            {!isWrapConversion ? (
                                <DetailRow
                                    label={tEx("info.exchangeFee")}
                                    info={tEx("info.exchangeFeeTooltip")}
                                >
                                    <FormattedAmount
                                        kind="percent"
                                        value={EXCHANGE_FEE_PERCENTAGE}
                                    />{" "}
                                    /{" "}
                                    <FormattedAmount
                                        kind="token"
                                        value={feeAmount}
                                        symbol={sellToken.symbol}
                                        tokenDecimals={sellToken.decimals}
                                        unitPriceUsd={sellToken.price}
                                        profile="standard"
                                        rounding="up"
                                    />
                                </DetailRow>
                            ) : null}
                        </div>
                    </>
                ) : null}

                <FormField
                    control={form.control}
                    name="comment"
                    render={({ field }) => (
                        <Input
                            value={field.value ?? ""}
                            onChange={field.onChange}
                            placeholder={tPay("commentPlaceholder")}
                            inputClassName="h-11 rounded-xl border border-general-border bg-general-bg-tertiary! hover:bg-general-bg-tertiary! focus-visible:border-general-border focus-visible:ring-0"
                        />
                    )}
                />

                <CreateRequestButton
                    isSubmitting={form.formState.isSubmitting}
                    type="submit"
                    className="w-full h-12 rounded-2xl"
                    permissions={[{ kind: "call", action: "AddProposal" }]}
                    idleMessage={tEx("confirmSubmit")}
                    disabled={
                        isLoadingLiveQuote ||
                        !localLiveQuoteData ||
                        !!liveQuoteError
                    }
                />

                {localLiveQuoteData && !isLoadingLiveQuote ? (
                    <p className="text-center text-sm font-medium leading-[1.3125rem] text-general-secondary-foreground">
                        {tEx("refreshingIn", { seconds: timeUntilRefresh })}
                    </p>
                ) : null}
            </div>
        </ReviewStep>
    );
}
