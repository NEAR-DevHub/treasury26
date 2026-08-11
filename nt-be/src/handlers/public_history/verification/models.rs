use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerificationStatus {
    Unverified,
    Passed,
    Failed,
}

impl VerificationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unverified => "unverified",
            Self::Passed => "passed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerificationCheckKind {
    BackfillGate,
    HeadDrift,
}

impl VerificationCheckKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BackfillGate => "backfill_gate",
            Self::HeadDrift => "head_drift",
        }
    }
}

/// The bronze coverage proof: all three NearBlocks sources drained through
/// this finalized block, at this freshness.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct VerificationWatermark {
    pub cutoff_block_height: i64,
    pub refreshed_at: DateTime<Utc>,
}

/// One asset's ledger head plus the invariants verification checks.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AssetLedgerHead {
    pub asset: String,
    pub token_standard: String,
    pub balance_after: BigDecimal,
    pub min_balance_after: BigDecimal,
    pub user_balance_after: BigDecimal,
    pub min_user_balance_after: BigDecimal,
    pub head_block_height: i64,
    pub decimals: i32,
    pub event_count: i64,
    pub has_anchor: bool,
}

#[derive(Debug, Clone)]
pub struct AssetCheckOutcome {
    pub asset: String,
    pub ledger_balance: BigDecimal,
    pub chain_balance: BigDecimal,
    pub drift: BigDecimal,
    pub min_running_balance: BigDecimal,
    pub passed: bool,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct VerificationCycleStats {
    pub gates_run: usize,
    pub gates_passed: usize,
    pub gates_failed: usize,
    pub gates_skipped_stale_watermark: usize,
    pub head_checks_run: usize,
    pub head_checks_failed: usize,
    pub rebases_written: u64,
}
