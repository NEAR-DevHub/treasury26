import { useQuery } from "@tanstack/react-query";
import { UseFormReturn } from "react-hook-form";
import { useTranslations } from "next-intl";
import Big from "@/lib/big";
import {
    getIntentsQuote,
    IntentsQuoteResponse,
    getTokenMetadata,
} from "@/lib/api";
import { Token } from "@/components/token-input";
import {
    formatAssetForIntentsAPI,
    getRecipientType,
    classifyExchangeError,
    getDepositAndRefundType,
    isNEARDeposit,
    isNEARWithdraw,
} from "../utils";
import { NEAR_NETWORK_ID, WRAP_NEAR_TOKEN_ID } from "@/constants/network-ids";

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
    isConfidential?: boolean;
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
    isConfidential,
}: UseExchangeQuoteParams) {
    const tEx = useTranslations("exchangeErrors");
    return useQuery({
        queryKey: [
            isDryRun ? "dryExchangeQuote" : "liveExchangeQuote",
            selectedTreasury,
            sellToken.address,
            receiveToken.address,
            sellAmount,
            slippageTolerance,
            isConfidential,
        ],
        queryFn: async (): Promise<IntentsQuoteResponse | null> => {
            if (!selectedTreasury) return null;

            try {
                const isDeposit = isNEARDeposit(sellToken, receiveToken);
                const isWithdraw = isNEARWithdraw(sellToken, receiveToken);

                if (isDeposit || isWithdraw) {
                    const amountInRaw = Big(sellAmount)
                        .mul(Big(10).pow(sellToken.decimals))
                        .toFixed();

                    // Fetch token price for USD calculation
                    const tokenMetadata =
                        await getTokenMetadata(WRAP_NEAR_TOKEN_ID);
                    const tokenPrice = tokenMetadata?.price || 0;
                    const amountUsd = (
                        parseFloat(sellAmount) * tokenPrice
                    ).toFixed();

                    const mockQuote: IntentsQuoteResponse = {
                        quote: {
                            amountIn: amountInRaw,
                            amountInFormatted: sellAmount,
                            amountInUsd: amountUsd,
                            minAmountIn: amountInRaw,
                            amountOut: amountInRaw,
                            amountOutFormatted: sellAmount,
                            amountOutUsd: amountUsd,
                            minAmountOut: amountInRaw,
                            timeEstimate: 0,
                            depositAddress: selectedTreasury,
                            deadline: new Date(
                                Date.now() + 24 * 60 * 60 * 1000,
                            ).toISOString(),
                            timeWhenInactive: new Date(
                                Date.now() + 24 * 60 * 60 * 1000,
                            ).toISOString(),
                        },
                        quoteRequest: {
                            swapType: "EXACT_INPUT",
                            slippageTolerance: 0,
                            originAsset: isDeposit
                                ? NEAR_NETWORK_ID
                                : WRAP_NEAR_TOKEN_ID,
                            depositType: "DESTINATION_CHAIN",
                            destinationAsset: isDeposit
                                ? WRAP_NEAR_TOKEN_ID
                                : NEAR_NETWORK_ID,
                            amount: amountInRaw,
                            refundTo: selectedTreasury,
                            refundType: "DESTINATION_CHAIN",
                            recipient: selectedTreasury,
                            recipientType: "DESTINATION_CHAIN",
                            deadline: new Date(
                                Date.now() + 24 * 60 * 60 * 1000,
                            ).toISOString(),
                        },
                        signature: "",
                        timestamp: new Date().toISOString(),
                        correlationId: `mock-${Date.now()}`,
                    };

                    if (isDryRun) {
                        form.setValue("receiveAmount", sellAmount);
                        form.clearErrors("receiveAmount");
                    } else {
                        form.setValue("proposalData" as any, mockQuote, {
                            shouldValidate: false,
                        });
                    }
                    return mockQuote;
                }

                const parsedAmount = Big(sellAmount)
                    .mul(Big(10).pow(sellToken.decimals))
                    .toFixed();

                const originAsset = formatAssetForIntentsAPI(sellToken.address);
                const destinationAsset = formatAssetForIntentsAPI(
                    receiveToken.address,
                );
                const depositAndRefundType = getDepositAndRefundType(
                    sellToken.residency || "",
                    isConfidential,
                );
                const recipientType = getRecipientType(
                    receiveToken.residency || "",
                    isConfidential,
                );

                const quote = await getIntentsQuote(
                    {
                        daoId: selectedTreasury,
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
                        quoteWaitingTimeMs: isDryRun ? 0 : 3000,
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
                    const { code, raw } = classifyExchangeError(
                        error?.message || tEx("fetchFailed"),
                    );
                    form.setError("receiveAmount", {
                        type: "manual",
                        message: code === "unknown" ? raw : tEx(code),
                    });
                }
                return null;
            }
        },
        enabled,
        refetchInterval,
        staleTime: refetchInterval,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
    });
}
