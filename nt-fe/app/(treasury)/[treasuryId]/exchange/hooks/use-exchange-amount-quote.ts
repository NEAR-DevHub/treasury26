"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useDebounce } from "use-debounce";
import type { UseFormReturn } from "react-hook-form";
import type { ExchangeFormValues } from "../exchange-form";
import { type ExchangeSwapType, useExchangeQuote } from "./use-exchange-quote";
import { useFormatQuoteAmount } from "./use-format-quote-amount";

interface UseExchangeAmountQuoteParams {
    form: UseFormReturn<ExchangeFormValues>;
    selectedTreasury: string | null | undefined;
    isConfidential?: boolean;
    exchangeSlotBlocked?: boolean;
    isDryRun: boolean;
    refetchInterval: number;
}

/**
 * Orchestrates bidirectional exchange amounts: debounce, quote fetch, derived
 * amount application, and busy/locking state for the non-driving field.
 */
export function useExchangeAmountQuote({
    form,
    selectedTreasury,
    isConfidential,
    exchangeSlotBlocked = false,
    isDryRun,
    refetchInterval,
}: UseExchangeAmountQuoteParams) {
    const sellToken = form.watch("sellToken");
    const receiveToken = form.watch("receiveToken");
    const sellAmount = form.watch("sellAmount");
    const receiveAmount = form.watch("receiveAmount");
    const amountMode = form.watch("amountMode");
    const slippageTolerance = form.watch("slippageTolerance") || 0.5;

    const sourceAmount =
        amountMode === "EXACT_INPUT" ? sellAmount : receiveAmount;
    const [debouncedSourceAmount] = useDebounce(sourceAmount || "", 500);

    const areSameTokens = useMemo(
        () =>
            sellToken.address === receiveToken.address &&
            sellToken.network === receiveToken.network,
        [
            sellToken.address,
            sellToken.network,
            receiveToken.address,
            receiveToken.network,
        ],
    );

    const hasValidAmount =
        !!debouncedSourceAmount &&
        !isNaN(Number(debouncedSourceAmount)) &&
        Number(debouncedSourceAmount) > 0;

    const {
        data: quoteData,
        isLoading: isLoadingQuote,
        isFetching: isFetchingQuote,
        quoteError,
    } = useExchangeQuote({
        selectedTreasury,
        sellToken,
        receiveToken,
        amount: debouncedSourceAmount,
        swapType: amountMode,
        slippageTolerance,
        enabled: Boolean(
            selectedTreasury &&
                hasValidAmount &&
                !areSameTokens &&
                !exchangeSlotBlocked,
        ),
        isDryRun,
        refetchInterval,
        isConfidential,
    });

    const isDebouncingSource =
        (sourceAmount || "") !== (debouncedSourceAmount || "");
    const isQuoteBusy =
        isDebouncingSource || isLoadingQuote || (isFetchingQuote && !quoteData);

    const formattedDerivedAmount = useFormatQuoteAmount(
        quoteData?.quote
            ? amountMode === "EXACT_INPUT"
                ? {
                      amount: quoteData.quote.amountOut,
                      amountFormatted: quoteData.quote.amountOutFormatted,
                      amountUsd: quoteData.quote.amountOutUsd,
                      tokenDecimals: receiveToken.decimals,
                  }
                : {
                      amount: quoteData.quote.amountIn,
                      amountFormatted: quoteData.quote.amountInFormatted,
                      amountUsd: quoteData.quote.amountInUsd,
                      tokenDecimals: sellToken.decimals,
                  }
            : null,
    );

    const clearDerivedAmount = useCallback(
        (mode: ExchangeSwapType = amountMode) => {
            const derivedField =
                mode === "EXACT_INPUT" ? "receiveAmount" : "sellAmount";
            if (form.getValues(derivedField) !== "") {
                form.setValue(derivedField, "");
            }
        },
        [amountMode, form],
    );

    // Apply quote results outside queryFn (no form mutations during fetch).
    // On error, clear derived/proposal state so stale success data cannot linger.
    useEffect(() => {
        if (quoteError) {
            if (isDryRun) {
                clearDerivedAmount();
            } else {
                (
                    form.setValue as (
                        name: string,
                        value: unknown,
                        opts?: object,
                    ) => void
                )("proposalData", null, { shouldValidate: false });
            }
            return;
        }

        if (!quoteData?.quote) return;

        if (isDryRun) {
            const derivedValue =
                formattedDerivedAmount ||
                (amountMode === "EXACT_INPUT"
                    ? quoteData.quote.amountOutFormatted
                    : quoteData.quote.amountInFormatted);
            const derivedField =
                amountMode === "EXACT_INPUT" ? "receiveAmount" : "sellAmount";
            // Skip no-op writes — setValue resets caret/selection.
            if (form.getValues(derivedField) !== derivedValue) {
                form.setValue(derivedField, derivedValue);
            }
        } else {
            (
                form.setValue as (
                    name: string,
                    value: unknown,
                    opts?: object,
                ) => void
            )("proposalData", quoteData, { shouldValidate: false });
        }
    }, [
        quoteData,
        quoteError,
        isDryRun,
        amountMode,
        formattedDerivedAmount,
        form,
        clearDerivedAmount,
    ]);

    const setAmountMode = useCallback(
        (mode: ExchangeSwapType) => {
            if (form.getValues("amountMode") === mode) return;
            form.setValue("amountMode", mode);
            clearDerivedAmount(mode);
        },
        [form, clearDerivedAmount],
    );

    const onSellAmountInput = useCallback(() => {
        if (form.getValues("amountMode") !== "EXACT_INPUT") {
            form.setValue("amountMode", "EXACT_INPUT");
        }
        if (form.getValues("receiveAmount") !== "") {
            form.setValue("receiveAmount", "");
        }
    }, [form]);

    const onReceiveAmountInput = useCallback(() => {
        if (form.getValues("amountMode") !== "EXACT_OUTPUT") {
            form.setValue("amountMode", "EXACT_OUTPUT");
        }
        if (form.getValues("sellAmount") !== "") {
            form.setValue("sellAmount", "");
        }
    }, [form]);

    const onQuoteInputsChanged = useCallback(() => {
        clearDerivedAmount();
    }, [clearDerivedAmount]);

    return {
        sellToken,
        receiveToken,
        sellAmount,
        receiveAmount,
        amountMode,
        slippageTolerance,
        areSameTokens,
        hasValidAmount,
        quoteData,
        quoteError,
        isLoadingQuote,
        isFetchingQuote,
        isQuoteBusy,
        formattedDerivedAmount,
        isSellDerived: amountMode === "EXACT_OUTPUT",
        isReceiveDerived: amountMode === "EXACT_INPUT",
        setAmountMode,
        onSellAmountInput,
        onReceiveAmountInput,
        onQuoteInputsChanged,
        clearDerivedAmount,
    };
}
