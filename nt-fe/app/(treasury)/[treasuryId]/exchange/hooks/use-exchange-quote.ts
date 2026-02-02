import { useQuery } from "@tanstack/react-query";
import { UseFormReturn } from "react-hook-form";
import { IntentsQuoteResponse } from "@/lib/api";
import { Token } from "@/components/token-input";
import { useQuoteFetcher } from "./use-quote-fetcher";
import { getUserFriendlyErrorMessage } from "../utils";

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
  const { fetchQuote } = useQuoteFetcher();

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

      const result = await fetchQuote(
        {
          sellToken,
          receiveToken,
          sellAmount,
          slippageTolerance,
          treasuryId: selectedTreasury,
        },
        isDryRun
      );

      if (result.quote) {
        if (isDryRun) {
          // Dry run: update receive amount
          form.setValue("receiveAmount", result.quote.quote.amountOutFormatted);
          form.clearErrors("receiveAmount");
        } else {
          // Live quote: store for submission
          form.setValue("proposalData" as any, result.quote, { shouldValidate: false });
        }
        return result.quote;
      } else if (isDryRun) {
        // Only show errors for dry run (user is still on Step 1)
        const userMessage = result.error
          ? getUserFriendlyErrorMessage(result.error)
          : "Unable to fetch quote. Please try again.";

        form.setError("receiveAmount", {
          type: "manual",
          message: userMessage,
        });
      }
      return null;
    },
    enabled,
    refetchInterval,
    refetchIntervalInBackground: false,
  });
}

