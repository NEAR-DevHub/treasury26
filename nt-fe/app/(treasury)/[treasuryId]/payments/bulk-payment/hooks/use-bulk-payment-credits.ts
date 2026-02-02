import { useQuery } from "@tanstack/react-query";
import { getBulkPaymentUsageStats } from "@/lib/api";

/**
 * Query hook to get bulk payment credits usage statistics for a treasury
 * Returns credits available, used, and total credits
 * Fetches from backend which tracks bulk payment usage per treasury
 */
export function useBulkPaymentCredits(treasuryId: string | null | undefined) {
  return useQuery({
    queryKey: ["bulkPaymentCredits", treasuryId],
    queryFn: () => getBulkPaymentUsageStats(treasuryId!),
    enabled: !!treasuryId,
    staleTime: Infinity,
  });
}

