import { useQuery } from "@tanstack/react-query";
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
    getDepositAndRefundType,
    isNEARDeposit,
    isNEARWithdraw,
} from "../utils";
import { formatQuoteErrorMessage, isAbortError } from "../quote-errors";
import { NEAR_NETWORK_ID, WRAP_NEAR_TOKEN_ID } from "@/constants/network-ids";

export type ExchangeSwapType = "EXACT_INPUT" | "EXACT_OUTPUT";

interface UseExchangeQuoteParams {
    selectedTreasury: string | null | undefined;
    sellToken: Token;
    receiveToken: Token;
    /** Human-readable amount for the side driving the quote. */
    amount: string;
    swapType: ExchangeSwapType;
    slippageTolerance: number;
    enabled: boolean;
    isDryRun: boolean;
    refetchInterval: number;
    isConfidential?: boolean;
}

/**
 * Fetches an exchange quote. Pure with respect to form state — callers apply
 * quote results (derived amounts / proposalData) themselves.
 */
export function useExchangeQuote({
    selectedTreasury,
    sellToken,
    receiveToken,
    amount,
    swapType,
    slippageTolerance,
    enabled,
    isDryRun,
    refetchInterval,
    isConfidential,
}: UseExchangeQuoteParams) {
    const tEx = useTranslations("exchangeErrors");
    const amountToken = swapType === "EXACT_INPUT" ? sellToken : receiveToken;

    const query = useQuery({
        queryKey: [
            isDryRun ? "dryExchangeQuote" : "liveExchangeQuote",
            selectedTreasury,
            sellToken.address,
            receiveToken.address,
            amount,
            swapType,
            slippageTolerance,
            isConfidential,
        ],
        queryFn: async ({ signal }): Promise<IntentsQuoteResponse | null> => {
            if (!selectedTreasury) return null;

            try {
                const isDeposit = isNEARDeposit(sellToken, receiveToken);
                const isWithdraw = isNEARWithdraw(sellToken, receiveToken);

                if (isDeposit || isWithdraw) {
                    // Scale with the driving side (sell for EXACT_INPUT, receive for EXACT_OUTPUT).
                    const amountInRaw = Big(amount)
                        .mul(Big(10).pow(amountToken.decimals))
                        .toFixed();

                    const tokenMetadata =
                        await getTokenMetadata(WRAP_NEAR_TOKEN_ID);
                    const tokenPrice = tokenMetadata?.price || 0;
                    const amountUsd = (
                        parseFloat(amount) * tokenPrice
                    ).toFixed();

                    return {
                        quote: {
                            amountIn: amountInRaw,
                            amountInFormatted: amount,
                            amountInUsd: amountUsd,
                            minAmountIn: amountInRaw,
                            amountOut: amountInRaw,
                            amountOutFormatted: amount,
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
                            swapType,
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
                }

                const parsedAmount = Big(amount)
                    .mul(Big(10).pow(amountToken.decimals))
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

                return await getIntentsQuote(
                    {
                        daoId: selectedTreasury,
                        swapType,
                        slippageTolerance: Math.round(slippageTolerance * 100),
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
                        ).toISOString(),
                        quoteWaitingTimeMs: isDryRun ? 0 : 3000,
                    },
                    isDryRun,
                    signal,
                );
            } catch (error: unknown) {
                if (isAbortError(error) || signal.aborted) {
                    throw error;
                }
                console.error("Error fetching quote:", error);
                throw new Error(
                    formatQuoteErrorMessage(error, amountToken, tEx),
                );
            }
        },
        enabled,
        refetchInterval,
        staleTime: refetchInterval,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        retry: false,
    });

    const isQuoteError =
        enabled &&
        query.isError &&
        query.error instanceof Error &&
        !isAbortError(query.error);

    // React Query keeps the last successful data after a failed refetch.
    // Surface null instead so callers never treat a stale quote as valid.
    const data = isQuoteError ? undefined : query.data;

    const quoteError = isQuoteError ? query.error.message : null;

    return { ...query, data, quoteError };
}
