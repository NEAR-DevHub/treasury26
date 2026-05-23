use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionKind {
    Sent,
    Exchange,
    Deposit,
}

impl ProjectionKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ProjectionKind::Sent => "sent",
            ProjectionKind::Exchange => "exchange",
            ProjectionKind::Deposit => "deposit",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ProjectionCycleStats {
    pub accounts_seen: usize,
    pub accounts_projected: usize,
    pub accounts_skipped_locked: usize,
    pub accounts_failed: usize,
    pub rows_projected: u64,
    pub rows_deleted: u64,
    pub errors_written: u64,
}

#[derive(Debug, Clone, Default)]
pub struct DaoProjectionStats {
    pub rows_projected: u64,
    pub rows_deleted: u64,
    pub errors_written: u64,
    pub skipped_locked: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct DirtyDao {
    pub(crate) account_id: String,
    pub(crate) gold_dirty_since: DateTime<Utc>,
    pub(crate) gold_recompute_from: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct GoldBalanceSeedRow {
    pub(crate) asset: String,
    pub(crate) balance: BigDecimal,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct BronzeProjectionRow {
    pub(crate) id: i64,
    pub(crate) account_id: String,
    pub(crate) created_at_external: DateTime<Utc>,
    pub(crate) deposit_address: String,
    pub(crate) deposit_memo: Option<String>,
    pub(crate) deposit_type: String,
    pub(crate) recipient_type: Option<String>,
    pub(crate) recipient: Option<String>,
    pub(crate) origin_asset: Option<String>,
    pub(crate) destination_asset: String,
    pub(crate) raw_payload: Value,
    pub(crate) intent_id: Option<i32>,
    pub(crate) proposal_created_at: Option<DateTime<Utc>>,
    pub(crate) executed_at: Option<DateTime<Utc>>,
    pub(crate) execution_block_height: Option<i64>,
    pub(crate) execution_transaction_hash: Option<String>,
}

pub(crate) struct ProjectedRow {
    pub(crate) history_event_id: i64,
    pub(crate) intent_id: Option<i32>,
    pub(crate) dao_id: String,
    pub(crate) transaction_type: ProjectionKind,
    pub(crate) origin_asset: Option<String>,
    pub(crate) destination_asset: String,
    pub(crate) amount_in: Option<BigDecimal>,
    pub(crate) amount_out: BigDecimal,
    pub(crate) amount_in_usd: Option<BigDecimal>,
    pub(crate) amount_out_usd: Option<BigDecimal>,
    pub(crate) usd_change: BigDecimal,
    pub(crate) origin_balance_before: Option<BigDecimal>,
    pub(crate) origin_balance_after: Option<BigDecimal>,
    pub(crate) destination_balance_before: Option<BigDecimal>,
    pub(crate) destination_balance_after: Option<BigDecimal>,
    pub(crate) recipient: String,
    pub(crate) refund_to: String,
    pub(crate) counterparty: String,
    pub(crate) deposit_address: String,
    pub(crate) deposit_memo: Option<String>,
    pub(crate) block_height: Option<i64>,
    pub(crate) block_time: Option<DateTime<Utc>>,
    pub(crate) transaction_hash: Option<String>,
    pub(crate) quote_created_at: DateTime<Utc>,
    pub(crate) proposal_created_at: Option<DateTime<Utc>>,
    pub(crate) executed_at: Option<DateTime<Utc>>,
}
