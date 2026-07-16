"use client";

import { ChevronRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useFormContext } from "react-hook-form";
import { PageCard } from "@/components/card";
import { CopyButton } from "@/components/copy-button";
import { CreateRequestButton } from "@/components/create-request-button";
import { useFormatDate } from "@/components/formatted-date";
import { InfoDisplay } from "@/components/info-display";
import { ReviewStep, type StepProps } from "@/components/step-wizard";
import { Skeleton } from "@/components/ui/skeleton";
import { WarningAlert } from "@/components/warning-alert";
import { useTreasury } from "@/hooks/use-treasury";
import {
    calculateExchangeFeeAmount,
    EXCHANGE_FEE_PERCENTAGE,
} from "@/lib/exchange-fee";
import {
    formatBalance,
    formatCurrencyWithSubCent,
    formatDurationSeconds,
    formatTokenDisplayAmount,
} from "@/lib/utils";
import { PROPOSAL_REFRESH_INTERVAL } from "../constants";
import type { ExchangeFormValues } from "../exchange-form";
import { useCountdownTimer } from "../hooks/use-countdown-timer";
import { useExchangeAmountQuote } from "../hooks/use-exchange-amount-quote";
import { useFormatQuoteAmount } from "../hooks/use-format-quote-amount";
import { calculateMarketPriceDifference, isNEARWrapConversion } from "../utils";
import { ExchangeSummaryCard } from "./exchange-summary-card";
import { Rate } from "./rate";

