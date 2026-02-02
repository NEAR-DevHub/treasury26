import { useQuery } from "@tanstack/react-query";
import { getPlanDetails } from "@/lib/api";

/**
 * Query hook to get plan details for a treasury
 * Returns the plan type, credit limits for various features, and period information
 */
export function usePlanDetails(treasuryId: string | null | undefined) {
  return useQuery({
    queryKey: ["planDetails", treasuryId],
    queryFn: () => getPlanDetails(treasuryId!),
    enabled: !!treasuryId,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

