"use client";

import { ArrowDown, Loader2, Shield } from "lucide-react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { useCallback, useEffect } from "react";
import { useFormContext } from "react-hook-form";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { CreateRequestButton } from "@/components/create-request-button";
import { PendingButton } from "@/components/pending-button";
import { type StepProps, StepperHeader } from "@/components/step-wizard";
import { TokenInput } from "@/components/token-input";
import { Tooltip } from "@/components/tooltip";
import { SlotWarning } from "@/components/warning-message";
import { WRAP_NEAR_TOKEN_ID } from "@/constants/network-ids";
import type { BridgeAsset } from "@/hooks/use-bridge-tokens";
import { useTreasury } from "@/hooks/use-treasury";
import { useBridgeScopedWarning } from "@/hooks/use-warnings";
import { ETH_TOKEN, DRY_QUOTE_REFRESH_INTERVAL } from "../constants";
import type { ExchangeFormValues } from "../exchange-form";
import { useExchangeAmountQuote } from "../hooks/use-exchange-amount-quote";
import { ExchangeSettingsModal } from "./exchange-settings-modal";
import { Rate } from "./rate";

export function Step1({
    handleNext,
    bridgeAssets,
}: StepProps & { bridgeAssets: BridgeAsset[] }) {
    const tEx = useTranslations("exchange");
    const tCreate = useTranslations("createRequestButton");
    const form = useFormContext<ExchangeFormValues>();
    const { treasuryId: selectedTreasury, isConfidential } = useTreasury();
    const { resolvedTheme } = useTheme();

    const { blocked: exchangeSlotBlocked, scopedMessage: sendWarningMessage } =
        useBridgeScopedWarning(
            "exchange",
            bridgeAssets,
            form.watch("sellToken")?.address,
        );
    const { scopedMessage: receiveWarningMessage } = useBridgeScopedWarning(
        "exchange",
        bridgeAssets,
        form.watch("receiveToken")?.address,
    );

    const {
        sellToken,
        receiveToken,
        slippageTolerance,
        areSameTokens,
        hasValidAmount,
        quoteData,
        quoteError,
        isQuoteBusy,
        formattedDerivedAmount,
        isSellDerived,
        isReceiveDerived,
        onSellAmountInput,
        onReceiveAmountInput,
        onQuoteInputsChanged,
    } = useExchangeAmountQuote({
        form,
        selectedTreasury,
        isConfidential,
        exchangeSlotBlocked,
        isDryRun: true,
        refetchInterval: DRY_QUOTE_REFRESH_INTERVAL,
    });

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
            onQuoteInputsChanged();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- form.setValue is stable
    }, [
        isSellTokenFTNEAR,
        receiveToken.address,
        receiveToken.symbol,
        receiveToken.network,
        receiveToken.residency,
        filterReceiveTokens,
        onQuoteInputsChanged,
    ]);

    // Validate tokens when they change
    useEffect(() => {
        form.trigger(["sellToken", "receiveToken"]);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- form.trigger is stable
    }, [
        sellToken.address,
        receiveToken.address,
        sellToken.network,
        receiveToken.network,
    ]);

    const handleContinue = () => {
        form.trigger().then((isValid) => {
            if (isValid && handleNext && quoteData && !quoteError) {
                handleNext();
            }
        });
    };

    const handleSwapTokens = () => {
        // Swap sell and receive tokens
        const tempSellToken = { ...sellToken };
        const tempReceiveToken = { ...receiveToken };
        const sellAmount = form.getValues("sellAmount") || "";
        const receiveAmount = form.getValues("receiveAmount") || "";
        // Prefer former receive as the new sell input; fall back to sell if empty.
        const nextSellAmount = receiveAmount || sellAmount;

        form.setValue("sellToken", tempReceiveToken);
        form.setValue("receiveToken", tempSellToken);
        form.setValue("sellAmount", nextSellAmount);
        // Clear receive — it will be re-quoted as exact-input.
        form.setValue("receiveAmount", "");
        form.setValue("amountMode", "EXACT_INPUT");
    };

    const isDarkTheme = resolvedTheme === "dark";

    return (
        <>
            <SlotWarning slot="exchange" />
            <PageCard className="relative">
                <div className="flex items-center justify-between gap-2">
                    <StepperHeader
                        title={
                            isConfidential ? (
                                <span className="inline-flex items-center gap-1.5">
                                    <span>{tEx("heading")}</span>
                                    <Tooltip
                                        content={tEx("confidentialTooltip")}
                                    >
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
                            onSlippageChange={(value) => {
                                form.setValue("slippageTolerance", value);
                                onQuoteInputsChanged();
                            }}
                        />
                    </div>
                </div>

                <div className="relative">
                    <TokenInput
                        title={tEx("sell")}
                        control={form.control}
                        amountName="sellAmount"
                        tokenName="sellToken"
                        showInsufficientBalance={true}
                        dynamicFontSize={true}
                        readOnly={isSellDerived && isQuoteBusy}
                        loading={isSellDerived && isQuoteBusy}
                        customValue={
                            isSellDerived && isQuoteBusy
                                ? formattedDerivedAmount
                                : undefined
                        }
                        tokenSelect={{
                            filterTokens: filterSellTokens,
                        }}
                        usdValueOverride={
                            quoteData?.quote
                                ? Number(quoteData.quote.amountInUsd) || 0
                                : null
                        }
                        errorMessage={!isSellDerived ? quoteError : null}
                        warningMessage={sendWarningMessage}
                        onAmountInput={onSellAmountInput}
                        onMaxSet={onSellAmountInput}
                        onTokenChange={onQuoteInputsChanged}
                    />
                    <div className="flex justify-center absolute bottom-[-25px] left-1/2 -translate-x-1/2">
                        <Button
                            type="button"
                            variant="unstyled"
                            className="rounded-full bg-card border p-1.5! z-10 cursor-pointer"
                            onClick={handleSwapTokens}
                            disabled={isQuoteBusy}
                        >
                            {isQuoteBusy ? (
                                <Loader2 className="size-5 animate-spin text-muted-foreground" />
                            ) : (
                                <ArrowDown className="size-5" />
                            )}
                        </Button>
                    </div>
                </div>

                <TokenInput
                    title={tEx("receive")}
                    control={form.control}
                    amountName="receiveAmount"
                    tokenName="receiveToken"
                    readOnly={isReceiveDerived && isQuoteBusy}
                    loading={isReceiveDerived && isQuoteBusy}
                    customValue={
                        isReceiveDerived && isQuoteBusy
                            ? formattedDerivedAmount
                            : undefined
                    }
                    dynamicFontSize={true}
                    tokenSelect={{
                        filterTokens: filterReceiveTokens,
                        showPopularAssets: true,
                    }}
                    usdValueOverride={
                        quoteData?.quote
                            ? Number(quoteData.quote.amountOutUsd) || 0
                            : null
                    }
                    errorMessage={!isReceiveDerived ? quoteError : null}
                    warningMessage={receiveWarningMessage}
                    onAmountInput={onReceiveAmountInput}
                    onTokenChange={onQuoteInputsChanged}
                />

                {quoteData?.quote && (
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
                        disabled={
                            areSameTokens ||
                            !hasValidAmount ||
                            !quoteData ||
                            !!quoteError ||
                            exchangeSlotBlocked
                        }
                        idleMessage={
                            exchangeSlotBlocked
                                ? tCreate("brieflyUnavailable")
                                : areSameTokens
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
                                isDarkTheme
                                    ? "/near-intents-dark.svg"
                                    : "/near-intents-light.svg"
                            }
                            alt="NEAR Intents"
                            className="h-3"
                        />
                    </span>
                </div>
            </PageCard>
        </>
    );
}