export function Step2({ handleBack }: StepProps) {
    const tEx = useTranslations("exchange");
    const locale = useLocale();
    const form = useFormContext<ExchangeFormValues>();
    const { treasuryId: selectedTreasury, isConfidential } = useTreasury();
    const formatDate = useFormatDate();

    const {
        sellToken,
        receiveToken,
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

    const formattedReceiveAmount = useFormatQuoteAmount(
        localLiveQuoteData?.quote
            ? {
                  amount: localLiveQuoteData.quote.amountOut,
                  amountFormatted: localLiveQuoteData.quote.amountOutFormatted,
                  amountUsd: localLiveQuoteData.quote.amountOutUsd,
                  tokenDecimals: receiveToken.decimals,
              }
            : null,
    );

    const timeUntilRefresh = useCountdownTimer(
        !!localLiveQuoteData && !isFetchingLiveQuote,
        PROPOSAL_REFRESH_INTERVAL,
        localLiveQuoteData?.quote.depositAddress,
    );

    // Check if this is a NEAR ↔ wrap.near conversion (1:1, no price difference)
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

    return (
        <PageCard>
            <ReviewStep reviewingTitle={tEx("review")} handleBack={handleBack}>
                {isLoadingLiveQuote ? (
                    // Loading skeleton for entire review section
                    <>
                        <div className="relative flex justify-center items-center gap-4 mb-6">
                            <div className="w-full max-w-[280px] rounded-lg border bg-muted p-4 flex flex-col items-center gap-2 h-[180px] justify-center">
                                <Skeleton className="h-4 w-24" />
                                <Skeleton className="size-10 rounded-full" />
                                <Skeleton className="h-6 w-32" />
                                <Skeleton className="h-3 w-20" />
                            </div>

                            <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2">
                                <div className="rounded-full bg-card border p-1.5 shadow-sm">
                                    <ChevronRight className="size-6 text-muted-foreground" />
                                </div>
                            </div>

                            <div className="w-full max-w-[280px] rounded-lg border bg-muted p-4 flex flex-col items-center gap-2 h-[180px] justify-center">
                                <Skeleton className="h-4 w-24" />
                                <Skeleton className="size-10 rounded-full" />
                                <Skeleton className="h-6 w-32" />
                                <Skeleton className="h-3 w-20" />
                            </div>
                        </div>

                        <div className="flex flex-col gap-2">
                            <Skeleton className="h-6 w-full" />
                            <Skeleton className="h-6 w-full" />
                            <Skeleton className="h-6 w-full" />
                        </div>
                    </>
                ) : localLiveQuoteData ? (
                    // Actual content when loaded
                    <>
                        <div className="relative flex justify-center items-center gap-4 mb-6">
                            <ExchangeSummaryCard
                                title={tEx("sell")}
                                token={sellToken}
                                amount={
                                    localLiveQuoteData.quote.amountInFormatted
                                }
                                usdValue={
                                    Number(
                                        localLiveQuoteData.quote.amountInUsd,
                                    ) || 0
                                }
                            />

                            <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2">
                                <div className="rounded-full bg-card border p-1.5 shadow-sm">
                                    <ChevronRight className="size-6 text-muted-foreground" />
                                </div>
                            </div>

                            <ExchangeSummaryCard
                                title={tEx("receive")}
                                token={receiveToken}
                                amount={formattedReceiveAmount}
                                usdValue={
                                    Number(
                                        localLiveQuoteData.quote.amountOutUsd,
                                    ) || 0
                                }
                            />
                        </div>

                        <div className="flex flex-col gap-1 text-sm">
                            <Rate
                                quote={localLiveQuoteData.quote}
                                sellToken={sellToken}
                                receiveToken={receiveToken}
                                detailed
                            />

                            <InfoDisplay
                                className="gap-0"
                                hideSeparator
                                size="sm"
                                items={[
                                    ...(marketPriceDifference &&
                                    marketPriceDifference.hasMarketData
                                        ? [
                                              {
                                                  label: tEx(
                                                      "info.priceDifference",
                                                  ),
                                                  value: (
                                                      <span className="font-medium">
                                                          {marketPriceDifference.isFavorable
                                                              ? "+"
                                                              : ""}
                                                          {
                                                              marketPriceDifference.percentDifference
                                                          }
                                                          % (
                                                          {marketPriceDifference.isFavorable
                                                              ? "+"
                                                              : "-"}
                                                          {formatCurrencyWithSubCent(
                                                              Math.abs(
                                                                  Number(
                                                                      marketPriceDifference.usdDifference,
                                                                  ),
                                                              ),
                                                          )}
                                                          )
                                                      </span>
                                                  ),
                                                  info: tEx(
                                                      "info.priceDifferenceTooltip",
                                                  ),
                                              },
                                          ]
                                        : []),
                                    {
                                        label: tEx("info.estimatedTime"),
                                        value: isWrapConversion
                                            ? tEx("info.instant")
                                            : (formatDurationSeconds(
                                                  localLiveQuoteData.quote
                                                      .timeEstimate,
                                                  locale,
                                              ) ?? tEx("info.instant")),
                                        info: tEx("info.estimatedTimeTooltip"),
                                    },
                                    {
                                        label: tEx("info.minimumReceived"),
                                        value: `${formatTokenDisplayAmount(
                                            formatBalance(
                                                localLiveQuoteData.quote
                                                    .minAmountOut,
                                                receiveToken.decimals,
                                            ),
                                        )} ${receiveToken.symbol}`,
                                        info: tEx(
                                            "info.minimumReceivedTooltip",
                                        ),
                                    },
                                    {
                                        label: tEx("info.depositAddress"),
                                        value: (
                                            <div className="flex items-center gap-2">
                                                {`${localLiveQuoteData.quote.depositAddress.slice(
                                                    0,
                                                    8,
                                                )}....${localLiveQuoteData.quote.depositAddress.slice(
                                                    -6,
                                                )}`}
                                                <CopyButton
                                                    text={
                                                        localLiveQuoteData.quote
                                                            .depositAddress
                                                    }
                                                    toastMessage={tEx(
                                                        "info.depositAddressCopied",
                                                    )}
                                                    variant="unstyled"
                                                    size="icon"
                                                    className="h-6 w-6 p-0!"
                                                    iconClassName="h-3 w-3"
                                                />
                                            </div>
                                        ),
                                    },
                                    {
                                        label: tEx("info.quoteExpires"),
                                        value: (
                                            <span className="text-destructive">
                                                {formatDate(
                                                    localLiveQuoteData
                                                        .quoteRequest.deadline,
                                                    {
                                                        includeTime: true,
                                                        includeTimezone: true,
                                                    },
                                                )}
                                            </span>
                                        ),
                                    },
                                    // Don't show Widget Fee for NEAR ↔ wNEAR conversions
                                    ...(!isWrapConversion
                                        ? [
                                              {
                                                  label: tEx(
                                                      "info.exchangeFee",
                                                  ),
                                                  value: (() => {
                                                      const feeAmount =
                                                          calculateExchangeFeeAmount(
                                                              localLiveQuoteData
                                                                  .quote
                                                                  .amountInFormatted,
                                                          );

                                                      return `${EXCHANGE_FEE_PERCENTAGE}% / ${formatTokenDisplayAmount(
                                                          feeAmount,
                                                      )} ${sellToken.symbol}`;
                                                  })(),
                                                  info: tEx(
                                                      "info.exchangeFeeTooltip",
                                                  ),
                                              },
                                          ]
                                        : []),
                                ]}
                            />
                        </div>
                    </>
                ) : null}

                <WarningAlert message={tEx("approveWithin24h")} />

                <></>
            </ReviewStep>

            <div className="rounded-lg border bg-card p-0 overflow-hidden">
                <CreateRequestButton
                    isSubmitting={form.formState.isSubmitting}
                    type="submit"
                    className="w-full h-10 rounded-none"
                    permissions={[{ kind: "call", action: "AddProposal" }]}
                    idleMessage={tEx("confirmSubmit")}
                    disabled={
                        isLoadingLiveQuote ||
                        !localLiveQuoteData ||
                        !!liveQuoteError
                    }
                />
            </div>

            {localLiveQuoteData && !isLoadingLiveQuote && (
                <p className="text-center text-sm text-muted-foreground">
                    {tEx("refreshingIn", { seconds: timeUntilRefresh })}
                </p>
            )}
        </PageCard>
    );
}
