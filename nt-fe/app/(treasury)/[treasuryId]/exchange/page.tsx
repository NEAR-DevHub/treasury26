"use client";

import { PageCard } from "@/components/card";
import { TokenInput, tokenSchema } from "@/components/token-input";
import { PageComponentLayout } from "@/components/page-component-layout";
import { useForm, useFormContext } from "react-hook-form";
import { Form } from "@/components/ui/form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ReviewStep,
  StepperHeader,
  StepProps,
  StepWizard,
} from "@/components/step-wizard";
import {
  useToken,
  useTreasuryPolicy,
  useTokenBalance,
} from "@/hooks/use-treasury-queries";
import { useEffect, useMemo, useState } from "react";
import { useTreasury } from "@/stores/treasury-store";
import { useNear } from "@/stores/near-store";
import { cn, formatBalance } from "@/lib/utils";
import Big from "big.js";
import { NEAR_TOKEN } from "@/constants/token";
import { CreateRequestButton } from "@/components/create-request-button";
import { ArrowDown, ArrowRight, Loader2 } from "lucide-react";
import { ExchangeSettingsModal } from "./components/exchange-settings-modal";
import { Button } from "@/components/button";
import { IntentsQuoteResponse } from "@/lib/api";
import { PendingButton } from "@/components/pending-button";
import { CopyButton } from "@/components/copy-button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DRY_QUOTE_REFRESH_INTERVAL,
  PROPOSAL_REFRESH_INTERVAL,
} from "./constants";
import { WarningAlert } from "@/components/warning-alert";
import { useFormatDate } from "@/components/formatted-date";
import {
  calculateMarketPriceDifference,
  getUserFriendlyErrorMessage,
} from "./utils";
import { useCountdownTimer } from "./hooks/use-countdown-timer";
import { useAutoRefresh } from "./hooks/use-auto-refresh";
import { useQuoteFetcher } from "./hooks/use-quote-fetcher";
import { ExchangeSummaryCard } from "./components/exchange-summary-card";
import { ExchangeDetailRow } from "./components/exchange-detail-row";
import { ExchangeRateDisplay } from "./components/exchange-rate-display";
import {
  buildNativeNEARProposal,
  buildFungibleTokenProposal,
} from "./utils/proposal-builder";

const exchangeFormSchema = z
  .object({
    sellAmount: z
      .string()
      .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
        message: "Amount must be greater than 0",
      }),
    sellToken: tokenSchema,
    receiveAmount: z.string().optional(),
    receiveToken: tokenSchema,
    slippageTolerance: z.number().optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.sellToken.address === data.receiveToken.address &&
      data.sellToken.network === data.receiveToken.network
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["receiveAmount"],
        message: "Sell and receive tokens must be different",
      });
    }
  });

