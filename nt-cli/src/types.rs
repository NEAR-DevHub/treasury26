use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeResponse {
    /// Unique message the wallet authorizes via NEP-641 `resolveAuth`.
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub account_id: String,
    /// JSON-stringified NEP-641 authorization blob. For key-based signing this
    /// is a NEP-413 `SignedMessage` the backend verifies as the fallback path.
    pub authorization: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub account_id: String,
    pub terms_accepted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreasuryConfig {
    pub metadata: Option<TreasuryMetadata>,
    pub name: Option<String>,
    pub purpose: Option<String>,
    pub is_confidential: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreasuryMetadata {
    #[serde(default)]
    pub primary_color: Option<String>,
    #[serde(default)]
    pub flag_logo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Treasury {
    pub dao_id: String,
    pub config: TreasuryConfig,
    pub is_member: bool,
    pub is_saved: bool,
    pub is_hidden: bool,
    pub is_confidential: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimplifiedToken {
    pub id: String,
    pub contract_id: Option<String>,
    #[serde(default)]
    pub lockup_instance_id: Option<String>,
    #[serde(default)]
    pub ft_lockup_schedule: Option<serde_json::Value>,
    pub residency: TokenResidency,
    pub network: String,
    pub chain_name: String,
    pub symbol: String,
    pub balance: Balance,
    pub decimals: u8,
    pub price: String,
    pub name: String,
    pub icon: Option<String>,
    #[serde(default)]
    pub chain_icons: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum TokenResidency {
    Near,
    Ft,
    Intents,
    Lockup,
    Staked,
}

impl std::fmt::Display for TokenResidency {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Near => write!(f, "NEAR"),
            Self::Ft => write!(f, "FT"),
            Self::Intents => write!(f, "Intents"),
            Self::Lockup => write!(f, "Lockup"),
            Self::Staked => write!(f, "Staked"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Balance {
    Standard { total: String, locked: String },
    Staked(StakingBalance),
    Vested(LockupBalance),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StakingBalance {
    pub staked_balance: String,
    pub unstaked_balance: String,
    pub can_withdraw: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockupBalance {
    pub total: String,
    pub locked: String,
    pub liquid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: u64,
    pub proposer: String,
    pub description: String,
    pub kind: serde_json::Value,
    pub status: ProposalStatus,
    #[serde(default)]
    pub vote_counts: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub votes: HashMap<String, Vote>,
    #[serde(default)]
    pub submission_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ProposalStatus {
    InProgress,
    Approved,
    Rejected,
    Removed,
    Expired,
    Moved,
    Failed,
}

impl std::fmt::Display for ProposalStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InProgress => write!(f, "In Progress"),
            Self::Approved => write!(f, "Approved"),
            Self::Rejected => write!(f, "Rejected"),
            Self::Removed => write!(f, "Removed"),
            Self::Expired => write!(f, "Expired"),
            Self::Moved => write!(f, "Moved"),
            Self::Failed => write!(f, "Failed"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Vote {
    Approve,
    Reject,
    Remove,
}

impl std::fmt::Display for Vote {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Approve => write!(f, "Approve"),
            Self::Reject => write!(f, "Reject"),
            Self::Remove => write!(f, "Remove"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaginatedProposals {
    pub proposals: Vec<Proposal>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressBookEntry {
    pub id: uuid::Uuid,
    pub dao_id: String,
    pub name: String,
    pub networks: Vec<String>,
    pub address: String,
    pub note: Option<String>,
    pub created_by: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyRole {
    pub name: String,
    pub kind: serde_json::Value,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub vote_policy: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Policy {
    pub roles: Vec<PolicyRole>,
    #[serde(default)]
    pub default_vote_policy: serde_json::Value,
    pub proposal_bond: Option<String>,
    pub proposal_period: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeNetwork {
    /// Intents token id of the asset on this network (e.g. `nep141:eth.omft.near`).
    /// Doubles as the `destinationAsset` for DESTINATION_CHAIN quotes.
    pub id: String,
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    #[serde(default)]
    pub min_deposit_amount: Option<String>,
    #[serde(default)]
    pub min_withdrawal_amount: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeAsset {
    pub id: String,
    pub name: String,
    pub networks: Vec<BridgeNetwork>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeAssetsResponse {
    pub assets: Vec<BridgeAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentActivityResponse {
    pub data: Vec<BalanceChange>,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceChange {
    pub id: i64,
    pub block_time: String,
    pub token_id: String,
    #[serde(default)]
    pub token_metadata: Option<serde_json::Value>,
    pub counterparty: Option<String>,
    pub signer_id: Option<String>,
    pub receiver_id: Option<String>,
    pub amount: serde_json::Value,
    #[serde(default)]
    pub transaction_hashes: Vec<String>,
    #[serde(default)]
    pub receipt_ids: Vec<String>,
    pub value_usd: Option<f64>,
    #[serde(default)]
    pub swap: Option<serde_json::Value>,
    pub action_kind: Option<String>,
    pub method_name: Option<String>,
}
