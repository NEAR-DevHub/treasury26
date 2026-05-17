"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowDown, ChevronRight, Loader2, Shield } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { trackEvent } from "@/lib/analytics";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm, useFormContext } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { CopyButton } from "@/components/copy-button";
import { CreateRequestButton } from "@/components/create-request-button";
import { useFormatDate } from "@/components/formatted-date";
import { InfoDisplay } from "@/components/info-display";
import { PageComponentLayout } from "@/components/page-component-layout";
import { PendingButton } from "@/components/pending-button";
import {
    ReviewStep,
    type StepProps,
    StepperHeader,
    StepWizard,
} from "@/components/step-wizard";
import { TokenInput, tokenSchema } from "@/components/token-input";
import { Tooltip } from "@/components/tooltip";
import { Form } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { WarningAlert } from "@/components/warning-alert";
import {
    PAGE_TOUR_NAMES,
    PAGE_TOUR_STORAGE_KEYS,
    usePageTour,
} from "@/features/onboarding/steps/page-tours";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import type { IntentsQuoteResponse } from "@/lib/api";
import { generateIntent } from "@/lib/api";
import { parseTokenQueryParam } from "@/lib/token-query-param";
import {
    formatBalance,
    formatCurrency,
    formatDurationSeconds,
    formatTokenDisplayAmount,
} from "@/lib/utils";
import { buildConfidentialProposal } from "../../../../features/confidential/utils/proposal-builder";
import { useNear } from "@/stores/near-store";
import { useThemeStore } from "@/stores/theme-store";
import { ExchangeSettingsModal } from "./components/exchange-settings-modal";
import { ExchangeSummaryCard } from "./components/exchange-summary-card";
import { Rate } from "./components/rate";
import {
    BTC_TOKEN,
    DRY_QUOTE_REFRESH_INTERVAL,
    ETH_TOKEN,
    PROPOSAL_REFRESH_INTERVAL,
} from "./constants";
import { useCountdownTimer } from "./hooks/use-countdown-timer";
import { useExchangeQuote } from "./hooks/use-exchange-quote";
import { useFormatQuoteAmount } from "./hooks/use-format-quote-amount";
import {
    calculateMarketPriceDifference,
    isNativeNEAR,
    isNEARDeposit,
    isNEARWithdraw,
    isNEARWrapConversion,
} from "./utils";
import { WRAP_NEAR_TOKEN_ID } from "@/constants/network-ids";
import {
    buildFungibleTokenProposal,
    buildNativeNEARProposal,
    buildNEARDepositProposal,
    buildNEARWithdrawProposal,
} from "./utils/proposal-builder";

function buildExchangeFormSchema(messages: { amountGreaterThanZero: string }) {
    return z.object({
        sellAmount: z
            .string()
            .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
                message: messages.amountGreaterThanZero,
            }),
        sellToken: tokenSchema,
        receiveAmount: z.string().optional(),
        receiveToken: tokenSchema,
        slippageTolerance: z.number().optional(),
    });
}

