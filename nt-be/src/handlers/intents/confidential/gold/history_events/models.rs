use std::collections::HashMap;

use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use near_api::AccountId;
use serde_json::Value;
use sqlx::PgPool;

use crate::handlers::intents::confidential::types::ConfidentialTxType;

/// Bronze SUCCESS row plus optional intent join — input to gold projection.
pub(crate) type BronzeRow = BronzeProjectionRow;

/// Gold table row produced from a bronze row (same shape as legacy `ProjectedRow`).
pub(crate) struct GoldHistoryEvent {
    pub(crate) history_event_id: i64,
    pub(crate) intent_id: Option<i32>,
    pub(crate) dao_id: AccountId,
    pub(crate) transaction_type: ConfidentialTxType,
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
    /// Leg destination: who received funds on the outbound leg.
    pub(crate) recipient: String,
    /// Refund destination when a swap/deposit fails.
    pub(crate) refund_to: String,
    /// Counterparty on the inbound leg (deposit sender / exchange source).
    pub(crate) counterparty: String,
    pub(crate) deposit_address: String,
    pub(crate) deposit_memo: Option<String>,
    pub(crate) proposal_execution_block_height: Option<i64>,
    pub(crate) proposal_executed_at: Option<DateTime<Utc>>,
    pub(crate) proposal_execution_transaction_hash: Option<String>,
    pub(crate) quote_created_at: DateTime<Utc>,
    pub(crate) proposal_created_at: Option<DateTime<Utc>>,
    /// On-chain deposit tx hash from quoteTransactions[0].txHash.
    pub(crate) deposit_tx_hash: Option<String>,
}

/// Back-compat alias used by repository upsert.
pub(crate) type ProjectedRow = GoldHistoryEvent;

#[derive(Debug, Clone, Default)]
pub struct ProjectionCycleStats {
    pub accounts_seen: usize,
    pub accounts_projected: usize,
    pub accounts_skipped_locked: usize,
    pub accounts_failed: usize,
    pub changed_accounts: Vec<String>,
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
    pub(crate) proposal_executed_at: Option<DateTime<Utc>>,
    pub(crate) proposal_execution_block_height: Option<i64>,
    pub(crate) proposal_execution_transaction_hash: Option<String>,
}

/// Real deposited quantity for one confidential deposit, overriding the
/// ~0.001 quote nominal the 1Click history API reports. Stores both the raw
/// (base-units) and decimal-adjusted quantity, mirroring the snapshot table.
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct ConfidentialDepositCorrection {
    pub(crate) history_event_id: i64,
    /// Real deposited quantity in base units. Persisted for traceability
    /// (parity with the snapshot table's `raw_balance`); projection consumes
    /// `corrected_net_amount`.
    #[allow(dead_code)]
    pub(crate) corrected_raw_amount: BigDecimal,
    pub(crate) corrected_net_amount: BigDecimal,
}

/// Per-DAO lookup of deposit corrections, threaded through gold replay.
///
/// `empty_disabled()` represents the flag-off / no-data case so `project_row`
/// can stay a pure function that always receives an index.
pub(crate) struct ConfidentialDepositCorrectionIndex {
    entries: HashMap<i64, ConfidentialDepositCorrection>,
    enabled: bool,
}

impl ConfidentialDepositCorrectionIndex {
    pub(crate) fn new(entries: HashMap<i64, ConfidentialDepositCorrection>) -> Self {
        Self {
            entries,
            enabled: true,
        }
    }

    /// Disabled index: holds nothing and reports `is_enabled() == false`.
    pub(crate) fn empty_disabled() -> Self {
        Self {
            entries: HashMap::new(),
            enabled: false,
        }
    }

    pub(crate) fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub(crate) fn correction_for(
        &self,
        history_event_id: i64,
    ) -> Option<&ConfidentialDepositCorrection> {
        self.entries.get(&history_event_id)
    }
}

/// Worker entry point for gold projection cycles.
pub struct GoldProjector;

impl GoldProjector {
    pub async fn project_dao(
        pool: &PgPool,
        dao_id: &str,
    ) -> Result<DaoProjectionStats, sqlx::Error> {
        super::projector::project_confidential_gold_for_dao(pool, dao_id).await
    }

    pub async fn project_dirty_daos(
        pool: &PgPool,
        worker_limit: usize,
    ) -> Result<ProjectionCycleStats, sqlx::Error> {
        super::projector::project_confidential_gold_for_dirty_daos(pool, worker_limit).await
    }
}
