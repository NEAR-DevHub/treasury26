use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::handlers::public_history::bronze::store::PublicHistorySource;
use crate::handlers::public_history::silver::models::PublicAsset;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BalanceEntryKind {
    Movement,
    Reconciliation,
    Observation,
}

impl BalanceEntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Movement => "movement",
            Self::Reconciliation => "reconciliation",
            Self::Observation => "observation",
        }
    }
}

/// One balance-affecting event in the bronze-derived running ledger.
///
/// Unlike silver transfer legs, entries exist for EVERY balance movement the
/// account experienced — receipt-attached function-call deposits, sponsor
/// top-ups, system rewards — regardless of whether the movement is shown in
/// the public history feed.
#[derive(Debug, Clone)]
pub struct BalanceLedgerEntry {
    pub account_id: String,
    pub asset: PublicAsset,
    pub entry_key: String,
    pub source: PublicHistorySource,
    pub source_event_id: i64,
    pub receipt_id: Option<String>,
    pub transaction_hash: Option<String>,
    pub counterparty: Option<String>,
    pub block_height: i64,
    pub block_time: DateTime<Utc>,
    pub intra_block_seq: i32,
    pub delta_raw: BigDecimal,
    pub delta: BigDecimal,
    pub decimals: i32,
    pub balance_before: BigDecimal,
    pub balance_after: BigDecimal,
    /// Economic ownership: sponsor/system funding and treasury-creation
    /// deposits move the chain balance but not the user's.
    pub affects_user_balance: bool,
    pub user_balance_after: BigDecimal,
    /// True for the sponsor-absorbed piece of a clamped user outflow (see
    /// `clamp_user_outflow` in `builder.rs`). Observability only — never
    /// gates verification pass/fail.
    pub is_sponsor_clamp: bool,
}

/// Latest balance per asset strictly before a recompute window, used to seed
/// running totals so partial recomputes continue from trusted history.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct BalanceSeedRow {
    pub asset: String,
    pub balance_after: BigDecimal,
    pub user_balance_after: BigDecimal,
}

#[derive(Debug, Clone)]
pub struct LedgerProjectionError {
    pub source_event_id: i64,
    pub reason: String,
    pub raw_payload: Value,
}

#[derive(Debug, Default)]
pub struct LedgerBuildResult {
    pub entries: Vec<BalanceLedgerEntry>,
    pub errors: Vec<LedgerProjectionError>,
    /// Movements where a user-tagged outflow exceeded the available user
    /// balance and got split into a user portion (down to zero) plus a
    /// sponsor-absorbed remainder. Zero in the common case.
    pub sponsor_clamped_entries: u64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct BalanceLedgerOutcome {
    pub entries_written: u64,
    pub entries_deleted: u64,
}
