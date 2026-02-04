//! Plan configuration for subscription tiers
//!
//! Defines all plan limits, features, and pricing for Treasury26.
//! See docs/PRICING.md for full documentation.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Subscription plan types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "plan_type", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum PlanType {
    Free,
    Plus,
    Pro,
    Enterprise,
}


impl std::fmt::Display for PlanType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanType::Free => write!(f, "free"),
            PlanType::Plus => write!(f, "plus"),
            PlanType::Pro => write!(f, "pro"),
            PlanType::Enterprise => write!(f, "enterprise"),
        }
    }
}

/// Billing period options
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "billing_period", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum BillingPeriod {
    Monthly,
    Yearly,
}

impl BillingPeriod {
    /// Get the number of months for this billing period
    pub fn months(&self) -> u32 {
        match self {
            BillingPeriod::Monthly => 1,
            BillingPeriod::Yearly => 12,
        }
    }
}

/// Plan limits and features
/// Note: Each treasury is purchased separately, no max_treasuries limit per account
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanLimits {
    /// Monthly outbound volume limit in USD cents (None = unlimited)
    pub monthly_volume_limit_cents: Option<u64>,

    /// Overage rate as basis points (e.g., 20 = 0.20%)
    pub overage_rate_bps: u32,

    /// Exchange fee as basis points (e.g., 35 = 0.35%)
    pub exchange_fee_bps: u32,

    /// Gas covered transactions (None for one-time trial or unlimited)
    pub gas_covered_transactions: Option<u32>,

    /// Monthly export credits (None for one-time trial or unlimited)
    pub monthly_export_credits: Option<u32>,

    /// One-time trial export credits (for free plan)
    pub trial_export_credits: Option<u32>,

    /// Monthly batch payment credits (None for one-time trial or unlimited)
    pub monthly_batch_payment_credits: Option<u32>,

    /// One-time trial batch payment credits (for free plan)
    pub trial_batch_payment_credits: Option<u32>,

    /// History lookup in months
    pub history_lookup_months: u32,
}

/// Plan pricing information (all prices in USD cents)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanPricing {
    /// Price for 6-month period in USD cents
    pub six_month_price_cents: u32,

    /// Monthly price in USD cents (if available)
    pub monthly_price_cents: Option<u32>,

    /// Yearly price in USD cents (if available)
    pub yearly_price_cents: Option<u32>,
}

/// Complete plan configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanConfig {
    pub plan_type: PlanType,
    pub name: String,
    pub description: String,
    pub limits: PlanLimits,
    pub pricing: PlanPricing,
}

/// Get the configuration for all plans
pub fn get_plans_config() -> HashMap<PlanType, PlanConfig> {
    let mut plans = HashMap::new();

    // Free Plan
    plans.insert(
        PlanType::Free,
        PlanConfig {
            plan_type: PlanType::Free,
            name: "Free".to_string(),
            description: "Get started with core on-chain asset management features at no cost."
                .to_string(),
            limits: PlanLimits {
                monthly_volume_limit_cents: Some(2500000), // $25k
                overage_rate_bps: 20,                        // 0.20%
                exchange_fee_bps: 35,                        // 0.35%
                gas_covered_transactions: Some(10),          // 10 gas covered transactions
                monthly_export_credits: None,                // No monthly reset
                trial_export_credits: Some(3),               // 3 one-time trial exports
                monthly_batch_payment_credits: None,         // No monthly reset
                trial_batch_payment_credits: Some(3),        // 3 one-time trial
                history_lookup_months: 3,
            },
            pricing: PlanPricing {
                six_month_price_cents: 0,
                monthly_price_cents: None,
                yearly_price_cents: None,
            },
        },
    );

    // Plus Plan
    plans.insert(
        PlanType::Plus,
        PlanConfig {
            plan_type: PlanType::Plus,
            name: "Plus".to_string(),
            description:
                "For growing crypto teams and high-security individuals who want enhanced security and collaboration with multisig."
                    .to_string(),
            limits: PlanLimits {
                monthly_volume_limit_cents: Some(50_000_000), // $500k
                overage_rate_bps: 20,                         // 0.20%
                exchange_fee_bps: 20,                         // 0.20%
                gas_covered_transactions: Some(100),          // 10 gas covered transactions
                monthly_export_credits: Some(5),
                trial_export_credits: None,
                monthly_batch_payment_credits: Some(10),
                trial_batch_payment_credits: None,
                history_lookup_months: 12,
            },
            pricing: PlanPricing {
                six_month_price_cents: 29_400,       // $294
                monthly_price_cents: Some(49_00),    // $49/month
                yearly_price_cents: Some(47_000),    // $470/year (~20% discount)
            },
        },
    );

    // Pro Plan
    plans.insert(
        PlanType::Pro,
        PlanConfig {
            plan_type: PlanType::Pro,
            name: "Pro".to_string(),
            description:
                "For larger organizations dealing with high-volume, on-chain operations and significant crypto assets."
                    .to_string(),
            limits: PlanLimits {
                monthly_volume_limit_cents: Some(100_000_000), // $1M
                overage_rate_bps: 10,                           // 0.10%
                exchange_fee_bps: 10,                           // 0.10%
                gas_covered_transactions: Some(1000),          // 1000 gas covered transactions
                monthly_export_credits: Some(10),
                trial_export_credits: None,
                monthly_batch_payment_credits: Some(100),
                trial_batch_payment_credits: None,
                history_lookup_months: 24,
            },
            pricing: PlanPricing {
                six_month_price_cents: 119_400,      // $1,194
                monthly_price_cents: None,           // No monthly option
                yearly_price_cents: Some(191_000),   // $1,910/year (~20% discount)
            },
        },
    );

    // Enterprise Plan
    plans.insert(
        PlanType::Enterprise,
        PlanConfig {
            plan_type: PlanType::Enterprise,
            name: "Enterprise".to_string(),
            description:
                "For larger organizations who need customization & dedicated priority support."
                    .to_string(),
            limits: PlanLimits {
                monthly_volume_limit_cents: None, // Unlimited
                overage_rate_bps: 0,              // 0%
                exchange_fee_bps: 0,              // 0%
                gas_covered_transactions: None,   // Unlimited
                monthly_export_credits: None,     // Unlimited (handled as None check)
                trial_export_credits: None,
                monthly_batch_payment_credits: None, // Unlimited
                trial_batch_payment_credits: None,
                history_lookup_months: 120, // 10 years (effectively unlimited)
            },
            pricing: PlanPricing {
                six_month_price_cents: 0, // Custom pricing
                monthly_price_cents: None,
                yearly_price_cents: None,
            },
        },
    );

    plans
}

