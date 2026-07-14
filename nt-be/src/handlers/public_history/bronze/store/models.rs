use std::fmt;

use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicHistorySource {
    NearblocksFt,
    NearblocksMt,
    NearblocksReceipt,
}

impl PublicHistorySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NearblocksFt => "nearblocks_ft",
            Self::NearblocksMt => "nearblocks_mt",
            Self::NearblocksReceipt => "nearblocks_receipt",
        }
    }

    pub fn all() -> [Self; 3] {
        [
            Self::NearblocksFt,
            Self::NearblocksMt,
            Self::NearblocksReceipt,
        ]
    }

    pub fn from_db(value: &str) -> Result<Self, PublicHistorySourceParseError> {
        match value {
            "nearblocks_ft" => Ok(Self::NearblocksFt),
            "nearblocks_mt" => Ok(Self::NearblocksMt),
            "nearblocks_receipt" => Ok(Self::NearblocksReceipt),
            other => Err(PublicHistorySourceParseError(other.to_string())),
        }
    }
}

impl fmt::Display for PublicHistorySource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone)]
pub struct PublicHistorySourceParseError(String);

impl fmt::Display for PublicHistorySourceParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown public history source: {}", self.0)
    }
}

impl std::error::Error for PublicHistorySourceParseError {}

#[derive(Debug, Clone)]
pub struct BronzePublicHistoryEvent {
    /// Monitored treasury/DAO whose NearBlocks page produced this event.
    pub account_id: String,
    pub source: PublicHistorySource,
    pub source_event_key: String,
    pub transaction_hash: Option<String>,
    pub receipt_id: Option<String>,
    pub event_index: Option<i32>,
    pub block_height: i64,
    pub block_timestamp: BigDecimal,
    pub block_time: DateTime<Utc>,
    /// NearBlocks account with the token balance effect; receipt rows use receiver.
    pub affected_account_id: String,
    /// NearBlocks counterparty; receipt rows use predecessor/sender when known.
    pub involved_account_id: Option<String>,
    /// Token contract for FT/MT rows; receipt receiver/contract for receipt rows.
    pub contract_account_id: Option<String>,
    pub token_id: Option<String>,
    pub cause: Option<String>,
    pub action_kind: Option<String>,
    pub method_name: Option<String>,
    pub delta_amount_raw: Option<BigDecimal>,
    pub decimals: Option<i32>,
    pub deposit_raw: Option<BigDecimal>,
    pub outcome_status: Option<bool>,
    pub raw_payload: Value,
}

#[derive(Debug, Clone, Default)]
pub struct PublicHistoryUpsertResult {
    pub rows_touched: u64,
    pub rows_inserted: u64,
    pub rows_changed: u64,
    pub rows_unchanged: u64,
    pub earliest_changed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicHistoryUpsertState {
    Inserted,
    Changed,
    Unchanged,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PublicHistoryCursor {
    pub account_id: String,
    pub source: String,
    pub backward_cursor: Option<String>,
    pub backfill_done: bool,
    pub last_seen_block_height: Option<i64>,
}

pub fn min_datetime(
    current: Option<DateTime<Utc>>,
    candidate: Option<DateTime<Utc>>,
) -> Option<DateTime<Utc>> {
    match (current, candidate) {
        (Some(current), Some(candidate)) => Some(current.min(candidate)),
        (None, Some(candidate)) => Some(candidate),
        (current, None) => current,
    }
}