function Step1({ handleNext }: StepProps) {
    const tEx = useTranslations("exchange");
    const form = useFormContext<
        ExchangeFormValues & { slippageTolerance?: number }
    >();
    const { treasuryId: selectedTreasury, isConfidential } = useTreasury();
    const { theme } = useThemeStore();
    const sellToken = form.watch("sellToken");
    const receiveToken = form.watch("receiveToken");
    const sellAmount = form.watch("sellAmount");

    const slippageTolerance = form.watch("slippageTolerance") || 0.5;

    // Check if sell token is wNEAR (FT NEAR with Ft residency, not Intents)
    const isSellTokenFTNEAR =
        sellToken.address === WRAP_NEAR_TOKEN_ID &&
        sellToken.residency === "Ft";

    // Filter function for receive token
    const filterReceiveTokens = useCallback(
        (token: {
            address: string;
            symbol: string;
            network: string;
            residency?: string;
        }) => {
            // Confidential treasury: only show intents tokens
            if (isConfidential) {
                return token.residency === "Intents";
            }
            // Hide native NEAR unless selling FT NEAR (for unwrapping)
            if (token.residency === "Near") {
                return isSellTokenFTNEAR;
            }
            // FT NEAR and Intents NEAR are always visible
            return true;
        },
        [isSellTokenFTNEAR, isConfidential],
    );

    // Reset receive token if it's no longer valid based on filter
    useEffect(() => {
        const isReceiveTokenValid = filterReceiveTokens({
            address: receiveToken.address,
            symbol: receiveToken.symbol,
            network: receiveToken.network,
            residency: receiveToken.residency,
        });

        if (!isReceiveTokenValid) {
            // Reset to a default valid token (ETH or first available)
            form.setValue("receiveToken", ETH_TOKEN);
        }
    }, [isSellTokenFTNEAR, receiveToken, filterReceiveTokens, form]);

    // Check if tokens are the same
    const areSameTokens = useMemo(() => {
        return (
            sellToken.address === receiveToken.address &&
            sellToken.network === receiveToken.network
        );
    }, [
        sellToken.address,
        sellToken.network,
        receiveToken.address,
        receiveToken.network,
    ]);

    const [debouncedSellAmount, setDebouncedSellAmount] = useState(sellAmount);

    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSellAmount(sellAmount);
        }, 500);

        return () => clearTimeout(timer);
    }, [sellAmount]);

    // Clear receive amount and errors when inputs change
    useEffect(() => {
        form.setValue("receiveAmount", "");
        form.clearErrors("sellAmount");
        form.clearErrors("receiveAmount");
    }, [
        sellToken.address,
        receiveToken.address,
        sellAmount,
        slippageTolerance,
        form,
    ]);

    const hasValidAmount =
        debouncedSellAmount &&
        !isNaN(Number(debouncedSellAmount)) &&
        Number(debouncedSellAmount) > 0;

    // Filter function for sell token - confidential treasury only shows intents tokens
    const filterSellTokens = useCallback(
        (token: {
            address: string;
            symbol: string;
            network: string;
            residency?: string;
        }) => {
            if (isConfidential) {
                return token.residency === "Intents";
            }
            return true;
        },
        [isConfidential],
    );

    const { data: quoteData, isLoading: isLoadingQuote } = useExchangeQuote({
        selectedTreasury,
        sellToken,
        receiveToken,
        sellAmount: debouncedSellAmount,
        slippageTolerance,
        form,
        enabled: Boolean(selectedTreasury && hasValidAmount && !areSameTokens),
        isDryRun: true,
        refetchInterval: DRY_QUOTE_REFRESH_INTERVAL,
        isConfidential,
    });

    // Validate tokens when they change
    useEffect(() => {
        form.trigger(["sellToken", "receiveToken"]);
    }, [
        sellToken.address,
        receiveToken.address,
        sellToken.network,
        receiveToken.network,
    ]);

    const formattedReceiveAmount = useFormatQuoteAmount(
        quoteData?.quote
            ? {
                  amountOut: quoteData.quote.amountOut,
                  amountOutFormatted: quoteData.quote.amountOutFormatted,
                  amountOutUsd: quoteData.quote.amountOutUsd,
                  tokenDecimals: receiveToken.decimals,
              }
            : null,
    );

    const handleContinue = () => {
        form.trigger().then((isValid) => {
            if (isValid && handleNext && quoteData) {
                handleNext();
            }
        });
    };

    const handleSwapTokens = () => {
        // Swap sell and receive tokens
        const tempSellToken = { ...sellToken };
        const tempReceiveToken = { ...receiveToken };

        form.setValue("sellToken", tempReceiveToken);
        form.setValue("receiveToken", tempSellToken);

        // Clear amounts
        form.setValue("sellAmount", "");
        form.setValue("receiveAmount", "");
    };

    return (
        <PageCard className="relative">
            <div className="flex items-center justify-between gap-2">
                <StepperHeader
                    title={
                        isConfidential ? (
                            <span className="inline-flex items-center gap-1.5">
                                <span>{tEx("heading")}</span>
                                <Tooltip content={tEx("confidentialTooltip")}>
                                    <span className="inline-flex">
                                        <Shield className="size-4 fill-foreground" />
                                    </span>
                                </Tooltip>
                            </span>
                        ) : (
                            tEx("heading")
                        )
                    }
                />
                <div className="flex items-center gap-2">
                    <PendingButton
                        id="exchange-pending-btn"
                        types={["Exchange"]}
                    />
                    <ExchangeSettingsModal
                        id="exchange-settings-btn"
                        slippageTolerance={slippageTolerance}
                        onSlippageChange={(value) =>
                            form.setValue("slippageTolerance", value)
                        }
                    />
                </div>
            </div>

            {/* Sell Token Input */}
            <div className="relative">
                <TokenInput
                    title={tEx("sell")}
                    control={form.control}
                    amountName="sellAmount"
                    tokenName="sellToken"
                    showInsufficientBalance={true}
                    dynamicFontSize={true}
                    tokenSelect={{
                        filterTokens: filterSellTokens,
                    }}
                    usdValueOverride={
                        quoteData?.quote
                            ? Number(quoteData.quote.amountInUsd) || 0
                            : null
                    }
                />
                {/* Swap Arrow */}
                <div className="flex justify-center absolute bottom-[-25px] left-1/2 -translate-x-1/2">
                    <Button
                        type="button"
                        variant="unstyled"
                        className="rounded-full bg-card border p-1.5! z-10 cursor-pointer"
                        onClick={handleSwapTokens}
                    >
                        {isLoadingQuote ? (
                            <Loader2 className="size-5 animate-spin text-muted-foreground" />
                        ) : (
                            <ArrowDown className="size-5" />
                        )}
                    </Button>
                </div>
            </div>

            {/* Receive Token Input (Read-only) */}
            <TokenInput
                title={tEx("receive")}
                control={form.control}
                amountName="receiveAmount"
                tokenName="receiveToken"
                readOnly={true}
                loading={isLoadingQuote}
                customValue={formattedReceiveAmount}
                dynamicFontSize={true}
                tokenSelect={{
                    filterTokens: filterReceiveTokens,
                }}
                usdValueOverride={
                    quoteData?.quote
                        ? Number(quoteData.quote.amountOutUsd) || 0
                        : null
                }
            />

            {/* Rate and Slippage */}
            {quoteData && quoteData.quote && (
                <div className="flex flex-col gap-2 text-sm">
                    <Rate
                        quote={quoteData.quote}
                        sellToken={sellToken}
                        receiveToken={receiveToken}
                    />
                    <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">
                            {tEx("slippageTolerance")}
                        </span>
                        <span className="font-medium">
                            {slippageTolerance}%
                        </span>
                    </div>
                </div>
            )}

            <div className="rounded-lg border bg-card p-0 overflow-hidden">
                <CreateRequestButton
                    onClick={handleContinue}
                    className="w-full h-10 rounded-none"
                    permissions={[{ kind: "call", action: "AddProposal" }]}
                    disabled={areSameTokens || !hasValidAmount || !quoteData}
                    idleMessage={
                        areSameTokens
                            ? tEx("disabled.differentTokens")
                            : !hasValidAmount
                              ? tEx("disabled.enterAmount")
                              : tEx("review")
                    }
                />
            </div>

            <div className="flex justify-center items-center gap-2 text-sm text-muted-foreground">
                <span>{tEx("poweredBy")}</span>
                <span className="font-semibold flex items-center gap-1">
                    <img
                        src={
                            theme === "dark"
                                ? "/near-intents-dark.svg"
                                : "/near-intents-light.svg"
                        }
                        alt="NEAR Intents"
                        className="h-3"
                    />
                </span>
            </div>
        </PageCard>
    );
}