function Step1({ handleNext }: StepProps) {
  const form = useFormContext<
    ExchangeFormValues & { slippageTolerance?: number }
  >();
  const { selectedTreasury } = useTreasury();
  const sellToken = form.watch("sellToken");
  const receiveToken = form.watch("receiveToken");
  const sellAmount = form.watch("sellAmount");
  const { data: sellTokenBalance } = useTokenBalance(
    selectedTreasury,
    sellToken.address,
    sellToken.network
  );

  const slippageTolerance = form.watch("slippageTolerance") || 0.5;

  const [quoteData, setQuoteData] = useState<IntentsQuoteResponse | null>(null);

  const { fetchQuote, isLoading: isLoadingQuote } = useQuoteFetcher();

  const hasValidAmount =
    sellAmount && !isNaN(Number(sellAmount)) && Number(sellAmount) > 0;

  // Check for insufficient balance
  const hasInsufficientBalance = useMemo(() => {
    if (!sellAmount || !sellTokenBalance?.balance) return false;
    const amountNum = Number(sellAmount);
    const balanceNum = Number(
      formatBalance(sellTokenBalance.balance, sellTokenBalance.decimals)
    );
    return !isNaN(amountNum) && !isNaN(balanceNum) && amountNum > balanceNum;
  }, [sellAmount, sellTokenBalance]);

  // Fetch dry quote
  const fetchDryQuote = async () => {
    if (!hasValidAmount || !selectedTreasury) return;

    // Don't fetch quote if tokens are the same - let Zod validation handle the error
    if (
      sellToken.address === receiveToken.address &&
      sellToken.network === receiveToken.network
    ) {
      setQuoteData(null);
      form.setValue("receiveAmount", "");
      // Trigger validation to show the error
      form.trigger("receiveAmount");
      return;
    }

    form.clearErrors("receiveAmount");

    const result = await fetchQuote(
      {
        sellToken,
        receiveToken,
        sellAmount,
        slippageTolerance,
        treasuryId: selectedTreasury,
      },
      true
    );

    if (result.quote) {
      setQuoteData(result.quote);
      form.setValue("receiveAmount", result.quote.quote.amountOutFormatted);
    } else {
      const userMessage = result.error
        ? getUserFriendlyErrorMessage(result.error)
        : "Unable to fetch quote. Please try again.";

      form.setError("receiveAmount", {
        type: "manual",
        message: userMessage,
      });
    }
  };

  // Fetch quote when amount/tokens change
  useEffect(() => {
    // Clear any existing errors and receive amount immediately when inputs change
    form.clearErrors("sellAmount");
    form.clearErrors("receiveAmount");
    form.setValue("receiveAmount", "");
    setQuoteData(null);

    const timer = setTimeout(() => {
      fetchDryQuote();
    }, 500); // Debounce

    return () => clearTimeout(timer);
  }, [sellAmount, sellToken.address, receiveToken.address, slippageTolerance]);

  // Validate tokens when they change
  useEffect(() => {
    form.trigger(["sellToken", "receiveToken"]);
  }, [
    sellToken.address,
    receiveToken.address,
    sellToken.network,
    receiveToken.network,
  ]);

  // Auto-refresh quote every 5 seconds
  useAutoRefresh(
    fetchDryQuote,
    Boolean(quoteData && hasValidAmount),
    DRY_QUOTE_REFRESH_INTERVAL,
    [quoteData, hasValidAmount]
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

    // Clear amounts and quote data
    form.setValue("sellAmount", "");
    form.setValue("receiveAmount", "");
    setQuoteData(null);
  };

  return (
    <PageCard className="relative">
      {/* Pending Badge and Settings - Top Right */}
      <div className="flex items-center justify-between gap-2">
        <StepperHeader title="Exchange" />
        <div className="flex items-center gap-2">
          <PendingButton types={["Exchange"]} />
          <ExchangeSettingsModal
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
          title="Sell"
          control={form.control}
          amountName="sellAmount"
          tokenName="sellToken"
        />
        {/* Swap Arrow */}
        <div className="flex justify-center absolute bottom-[-25px] left-1/2 -translate-x-1/2">
          <div
            className="rounded-full bg-card border p-1.5 z-10 cursor-pointer"
            onClick={handleSwapTokens}
          >
            {isLoadingQuote ? (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            ) : (
              <ArrowDown className="size-5" />
            )}
          </div>
        </div>
      </div>

      {/* Receive Token Input (Read-only) */}
      <TokenInput
        title="You receive"
        control={form.control}
        amountName="receiveAmount"
        tokenName="receiveToken"
        readOnly={true}
        loading={isLoadingQuote}
        customValue={quoteData?.quote.amountOutFormatted || ""}
      />

      {/* Rate and Slippage */}
      {quoteData && (
        <div className="flex flex-col gap-2 text-sm">
          <ExchangeRateDisplay
            quote={quoteData.quote}
            sellToken={sellToken}
            receiveToken={receiveToken}
          />
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">Slippage Tolerance</span>
            <span className="font-medium">{slippageTolerance}%</span>
          </div>
        </div>
      )}

      {/* Insufficient Balance Warning */}
      {hasInsufficientBalance && (
        <WarningAlert message="The treasury balance is insufficient to cover the exchange. You can create the request, but it won't be approved until the balance is topped up." />
      )}

      {/* Exchange Button */}
      <div className="rounded-lg border bg-card p-0 overflow-hidden">
        <Button
          type="button"
          onClick={handleContinue}
          variant="default"
          className={cn(
            "w-full h-10 rounded-none font-medium",
            (!hasValidAmount || !quoteData) &&
              "bg-muted text-muted-foreground hover:bg-muted"
          )}
        >
          {hasValidAmount && quoteData
            ? "Review Exchange"
            : "Enter an amount to exchange"}
        </Button>
      </div>

      {/* Powered by NEAR Intents */}
      <div className="flex justify-center items-center gap-2 text-sm text-muted-foreground">
        <span>Powered by</span>
        <span className="font-semibold flex items-center gap-1">
          <img
            src="https://near-intents.org/static/templates/near-intents/logo.svg"
            alt="NEAR Intents"
            className="h-5"
          />
        </span>
      </div>
    </PageCard>
  );
}

