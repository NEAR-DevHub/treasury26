use std::fmt;
use std::str::FromStr;

use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::handlers::public_history::bronze::store::PublicHistorySource;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicTokenStandard {
    Native,
    Nep141,
    Nep245,
}

impl PublicTokenStandard {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Nep141 => "nep141",
            Self::Nep245 => "nep245",
        }
    }

    pub fn from_db(value: &str) -> Result<Self, String> {
        match value {
            "native" => Ok(Self::Native),
            "nep141" => Ok(Self::Nep141),
            "nep245" => Ok(Self::Nep245),
            other => Err(format!("unknown public token standard: {}", other)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicTransferDirection {
    Incoming,
    Outgoing,
    Internal,
}

impl PublicTransferDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Incoming => "incoming",
            Self::Outgoing => "outgoing",
            Self::Internal => "internal",
        }
    }

    pub fn from_db(value: &str) -> Result<Self, String> {
        match value {
            "incoming" => Ok(Self::Incoming),
            "outgoing" => Ok(Self::Outgoing),
            "internal" => Ok(Self::Internal),
            other => Err(format!("unknown public transfer direction: {}", other)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicTransferLegKind {
    Transfer,
    Mint,
    Burn,
    WrapAndTransfer,
}

impl PublicTransferLegKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Transfer => "transfer",
            Self::Mint => "mint",
            Self::Burn => "burn",
            Self::WrapAndTransfer => "wrap_and_transfer",
        }
    }

    pub fn from_db(value: &str) -> Result<Self, String> {
        match value {
            "transfer" => Ok(Self::Transfer),
            "mint" => Ok(Self::Mint),
            "burn" => Ok(Self::Burn),
            "wrap_and_transfer" => Ok(Self::WrapAndTransfer),
            other => Err(format!("unknown public transfer leg kind: {}", other)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicTransactionType {
    Deposit,
    Sent,
    Exchange,
}

impl PublicTransactionType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Deposit => "deposit",
            Self::Sent => "sent",
            Self::Exchange => "exchange",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicAsset {
    token_standard: PublicTokenStandard,
    token_id: String,
}

impl PublicAsset {
    pub fn native_near() -> Self {
        Self {
            token_standard: PublicTokenStandard::Native,
            token_id: "near".to_string(),
        }
    }

    pub fn nep141(contract_account_id: impl Into<String>) -> Self {
        Self {
            token_standard: PublicTokenStandard::Nep141,
            token_id: contract_account_id.into(),
        }
    }

    pub fn intents(token_id: impl Into<String>) -> Self {
        Self {
            token_standard: PublicTokenStandard::Nep245,
            token_id: format!("intents.near:{}", token_id.into()),
        }
    }

    pub fn nep245(token_id: impl Into<String>) -> Self {
        Self {
            token_standard: PublicTokenStandard::Nep245,
            token_id: token_id.into(),
        }
    }

    pub fn token_standard(&self) -> PublicTokenStandard {
        self.token_standard
    }

    pub fn token_id(&self) -> &str {
        &self.token_id
    }
}

impl fmt::Display for PublicAsset {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.token_id)
    }
}

#[derive(Debug, Clone)]
pub struct PublicAmount {
    pub raw: BigDecimal,
    pub amount: BigDecimal,
    pub decimals: i32,
}

impl PublicAmount {
    pub fn from_raw(raw: BigDecimal, decimals: i32) -> Self {
        let denominator = decimal_denominator(decimals);
        Self {
            amount: raw.clone() / denominator,
            raw,
            decimals,
        }
    }
}

fn decimal_denominator(decimals: i32) -> BigDecimal {
    if decimals <= 0 {
        return BigDecimal::from(1);
    }
    let mut text = String::from("1");
    for _ in 0..decimals {
        text.push('0');
    }
    BigDecimal::from_str(&text).unwrap_or_else(|_| BigDecimal::from(1))
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct BronzePublicHistoryRow {
    pub id: i64,
    /// Monitored treasury/DAO whose NearBlocks page produced this event.
    pub account_id: String,
    pub source: String,
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
    pub proposal_ref: Option<i64>,
    pub proposal_id: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ProposalLink {
    pub proposal_ref: i64,
    pub proposal_id: i64,
}

#[derive(Debug, Clone)]
pub struct NormalizedTransferLeg {
    pub account_id: String,
    pub leg_key: String,
    pub source_event_id: i64,
    pub source: PublicHistorySource,
    pub proposal_link: Option<ProposalLink>,
    pub transaction_hash: Option<String>,
    pub receipt_id: Option<String>,
    pub block_height: i64,
    pub block_time: DateTime<Utc>,
    pub asset: PublicAsset,
    pub direction: PublicTransferDirection,
    pub counterparty: Option<String>,
    pub amount: PublicAmount,
    pub leg_kind: PublicTransferLegKind,
    pub raw_payload: Value,
}

#[derive(Debug, Clone, Default)]
pub struct SilverProjectionResult {
    pub rows_projected: u64,
    pub rows_deleted: u64,
    pub errors_written: u64,
    pub skipped_locked: bool,
}

#[derive(Debug, Clone, Default)]
pub struct SilverProjectionCycleStats {
    pub accounts_seen: usize,
    pub accounts_projected: usize,
    pub accounts_skipped_locked: usize,
    pub accounts_failed: usize,
    pub rows_projected: u64,
    pub rows_deleted: u64,
    pub errors_written: u64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DirtyPublicHistoryAccount {
    pub account_id: String,
    pub dirty_since: DateTime<Utc>,
    pub recompute_from: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SilverTransferLegRow {
    pub id: i64,
    pub account_id: String,
    pub leg_key: String,
    pub proposal_ref: Option<i64>,
    pub proposal_id: Option<i64>,
    pub transaction_hash: Option<String>,
    pub receipt_id: Option<String>,
    pub block_height: i64,
    pub block_time: DateTime<Utc>,
    pub token_standard: String,
    pub token_id: String,
    pub direction: String,
    pub counterparty: Option<String>,
    pub amount_raw: BigDecimal,
    pub amount: BigDecimal,
    pub decimals: i32,
    pub leg_kind: String,
    pub raw_payload: Value,
    pub proposal_status: Option<String>,
    pub proposal_created_at: Option<DateTime<Utc>>,
    pub proposal_executed_at: Option<DateTime<Utc>>,
    pub proposal_execution_block_height: Option<i64>,
    pub proposal_execution_transaction_hash: Option<String>,
    pub quote_metadata: Option<Value>,
    pub quote_deposit_address: Option<String>,
}
