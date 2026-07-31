use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};

/// One balance-bearing gold leg unpivoted for chart carry-forward: the
/// asset's absolute balance after the event, in chain chronology.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GoldBalancePoint {
    pub asset: String,
    pub balance: BigDecimal,
    pub at_time: DateTime<Utc>,
    pub at_height: i64,
    pub gold_id: i64,
    pub leg_order: i32,
}

/// Everything the chart endpoint needs to decide Ok / Stale / Unavailable in
/// one read: gold projection readiness plus the verification gate.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ChartReadiness {
    pub projection_ready: bool,
    pub projection_ready_at: Option<DateTime<Utc>>,
    pub gold_dirty: bool,
    pub verification_passed: bool,
    pub head_check_failed: bool,
    /// False while a validated staking pool still has uncovered chart-horizon
    /// boundaries — a partially backfilled staked series would be misleading.
    pub staking_ready: bool,
    /// Preserves the distinction between an empty requested range/token filter
    /// and a projection that has no balance-bearing Gold rows at all.
    pub has_gold_balance_points: bool,
    pub ledger_coverage_start: Option<DateTime<Utc>>,
    pub ledger_head_time: Option<DateTime<Utc>>,
}
