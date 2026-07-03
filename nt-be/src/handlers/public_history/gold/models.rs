use std::collections::HashMap;

use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::handlers::public_history::silver::models::PublicTransactionType;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DirtyPublicGoldAccount {
    pub account_id: String,
    pub dirty_since: DateTime<Utc>,
    pub recompute_from: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GoldBalanceSeedRow {
    pub asset: String,
    pub balance: BigDecimal,
}

#[derive(Debug, Clone, Default)]
pub struct GoldLedger {
    balances: HashMap<String, BigDecimal>,
}

impl GoldLedger {
    pub fn from_seed(rows: Vec<GoldBalanceSeedRow>) -> Self {
        let balances = rows
            .into_iter()
            .map(|row| (row.asset, row.balance))
            .collect();
        Self { balances }
    }

    pub fn apply_in(&mut self, token_id: &str, amount: &BigDecimal) -> (BigDecimal, BigDecimal) {
        let before = self
            .balances
            .get(token_id)
            .cloned()
            .unwrap_or_else(|| BigDecimal::from(0));
        let after = before.clone() + amount.clone();
        self.balances.insert(token_id.to_string(), after.clone());
        (before, after)
    }

    pub fn apply_out(&mut self, token_id: &str, amount: &BigDecimal) -> (BigDecimal, BigDecimal) {
        let before = self
            .balances
            .get(token_id)
            .cloned()
            .unwrap_or_else(|| BigDecimal::from(0));
        let after = before.clone() - amount.clone();
        self.balances.insert(token_id.to_string(), after.clone());
        (before, after)
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

#[derive(Debug, Clone)]
pub struct GoldPublicHistoryEvent {
    pub gold_event_key: String,
    pub primary_transfer_leg_id: i64,
    pub counter_transfer_leg_id: Option<i64>,
    pub proposal_ref: Option<i64>,
    pub dao_id: String,
    pub transaction_type: PublicTransactionType,
    pub token_in: Option<String>,
    pub token_out: Option<String>,
    pub amount_in: Option<BigDecimal>,
    pub amount_out: Option<BigDecimal>,
    pub amount_in_usd: Option<BigDecimal>,
    pub amount_out_usd: Option<BigDecimal>,
    pub usd_change: Option<BigDecimal>,
    pub token_in_balance_before: Option<BigDecimal>,
    pub token_in_balance_after: Option<BigDecimal>,
    pub token_out_balance_before: Option<BigDecimal>,
    pub token_out_balance_after: Option<BigDecimal>,
    pub recipient: Option<String>,
    pub counterparty: Option<String>,
    pub refund_to: Option<String>,
    pub transaction_hash: Option<String>,
    pub receipt_id: Option<String>,
    pub block_height: Option<i64>,
    pub event_time: DateTime<Utc>,
    pub proposal_id: Option<i64>,
    pub proposal_status: Option<String>,
    pub proposal_created_at: Option<DateTime<Utc>>,
    pub proposal_executed_at: Option<DateTime<Utc>>,
    pub proposal_execution_block_height: Option<i64>,
    pub proposal_execution_transaction_hash: Option<String>,
    pub status: PublicHistoryEventStatus,
    pub raw_payload: Value,
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