function Step2({ handleBack }: StepProps) {
    const tEx = useTranslations("exchange");
    const locale = useLocale();
    const form = useFormContext<ExchangeFormValues>();
    const { treasuryId: selectedTreasury, isConfidential } = useTreasury();
    const sellToken = form.watch("sellToken");
    const receiveToken = form.watch("receiveToken");
    const sellAmount = form.watch("sellAmount");
    const slippageTolerance = form.watch("slippageTolerance") || 0.5;
    const formatDate = useFormatDate();

    const {
        data: localLiveQuoteData,
        isLoading: isLoadingLiveQuote,
        isFetching: isFetchingLiveQuote,
    } = useExchangeQuote({
        selectedTreasury,
        sellToken,
        receiveToken,
        sellAmount,
        slippageTolerance,
        form,
        enabled: Boolean(selectedTreasury && sellAmount),
        isDryRun: false,
        refetchInterval: PROPOSAL_REFRESH_INTERVAL,
        isConfidential,
    });

    const timeUntilRefresh = useCountdownTimer(
        !!localLiveQuoteData && !isFetchingLiveQuote,
        PROPOSAL_REFRESH_INTERVAL,
        localLiveQuoteData?.quote.depositAddress,
    );

    const formattedReceiveAmount = useFormatQuoteAmount(
        localLiveQuoteData?.quote
            ? {
                  amountOut: localLiveQuoteData.quote.amountOut,
                  amountOutFormatted:
                      localLiveQuoteData.quote.amountOutFormatted,
                  amountOutUsd: localLiveQuoteData.quote.amountOutUsd,
                  tokenDecimals: receiveToken.decimals,
              }
            : null,
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
                        {/* Summary Cards Skeleton */}
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

                        {/* Details Skeleton */}
                        <div className="flex flex-col gap-2">
                            <Skeleton className="h-6 w-full" />
                            <Skeleton className="h-6 w-full" />
                            <Skeleton className="h-6 w-full" />
                        </div>
                    </>
                ) : localLiveQuoteData ? (
                    // Actual content when loaded
                    <>
                        {/* Exchange Summary Cards */}
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

                            {/* Arrow - absolutely positioned */}
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

                        {/* Exchange Details */}
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
                                                          {formatCurrency(
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
                                        value: formatDurationSeconds(
                                            localLiveQuoteData.quote
                                                .timeEstimate,
                                            locale,
                                        ),
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
                                                      // Calculate fee: amountIn * 0.35% = amountIn * 0.0035
                                                      const feePercentage = 0.7;
                                                      const amountIn =
                                                          Number(
                                                              localLiveQuoteData
                                                                  .quote
                                                                  .amountInFormatted,
                                                          ) || 0;
                                                      const feeAmount =
                                                          amountIn *
                                                          (feePercentage / 100);

                                                      return `${feePercentage}% / ${formatTokenDisplayAmount(
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

                {/* Warning Alert */}
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
                    disabled={isLoadingLiveQuote}
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

type ExchangeFormValues = z.infer<ReturnType<typeof buildExchangeFormSchema>>;

export default function ExchangePage() {
    const t = useTranslations("pages.exchange");
    const tEx = useTranslations("exchange");
    const tValidation = useTranslations("paymentForm.validation");
    const exchangeFormSchema = useMemo(
        () =>
            buildExchangeFormSchema({
                amountGreaterThanZero: tValidation("amountGreaterThanZero"),
            }),
        [tValidation],
    );
    const { treasuryId: selectedTreasury, isConfidential } = useTreasury();
    const pageTitle = isConfidential ? t("confidentialTitle") : t("title");
    const { createProposal } = useNear();
    const { data: policy } = useTreasuryPolicy(selectedTreasury);
    const [step, setStep] = useState(0);
    const searchParams = useSearchParams();

    // Parse sellToken from query params
    const defaultSellToken = useMemo(() => {
        const sellTokenParam = searchParams.get("sellToken");
        return parseTokenQueryParam(sellTokenParam, BTC_TOKEN);
    }, [searchParams]);

    // Onboarding tour
    usePageTour(
        PAGE_TOUR_NAMES.EXCHANGE_SETTINGS,
        PAGE_TOUR_STORAGE_KEYS.EXCHANGE_SETTINGS_SHOWN,
    );

    const form = useForm<ExchangeFormValues>({
        resolver: zodResolver(exchangeFormSchema),
        defaultValues: {
            sellAmount: "",
            sellToken: defaultSellToken,
            receiveAmount: "0",
            receiveToken: ETH_TOKEN,
            slippageTolerance: 0.5,
        },
    });

    // Update sellToken when query param changes
    useEffect(() => {
        form.setValue("sellToken", defaultSellToken);
    }, [defaultSellToken, form]);

    const onSubmit = async (data: ExchangeFormValues) => {
        const proposalDataFromForm = form.getValues(
            "proposalData" as any,
        ) as IntentsQuoteResponse | null;

        if (!proposalDataFromForm || !selectedTreasury) {
            console.error("Missing proposal data or treasury");
            return;
        }

        try {
            const proposalBond = policy?.proposal_bond || "0";

            if (isConfidential) {
                // Confidential path: generate intent + build v1.signer proposal
                const { correlationId: _, ...quoteMetadata } =
                    proposalDataFromForm as unknown as Record<string, unknown>;
                const intentResponse = await generateIntent({
                    type: "swap_transfer",
                    standard: "nep413",
                    signerId: selectedTreasury,
                    quoteMetadata,
                });

                const confidentialResult = buildConfidentialProposal({
                    intentResponse,
                    treasuryId: selectedTreasury,
                });

                await createProposal(tEx("requestSubmitted"), {
                    treasuryId: selectedTreasury,
                    proposal: confidentialResult.proposal,
                    proposalBond,
                    proposalType: "swap",
                });
            } else {
                const sellingNativeNEAR = isNativeNEAR(
                    data.sellToken.address,
                    data.sellToken.residency,
                );

                const proposalParams = {
                    proposalData: proposalDataFromForm,
                    sellToken: data.sellToken,
                    receiveToken: data.receiveToken,
                    slippageTolerance: data.slippageTolerance || 0.5,
                    treasuryId: selectedTreasury,
                    proposalBond,
                };

                let result;

                // Detect NEAR deposit: native NEAR -> FT NEAR (wrap.near)
                if (isNEARDeposit(data.sellToken, data.receiveToken)) {
                    result = await buildNEARDepositProposal(proposalParams);
                }
                // Detect NEAR withdraw: FT NEAR (wrap.near) -> native NEAR
                else if (isNEARWithdraw(data.sellToken, data.receiveToken)) {
                    result = buildNEARWithdrawProposal(proposalParams);
                }
                // Regular exchange: native NEAR to other tokens
                else if (sellingNativeNEAR) {
                    result = await buildNativeNEARProposal(proposalParams);
                }
                // Regular exchange: FT tokens or intents tokens
                else {
                    result = await buildFungibleTokenProposal(proposalParams);
                }

                await createProposal(tEx("requestSubmitted"), {
                    treasuryId: selectedTreasury,
                    proposal: result.proposal,
                    proposalBond,
                    additionalTransactions: result.additionalTransactions,
                    proposalType: "swap",
                });
            }

            trackEvent("exchange-submitted", {
                treasury_id: selectedTreasury,
                sell_token_symbol: data.sellToken.symbol,
                receive_token_symbol: data.receiveToken.symbol,
            });

            form.reset();
            setStep(0);
        } catch (error: any) {
            console.error("Exchange error", error);
        }
    };

    return (
        <PageComponentLayout title={pageTitle} description={t("description")}>
            <Form {...form}>
                <form
                    onSubmit={(e) => {
                        // Only allow submission from Step 2 (Review step)
                        if (step !== 1) {
                            e.preventDefault();
                            return;
                        }
                        form.handleSubmit(onSubmit)(e);
                    }}
                    className="flex flex-col gap-4 max-w-[600px] mx-auto"
                >
                    <StepWizard
                        step={step}
                        onStepChange={setStep}
                        steps={[
                            {
                                component: Step1,
                            },
                            {
                                component: Step2,
                            },
                        ]}
                    />
                </form>
            </Form>
        </PageComponentLayout>
    );
}
