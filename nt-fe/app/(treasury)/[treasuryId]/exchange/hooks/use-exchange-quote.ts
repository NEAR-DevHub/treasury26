import { useQuery } from "@tanstack/react-query";
import { UseFormReturn } from "react-hook-form";
import Big from "@/lib/big";
import { getIntentsQuote, IntentsQuoteResponse } from "@/lib/api";
import { Token } from "@/components/token-input";
import {
    formatAssetForIntentsAPI,
    getRecipientType,
    getUserFriendlyErrorMessage,
    getDepositAndRefundType,
} from "../utils";

interface UseExchangeQuoteParams {
    selectedTreasury: string | null | undefined;
    sellToken: Token;
    receiveToken: Token;
    sellAmount: string;
    slippageTolerance: number;
    form: UseFormReturn<any>;
    enabled: boolean;
    isDryRun: boolean;
    refetchInterval: number;
}

/**
 * Custom hook for fetching exchange quotes (both dry and live)
 * Handles form updates and error management
 * Returns { data, isLoading, isFetching }
 */
export function useExchangeQuote({
    selectedTreasury,
    sellToken,
    receiveToken,
    sellAmount,
    slippageTolerance,
    form,
    enabled,
    isDryRun,
    refetchInterval,
}: UseExchangeQuoteParams) {
    return useQuery({
        queryKey: [
            isDryRun ? "dryExchangeQuote" : "liveExchangeQuote",
            selectedTreasury,
            sellToken.address,
            receiveToken.address,
            sellAmount,
            slippageTolerance,
        ],
        queryFn: async (): Promise<IntentsQuoteResponse | null> => {
            if (!selectedTreasury) return null;

            try {
                const parsedAmount = Big(sellAmount)
                    .mul(Big(10).pow(sellToken.decimals))
                    .toFixed();

                const originAsset = formatAssetForIntentsAPI(sellToken.address);
                const destinationAsset = formatAssetForIntentsAPI(
                    receiveToken.address,
                );
                const depositAndRefundType = getDepositAndRefundType(
                    sellToken.residency || "",
                );
                const recipientType = getRecipientType(
                    receiveToken.residency || "",
                );

                const quote = await getIntentsQuote(
                    {
                        swapType: "EXACT_INPUT",
                        slippageTolerance: Math.round(slippageTolerance * 100), // Convert to basis points
                        originAsset,
                        depositType: depositAndRefundType,
                        destinationAsset,
                        amount: parsedAmount,
                        refundTo: selectedTreasury,
                        refundType: depositAndRefundType,
                        recipient: selectedTreasury,
                        recipientType: recipientType,
                        deadline: new Date(
                            Date.now() + 24 * 60 * 60 * 1000,
                        ).toISOString(), // 24 hours
                        quoteWaitingTimeMs: 3000,
                    },
                    isDryRun,
                );

                if (quote) {
                    if (isDryRun) {
                        // Dry run: update receive amount
                        form.setValue(
                            "receiveAmount",
                            quote.quote.amountOutFormatted,
                        );
                        form.clearErrors("receiveAmount");
                    } else {
                        // Live quote: store for submission
                        form.setValue("proposalData" as any, quote, {
                            shouldValidate: false,
                        });
                    }
                    return quote;
                }
                return null;
            } catch (error: any) {
                console.error("Error fetching quote:", error);

                if (isDryRun) {
                    // Only show errors for dry run (user is still on Step 1)
                    const userMessage = getUserFriendlyErrorMessage(
                        error?.message || "Failed to fetch quote",
                    );
                    form.setError("receiveAmount", {
                        type: "manual",
                        message: userMessage,
                    });
                }
                return null;
            }
        },
        enabled,
        refetchInterval,
        refetchIntervalInBackground: false,
    });
}