function Step2({ handleBack }: StepProps) {
  const form = useFormContext<ExchangeFormValues>();
  const { selectedTreasury } = useTreasury();
  const sellToken = form.watch("sellToken");
  const receiveToken = form.watch("receiveToken");
  const sellAmount = form.watch("sellAmount");
  const receiveAmount = form.watch("receiveAmount") || "0";
  const slippageTolerance = form.watch("slippageTolerance") || 0.5;
  const { data: sellTokenData } = useToken(sellToken.address);
  const { data: receiveTokenData } = useToken(receiveToken.address);
  const formatDate = useFormatDate();

  const [localLiveQuoteData, setLocalLiveQuoteData] =
    useState<IntentsQuoteResponse | null>(null);

  const { fetchQuote, isLoading: isLoadingLiveQuote } = useQuoteFetcher();

  const timeUntilRefresh = useCountdownTimer(
    !!localLiveQuoteData,
    PROPOSAL_REFRESH_INTERVAL
  );

  // Fetch live quote
  const fetchLiveQuote = async () => {
    if (!selectedTreasury) return;

    const result = await fetchQuote(
      {
        sellToken,
        receiveToken,
        sellAmount,
        slippageTolerance,
        treasuryId: selectedTreasury,
      },
      false
    );

    if (result.quote) {
      setLocalLiveQuoteData(result.quote);
      // Store in form context for submission
      form.setValue("proposalData" as any, result.quote);
    }
  };

  // Fetch on mount and when slippage changes
  useEffect(() => {
    fetchLiveQuote();
  }, [slippageTolerance]);

  // Auto-refresh every 30 seconds
  useAutoRefresh(
    fetchLiveQuote,
    !!localLiveQuoteData,
    PROPOSAL_REFRESH_INTERVAL,
    [localLiveQuoteData]
  );

  const sellTotal = useMemo(() => {
    if (!localLiveQuoteData) return 0;
    return Number(localLiveQuoteData.quote.amountInFormatted) || 0;
  }, [localLiveQuoteData]);

  const receiveTotal = useMemo(() => {
    if (!localLiveQuoteData) return 0;
    return Number(localLiveQuoteData.quote.amountOutFormatted) || 0;
  }, [localLiveQuoteData]);

  const estimatedSellUSDValue = sellTokenData?.price
    ? sellTotal * sellTokenData.price
    : 0;
  const estimatedReceiveUSDValue = receiveTokenData?.price
    ? receiveTotal * receiveTokenData.price
    : 0;

  const marketPriceDifference = localLiveQuoteData
    ? calculateMarketPriceDifference(
        localLiveQuoteData.quote.amountInUsd,
        localLiveQuoteData.quote.amountOutUsd,
        localLiveQuoteData.quote.amountIn,
        localLiveQuoteData.quote.amountOut,
        sellToken.decimals,
        receiveToken.decimals,
        sellTokenData?.price,
        receiveTokenData?.price
      )
    : null;

  return (
    <PageCard>
      <ReviewStep reviewingTitle="Review Exchange" handleBack={handleBack}>
        {isLoadingLiveQuote ? (
          // Loading skeleton for entire review section
          <>
            {/* Summary Cards Skeleton */}
            <div className="flex gap-5">
              <div className="flex-1 rounded-lg border bg-muted p-4 flex flex-col items-center gap-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="size-10 rounded-full" />
                <Skeleton className="h-6 w-32" />
                <Skeleton className="h-3 w-20" />
              </div>

              <div className="flex items-center">
                <ArrowRight className="size-6 text-muted-foreground" />
              </div>

              <div className="flex-1 rounded-lg border bg-muted p-4 flex flex-col items-center gap-2">
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
            <div className="flex gap-5">
              <ExchangeSummaryCard
                title="Sell amount"
                token={sellToken}
                amount={localLiveQuoteData.quote.amountInFormatted}
                usdValue={estimatedSellUSDValue}
              />

              {/* Arrow */}
              <div className="flex items-center">
                <ArrowRight className="size-6 text-muted-foreground" />
              </div>

              <ExchangeSummaryCard
                title="Receive"
                token={receiveToken}
                amount={localLiveQuoteData.quote.amountOutFormatted}
                usdValue={estimatedReceiveUSDValue}
              />
            </div>

            {/* Exchange Details */}
            <div className="flex flex-col gap-2 text-sm">
              <ExchangeRateDisplay
                quote={localLiveQuoteData.quote}
                sellToken={sellToken}
                receiveToken={receiveToken}
                detailed
              />

              {marketPriceDifference && marketPriceDifference.hasMarketData && (
                <ExchangeDetailRow
                  label="Price Difference"
                  value={
                    <span className="font-medium">
                      {marketPriceDifference.isFavorable ? "+" : ""}
                      {marketPriceDifference.percentDifference}%
                    </span>
                  }
                  tooltip="Difference between the quote rate and the current market rate. Positive values indicate a better rate than market."
                />
              )}

              <ExchangeDetailRow
                label="Estimated Time"
                value={`${localLiveQuoteData.quote.timeEstimate} seconds`}
                tooltip="Approximate time to complete the exchange."
              />

              <ExchangeDetailRow
                label="Minimum Received"
                value={`${formatBalance(
                  localLiveQuoteData.quote.minAmountOut,
                  receiveToken.decimals
                )} ${receiveToken.symbol}`}
                tooltip="This is the minimum amount you'll receive from this exchange, based on the slippage limit set for the request."
              />

              <ExchangeDetailRow
                label="Deposit Address"
                value={
                  <div className="flex items-center gap-2">
                    {`${localLiveQuoteData.quote.depositAddress.slice(
                      0,
                      8
                    )}....${localLiveQuoteData.quote.depositAddress.slice(-6)}`}
                    <CopyButton
                      text={localLiveQuoteData.quote.depositAddress}
                      toastMessage="Deposit address copied"
                      variant="unstyled"
                      size="icon"
                      className="h-6 w-6 p-0!"
                      iconClassName="h-3 w-3"
                    />
                  </div>
                }
              />

              <ExchangeDetailRow
                label="Quote Expires"
                value={
                  <span className="text-destructive">
                    {formatDate(localLiveQuoteData.quoteRequest.deadline, {
                      includeTime: true,
                      includeTimezone: true,
                    })}
                  </span>
                }
              />
            </div>
          </>
        ) : null}

        {/* Warning Alert */}
        <WarningAlert message="Please approve this request within 24 hours - otherwise, it will be expired. We recommend confirming as soon as possible." />

        <></>
      </ReviewStep>

      <div className="rounded-lg border bg-card p-0 overflow-hidden">
        <CreateRequestButton
          isSubmitting={form.formState.isSubmitting}
          type="submit"
          className="w-full h-10 rounded-none"
          permissions={[{ kind: "call", action: "AddProposal" }]}
          idleMessage="Confirm and Submit Request"
          disabled={isLoadingLiveQuote}
        />
      </div>

      {localLiveQuoteData && (
        <p className="text-center text-sm text-muted-foreground">
          Exchange rate will refresh in{" "}
          <span className="font-medium text-foreground">
            {timeUntilRefresh}s
          </span>
        </p>
      )}
    </PageCard>
  );
}