/// Get a specific plan configuration
pub fn get_plan_config(plan_type: PlanType) -> PlanConfig {
    get_plans_config()
        .get(&plan_type)
        .cloned()
        .expect("All plan types should have configuration")
}

/// Get all plans as a vector (for API responses)
pub fn get_all_plans() -> Vec<PlanConfig> {
    vec![
        get_plan_config(PlanType::Free),
        get_plan_config(PlanType::Plus),
        get_plan_config(PlanType::Pro),
        get_plan_config(PlanType::Enterprise),
    ]
}

/// Check if an account has remaining export credits
/// For Enterprise, always returns true (unlimited)
/// For Free plan with used trial credits, returns false
pub fn has_export_credits(plan_type: PlanType, current_credits: i32) -> bool {
    if plan_type == PlanType::Enterprise {
        return true; // Unlimited
    }
    current_credits > 0
}

/// Check if an account has remaining batch payment credits
/// For Enterprise, always returns true (unlimited)
pub fn has_batch_payment_credits(plan_type: PlanType, current_credits: i32) -> bool {
    if plan_type == PlanType::Enterprise {
        return true; // Unlimited
    }
    current_credits > 0
}

/// Get the initial credits for a plan (used when creating or resetting)
pub fn get_initial_credits(plan_type: PlanType) -> (i32, i32) {
    let config = get_plan_config(plan_type);

    let export_credits = config
        .limits
        .monthly_export_credits
        .or(config.limits.trial_export_credits)
        .unwrap_or(0) as i32;

    let batch_payment_credits = config
        .limits
        .monthly_batch_payment_credits
        .or(config.limits.trial_batch_payment_credits)
        .unwrap_or(0) as i32;

    (export_credits, batch_payment_credits)
}

/// Calculate overage fee for volume exceeding plan limit
/// Returns fee in USD cents
pub fn calculate_overage_fee(plan_type: PlanType, volume_cents: u64, limit_cents: u64) -> u64 {
    let config = get_plan_config(plan_type);

    if volume_cents <= limit_cents {
        return 0;
    }

    let overage = volume_cents - limit_cents;
    (overage * config.limits.overage_rate_bps as u64) / 10_000
}

/// Calculate exchange fee for a transaction
/// Returns fee in USD cents
pub fn calculate_exchange_fee(plan_type: PlanType, amount_cents: u64) -> u64 {
    let config = get_plan_config(plan_type);
    (amount_cents * config.limits.exchange_fee_bps as u64) / 10_000
}

/// Check if volume exceeds the plan's monthly limit
pub fn is_over_volume_limit(plan_type: PlanType, current_volume_cents: u64) -> bool {
    let config = get_plan_config(plan_type);
    match config.limits.monthly_volume_limit_cents {
        Some(limit) => current_volume_cents > limit,
        None => false, // Unlimited
    }
}

