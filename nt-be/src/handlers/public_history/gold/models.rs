use std::collections::HashMap;

use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};

use crate::handlers::public_history::silver::models::{
    PublicTransactionType, SilverTransferLegRow,
};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DirtyPublicGoldAccount {
    pub account_id: String,
    pub dirty_since: DateTime<Utc>,
    pub recompute_from: Option<DateTime<Utc>>,
}

/// Ledger identity of one movement, read from `silver_balance_history`.
/// Gold does not maintain its own running total — it stamps the user-owned
/// balance after each movement onto events, so feed-hidden movements
/// (sponsor top-ups, wraps) are still absorbed into the next visible event's
/// derived balance_before.
#[derive(Debug, Clone)]
pub struct BalanceStamp {
    pub user_balance_after: BigDecimal,
    pub intra_block_seq: i32,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct BalanceStampRow {
    pub entry_key: String,
    pub token_standard: String,
    pub receipt_id: Option<String>,
    pub user_balance_after: BigDecimal,
    pub intra_block_seq: i32,
}

#[derive(Debug, Default)]
pub struct BalanceStamps {
    /// FT/MT movements: ledger entry_key equals the silver leg_key.
    by_entry_key: HashMap<String, BalanceStamp>,
    /// Native movements are one-per-receipt in the ledger while silver may
    /// hold one leg per action row, so native legs resolve via receipt_id.
    by_receipt: HashMap<String, BalanceStamp>,
}

impl BalanceStamps {
    pub fn from_rows(rows: Vec<BalanceStampRow>) -> Self {
        let mut stamps = Self::default();
        for row in rows {
            let stamp = BalanceStamp {
                user_balance_after: row.user_balance_after,
                intra_block_seq: row.intra_block_seq,
            };
            if row.token_standard == "native"
                && let Some(receipt_id) = row.receipt_id
            {
                stamps.by_receipt.insert(receipt_id, stamp);
                continue;
            }
            stamps.by_entry_key.insert(row.entry_key, stamp);
        }
        stamps
    }

    pub fn for_leg(&self, leg: &SilverTransferLegRow) -> Option<BalanceStamp> {
        if leg.token_standard == "native" {
            leg.receipt_id
                .as_deref()
                .and_then(|receipt_id| self.by_receipt.get(receipt_id))
                .cloned()
        } else {
            self.by_entry_key.get(&leg.leg_key).cloned()
        }
    }
}

#[derive(Debug, Clone)]
pub enum PublicHistoryEventStatus {
    Pending,
    Success,
    Failed,
}

impl PublicHistoryEventStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Success => "success",
            Self::Failed => "failed",
        }
    }
}

/// One activity row for `gold_treasury_ledger_events`. The writer constants
/// (`source_kind = 'public_silver_leg'`, `history_visible = TRUE`) are
/// hardcoded in the upsert SQL, not carried here.
#[derive(Debug, Clone)]
pub struct GoldPublicHistoryEvent {
    pub gold_event_key: String,
    pub primary_transfer_leg_id: i64,
    pub counter_transfer_leg_id: Option<i64>,
    pub dao_id: String,
    pub transaction_type: PublicTransactionType,
    pub source_order: i64,
    pub token_in: Option<String>,
    pub token_out: Option<String>,
    pub amount_in: Option<BigDecimal>,
    pub amount_out: Option<BigDecimal>,
    pub amount_in_usd: Option<BigDecimal>,
    pub amount_out_usd: Option<BigDecimal>,
    pub usd_change: Option<BigDecimal>,
    pub token_in_user_balance_after: Option<BigDecimal>,
    pub token_out_user_balance_after: Option<BigDecimal>,
    pub recipient: Option<String>,
    pub counterparty: Option<String>,
    pub transaction_hash: Option<String>,
    pub receipt_id: Option<String>,
    pub block_height: Option<i64>,
    pub event_time: DateTime<Utc>,
    pub proposal_id: Option<i64>,
    pub proposal_created_at: Option<DateTime<Utc>>,
    pub proposal_executed_at: Option<DateTime<Utc>>,
    pub proposal_execution_block_height: Option<i64>,
    pub proposal_execution_transaction_hash: Option<String>,
    pub status: PublicHistoryEventStatus,
}

#[derive(Debug, Clone, Default)]
pub struct GoldProjectionResult {
    pub rows_projected: u64,
    pub rows_deleted: u64,
    pub errors_written: u64,
    pub skipped_locked: bool,
}

#[derive(Debug, Clone, Default)]
pub struct GoldProjectionCycleStats {
    pub accounts_seen: usize,
    pub accounts_projected: usize,
    pub accounts_skipped_locked: usize,
    pub accounts_failed: usize,
    pub changed_accounts: Vec<String>,
    pub rows_projected: u64,
    pub rows_deleted: u64,
    pub errors_written: u64,
}