type ExchangeFormValues = z.infer<typeof exchangeFormSchema>;

export default function ExchangePage() {
  const { selectedTreasury } = useTreasury();
  const { createProposal } = useNear();
  const { data: policy } = useTreasuryPolicy(selectedTreasury);
  const [step, setStep] = useState(0);

  const form = useForm<ExchangeFormValues>({
    resolver: zodResolver(exchangeFormSchema),
    defaultValues: {
      sellAmount: "",
      sellToken: NEAR_TOKEN,
      receiveAmount: "0",
      receiveToken: {
        symbol: "USDC",
        address: "usdc.near",
        network: "near",
        icon: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png",
        decimals: 6,
      },
      slippageTolerance: 0.5,
    },
  });

  const onSubmit = async (data: ExchangeFormValues) => {
    const proposalDataFromForm = form.getValues(
      "proposalData" as any
    ) as IntentsQuoteResponse | null;

    if (!proposalDataFromForm || !selectedTreasury) {
      console.error("Missing proposal data or treasury");
      return;
    }

    try {
      const proposalBond = policy?.proposal_bond || "0";
      const isSellingNativeNEAR = data.sellToken.address === "near";

      const proposalParams = {
        proposalData: proposalDataFromForm,
        sellToken: data.sellToken,
        receiveToken: data.receiveToken,
        slippageTolerance: data.slippageTolerance || 0.5,
        treasuryId: selectedTreasury,
        proposalBond,
      };

      let result;

      if (isSellingNativeNEAR) {
        const proposal = buildNativeNEARProposal(proposalParams);
        result = await createProposal("Exchange request submitted", {
          treasuryId: selectedTreasury,
          proposal,
          proposalBond,
        });
      } else {
        const proposal = buildFungibleTokenProposal(proposalParams);
        result = await createProposal("Exchange request submitted", {
          treasuryId: selectedTreasury,
          proposal,
          proposalBond,
        });
      }

      // Reset after proposal is submitted
      if (result && result.length > 0) {
        form.reset();
        setStep(0);
      }
    } catch (error: any) {
      console.error("Exchange error", error);

      const errorMessage =
        error?.message || "Failed to submit exchange request";

      if (errorMessage.toLowerCase().includes("user rejected")) {
        console.log("User rejected the transaction");
      } else if (errorMessage.toLowerCase().includes("insufficient")) {
        console.error("Insufficient balance or funds");
      } else {
        console.error("Unexpected error:", errorMessage);
      }
    }
  };

  return (
    <PageComponentLayout
      title="Exchange"
      description="Exchange your tokens securely and efficiently"
    >
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
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