/// Get the monthly volume limit for a plan
pub fn get_volume_limit(plan_type: PlanType) -> Option<u64> {
    let config = get_plan_config(plan_type);
    config.limits.monthly_volume_limit_cents
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_plans_have_config() {
        let plans = get_plans_config();
        assert!(plans.contains_key(&PlanType::Free));
        assert!(plans.contains_key(&PlanType::Plus));
        assert!(plans.contains_key(&PlanType::Pro));
        assert!(plans.contains_key(&PlanType::Enterprise));
    }

    #[test]
    fn test_get_all_plans_order() {
        let plans = get_all_plans();
        assert_eq!(plans.len(), 4);
        assert_eq!(plans[0].plan_type, PlanType::Free);
        assert_eq!(plans[1].plan_type, PlanType::Plus);
        assert_eq!(plans[2].plan_type, PlanType::Pro);
        assert_eq!(plans[3].plan_type, PlanType::Enterprise);
    }

    #[test]
    fn test_overage_calculation() {
        // Plus plan: 0.20% overage on $500k limit
        let fee = calculate_overage_fee(
            PlanType::Plus,
            60_000_000, // $600k
            50_000_000, // $500k limit
        );
        // Overage: $100k = 10_000_000 cents, fee: 10_000_000 * 20 / 10_000 = 20_000 cents = $200
        assert_eq!(fee, 20_000);
    }

    #[test]
    fn test_no_overage_under_limit() {
        let fee = calculate_overage_fee(
            PlanType::Plus,
            40_000_000, // $400k (under $500k limit)
            50_000_000,
        );
        assert_eq!(fee, 0);
    }

    #[test]
    fn test_exchange_fee_calculation() {
        // Free plan: 0.35% exchange fee
        let fee = calculate_exchange_fee(PlanType::Free, 1_000_000); // $10k
        // Fee: 10_000_00 * 35 / 10_000 = 3500 cents = $35
        assert_eq!(fee, 35_00);

        // Pro plan: 0.10% exchange fee
        let fee = calculate_exchange_fee(PlanType::Pro, 10_000_00); // $10k
        // Fee: 10_000_00 * 10 / 10_000 = 1000 cents = $10
        assert_eq!(fee, 10_00);

        // Enterprise: 0% exchange fee
        let fee = calculate_exchange_fee(PlanType::Enterprise, 10_000_00);
        assert_eq!(fee, 0);
    }

    #[test]
    fn test_initial_credits() {
        // Free plan: 3 trial credits each
        let (exports, batch) = get_initial_credits(PlanType::Free);
        assert_eq!(exports, 3);
        assert_eq!(batch, 3);

        // Plus plan: 5 exports, 10 batch payments
        let (exports, batch) = get_initial_credits(PlanType::Plus);
        assert_eq!(exports, 5);
        assert_eq!(batch, 10);

        // Pro plan: 10 exports, 100 batch payments
        let (exports, batch) = get_initial_credits(PlanType::Pro);
        assert_eq!(exports, 10);
        assert_eq!(batch, 100);

        // Enterprise: unlimited (0 as there's no limit to track)
        let (exports, batch) = get_initial_credits(PlanType::Enterprise);
        assert_eq!(exports, 0);
        assert_eq!(batch, 0);
    }

    #[test]
    fn test_has_credits() {
        // Enterprise always has credits
        assert!(has_export_credits(PlanType::Enterprise, 0));
        assert!(has_batch_payment_credits(PlanType::Enterprise, 0));

        // Other plans depend on credit count
        assert!(has_export_credits(PlanType::Free, 1));
        assert!(!has_export_credits(PlanType::Free, 0));

        assert!(has_batch_payment_credits(PlanType::Plus, 5));
        assert!(!has_batch_payment_credits(PlanType::Plus, 0));
    }

    #[test]
    fn test_volume_limit() {
        assert_eq!(get_volume_limit(PlanType::Free), Some(25_000_00));
        assert_eq!(get_volume_limit(PlanType::Plus), Some(500_000_00));
        assert_eq!(get_volume_limit(PlanType::Pro), Some(1_000_000_00));
        assert_eq!(get_volume_limit(PlanType::Enterprise), None); // Unlimited
    }

    #[test]
    fn test_is_over_volume_limit() {
        // Free plan: $25k limit
        assert!(!is_over_volume_limit(PlanType::Free, 20_000_00)); // $20k
        assert!(is_over_volume_limit(PlanType::Free, 30_000_00)); // $30k

        // Enterprise: never over limit
        assert!(!is_over_volume_limit(PlanType::Enterprise, 999_999_999_00));
    }

    #[test]
    fn test_billing_period_months() {
        assert_eq!(BillingPeriod::Monthly.months(), 1);
        assert_eq!(BillingPeriod::Yearly.months(), 12);
    }
}
