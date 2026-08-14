"use client";

import { useCallback, useEffect, useMemo } from "react";
import type { UseFormReturn } from "react-hook-form";
import { useDebounce } from "use-debounce";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { decimalOrNull } from "@/lib/amount-format";
import type { ExchangeFormValues } from "../exchange-form";
import { type ExchangeSwapType, useExchangeQuote } from "./use-exchange-quote";
import { useQuoteDecimalAmount } from "./use-format-quote-amount";

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
    const { data: policy } = useTreasuryPolicy(selectedTreasury);
    const proposalPeriod = policy?.proposal_period;

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

    const parsedSourceAmount = decimalOrNull(debouncedSourceAmount);
    const hasValidAmount = parsedSourceAmount?.gt(0) ?? false;

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
                proposalPeriod &&
                hasValidAmount &&
                !areSameTokens &&
                !exchangeSlotBlocked,
        ),
        isDryRun,
        refetchInterval,
        isConfidential,
        proposalPeriod,
    });

    const isDebouncingSource =
        (sourceAmount || "") !== (debouncedSourceAmount || "");
    const isQuoteBusy =
        isDebouncingSource || isLoadingQuote || (isFetchingQuote && !quoteData);

    const derivedAmount = useQuoteDecimalAmount(
        quoteData?.quote
            ? amountMode === "EXACT_INPUT"
                ? {
                      amount: quoteData.quote.amountOut,
                      amountFormatted: quoteData.quote.amountOutFormatted,
                      tokenDecimals: receiveToken.decimals,
                  }
                : {
                      amount: quoteData.quote.amountIn,
                      amountFormatted: quoteData.quote.amountInFormatted,
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
            const derivedValue = derivedAmount ?? "";
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
        derivedAmount,
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
        derivedAmount,
        isSellDerived: amountMode === "EXACT_OUTPUT",
        isReceiveDerived: amountMode === "EXACT_INPUT",
        setAmountMode,
        onSellAmountInput,
        onReceiveAmountInput,
        onQuoteInputsChanged,
        clearDerivedAmount,
    };
}
