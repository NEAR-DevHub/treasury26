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
    monthly_volume_limit_cents: number | null;
    overage_rate_bps: number;
    exchange_fee_bps: number;
    monthly_export_credits: number | null;
    trial_export_credits: number | null;
    monthly_batch_payment_credits: number | null;
    trial_batch_payment_credits: number | null;
    history_lookup_months: number;
}

/**
 * Plan pricing information (all prices in USD cents)
 */
export interface PlanPricing {
    six_month_price_cents: number;
    monthly_price_cents: number | null;
    yearly_price_cents: number | null;
}

/**
 * Complete plan configuration
 */
export interface PlanConfig {
    plan_type: PlanType;
    name: string;
    description: string;
    limits: PlanLimits;
    pricing: PlanPricing;
}

/**
 * Subscription status response from GET /api/subscription/{account_id}
 */
export interface SubscriptionStatus {
    account_id: string;
    plan_type: PlanType;
    plan_config: PlanConfig;
    export_credits: number;
    batch_payment_credits: number;
    credits_reset_at: string;
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
        planConfig.limits.monthly_batch_payment_credits === null &&
        planConfig.limits.trial_batch_payment_credits === null
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
        planConfig.limits.monthly_batch_payment_credits ??
        planConfig.limits.trial_batch_payment_credits
    );
}

/**
 * Helper: Check if plan is on trial (free plan with trial credits)
 */
export function isTrialPlan(planConfig: PlanConfig): boolean {
    return (
        planConfig.plan_type === "free" &&
        planConfig.limits.trial_batch_payment_credits !== null
    );
}
