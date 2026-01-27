import { useState } from "react";
import Big from "big.js";
import { getIntentsQuote, IntentsQuoteResponse } from "@/lib/api";
import { Token } from "@/components/token-input";
import { formatAssetForIntentsAPI, getDepositAndRefundType } from "../utils";

interface UseQuoteFetcherParams {
  sellToken: Token;
  receiveToken: Token;
  sellAmount: string;
  slippageTolerance: number;
  treasuryId: string;
}

interface QuoteFetchResult {
  quote: IntentsQuoteResponse | null;
  error: string | null;
}

/**
 * Custom hook for fetching quotes from the 1Click Intents API
 */
export function useQuoteFetcher() {
  const [isLoading, setIsLoading] = useState(false);

  const fetchQuote = async (
    params: UseQuoteFetcherParams,
    isDryRun: boolean = true
  ): Promise<QuoteFetchResult> => {
    const { sellToken, receiveToken, sellAmount, slippageTolerance, treasuryId } = params;

    setIsLoading(true);

    try {
      const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
      const parsedAmount = Big(sellAmount)
        .mul(Big(10).pow(sellToken.decimals))
        .toFixed();

      const originAsset = formatAssetForIntentsAPI(sellToken.address);
      const destinationAsset = receiveToken.address;

      const depositAndRefundType = getDepositAndRefundType(sellToken.network);

      const quote = await getIntentsQuote(
        {
          swapType: "EXACT_INPUT",
          slippageTolerance: Math.round(slippageTolerance * 100), // Convert to basis points
          originAsset,
          depositType: depositAndRefundType,
          destinationAsset,
          amount: parsedAmount,
          refundTo: treasuryId,
          refundType: depositAndRefundType,
          recipient: treasuryId,
          recipientType: "INTENTS", // Always INTENTS
          deadline,
          quoteWaitingTimeMs: 3000,
        },
        isDryRun
      );

      return { quote, error: null };
    } catch (error: any) {
      console.error("Error fetching quote:", error);
      return {
        quote: null,
        error: error?.message || "Failed to fetch quote",
      };
    } finally {
      setIsLoading(false);
    }
  };

  return { fetchQuote, isLoading };
}

