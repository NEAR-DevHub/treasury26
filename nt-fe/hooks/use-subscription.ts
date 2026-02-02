import { useQuery } from "@tanstack/react-query";
import {
    getSubscriptionStatus,
    getPlans,
    SubscriptionStatus,
    PlanConfig,
} from "@/lib/subscription-api";

/**
 * Query hook to get subscription status for a treasury
 * Returns the full subscription status including plan config, credits, and subscription info
 */
export function useSubscription(treasuryId: string | null | undefined) {
    return useQuery({
        queryKey: ["subscription", treasuryId],
        queryFn: () => getSubscriptionStatus(treasuryId!),
        enabled: !!treasuryId,
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

/**
 * Query hook to get all available subscription plans
 */
export function usePlans() {
    return useQuery({
        queryKey: ["subscriptionPlans"],
        queryFn: getPlans,
        staleTime: 30 * 60 * 1000, // 30 minutes - plans don't change often
    });
}

// Re-export types for convenience
export type { SubscriptionStatus, PlanConfig };
