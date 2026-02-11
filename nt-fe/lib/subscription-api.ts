import axios from "axios";

const BACKEND_API_BASE =
    process.env.NEXT_PUBLIC_BACKEND_API_BASE || "http://localhost:3001";

/**
 * Subscription plan types
 */
export type PlanType = "free" | "plus" | "pro" | "enterprise";

/**
 * Plan limits and features
 */
export interface PlanLimits {
    monthlyVolumeLimitCents: number | null;
    overageRateBps: number;
    exchangeFeeBps: number;
    monthlyExportCredits: number | null;
    trialExportCredits: number | null;
    monthlyBatchPaymentCredits: number | null;
    trialBatchPaymentCredits: number | null;
    gasCoveredTransactions: number | null;
    historyLookupMonths: number;
}

/**
 * Plan pricing information (all prices in USD cents)
 */
export interface PlanPricing {
    monthlyPriceCents: number | null;
    yearlyPriceCents: number | null;
}

/**
 * Complete plan configuration
 */
export interface PlanConfig {
    planType: PlanType;
    name: string;
    description: string;
    limits: PlanLimits;
    pricing: PlanPricing;
}

/**
 * Subscription status response from GET /api/subscription/{account_id}
 */
export interface SubscriptionStatus {
    accountId: string;
    planType: PlanType;
    planConfig: PlanConfig;
    exportCredits: number;
    batchPaymentCredits: number;
    gasCoveredTransactions: number;
    creditsResetAt: string;
    monthlyUsedVolumeCents: number;
}

/**
 * Response for GET /api/subscription/plans
 */
export interface PlansResponse {
    plans: PlanConfig[];
}

/**
 * Get subscription status for a treasury account
 */
export async function getSubscriptionStatus(
    accountId: string,
): Promise<SubscriptionStatus> {
    const response = await axios.get<SubscriptionStatus>(
        `${BACKEND_API_BASE}/api/subscription/${encodeURIComponent(accountId)}`,
    );
    return response.data;
}

/**
 * Get all available subscription plans
 */
export async function getPlans(): Promise<PlanConfig[]> {
    const response = await axios.get<PlansResponse>(
        `${BACKEND_API_BASE}/api/subscription/plans`,
    );
    return response.data.plans;
}

/**
 * Helper: Check if a plan has unlimited batch payment credits
 */
export function hasUnlimitedBatchPayments(planConfig: PlanConfig): boolean {
    return (
        planConfig.limits.monthlyBatchPaymentCredits === null &&
        planConfig.limits.trialBatchPaymentCredits === null
    );
}

/**
 * Helper: Get the batch payment credit limit for a plan
 * Returns null for unlimited plans
 */
export function getBatchPaymentCreditLimit(
    planConfig: PlanConfig,
): number | null {
    return (
        planConfig.limits.monthlyBatchPaymentCredits ??
        planConfig.limits.trialBatchPaymentCredits
    );
}

/**
 * Helper: Check if plan is on trial (free plan with trial credits)
 */
export function isTrialPlan(planConfig: PlanConfig): boolean {
    return (
        planConfig.planType === "free" &&
        planConfig.limits.trialBatchPaymentCredits !== null
    );
}
