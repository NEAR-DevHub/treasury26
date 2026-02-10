use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::prelude::BASE64_STANDARD;
use borsh::{BorshDeserialize, BorshSerialize};

use near_api::errors::QueryError;
use near_api::types::BlockHeight;
use near_api::types::ft::FungibleTokenMetadata;
use near_api::types::json::{U64, U128};
use near_api::{AccountId, Contract, CryptoHash, NetworkConfig, Reference, Tokens, W_NEAR_BALANCE};
use near_openapi_types::RpcQueryError;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::json;
use std::collections::HashMap;

use crate::utils::cache::{Cache, CacheKey, CacheTier};

#[derive(Serialize, Deserialize, BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct TxMetadata {
    pub signer_id: AccountId,
    pub predecessor_id: AccountId,
    pub reciept_hash: CryptoHash,
    pub block_height: BlockHeight,
    pub timestamp: u64,
}

const PROPOSAL_LIMIT: u64 = 500;

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
pub enum Vote {
    Approve,
    Reject,
    Remove,
}

#[derive(Debug, Deserialize, Serialize, BorshSerialize, BorshDeserialize, Clone, PartialEq, Eq)]
pub enum ProposalStatus {
    InProgress,
    Approved,
    Rejected,
    Removed,
    Expired,
    Moved,
    Failed,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
pub enum Action {
    AddProposal,
    RemoveProposal,
    VoteApprove,
    VoteReject,
    VoteRemove,
    Finalize,
    MoveToHub,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct ProposalLog {
    pub block_height: U64,
}

#[derive(BorshDeserialize, Clone, Debug)]
pub enum StateVersion {
    V1,
    V2,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(untagged)]
pub enum CountsVersions {
    // In actual contract u128 is used
    V1(u64),
    V2(U128),
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Proposal {
    pub id: u64,
    pub proposer: String,
    pub description: String,
    pub kind: Value,
    pub status: ProposalStatus,
    pub vote_counts: HashMap<String, [CountsVersions; 3]>,
    pub votes: HashMap<String, Vote>,
    pub submission_time: U64,
    pub last_actions_log: Option<Vec<ProposalLog>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Policy {
    pub roles: Vec<Value>,
    pub default_vote_policy: Value,
    pub proposal_bond: String, // u128
    pub proposal_period: U64,
    pub bounty_bond: String, //u128
    pub bounty_forgiveness_period: U64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ActionLog {
    pub account_id: AccountId,
    pub proposal_id: U64,
    pub action: Action,
    pub block_height: U64,
}

pub async fn fetch_proposals(
    client: &NetworkConfig,
    dao_id: &AccountId,
) -> Result<Vec<Proposal>, QueryError<RpcQueryError>> {
    // Get the last proposal ID
    let last_id = Contract(dao_id.clone())
        .call_function("get_last_proposal_id", ())
        .read_only::<u64>()
        .fetch_from(client)
        .await?
        .data;
    let mut all_proposals = Vec::new();
    let mut current_index = 0;

    // Fetch proposals in batches
    while current_index < last_id {
        let limit = std::cmp::min(PROPOSAL_LIMIT, last_id - current_index);
        let proposals_batch = Contract(dao_id.clone())
            .call_function(
                "get_proposals",
                json!({ "from_index": current_index, "limit": limit }),
            )
            .read_only::<Vec<Proposal>>()
            .fetch_from(client)
            .await?
            .data;
        all_proposals.extend(proposals_batch);
        current_index += limit;

        // Add a small delay to avoid hitting rate limits
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }

    Ok(all_proposals)
}

pub async fn fetch_proposal(
    client: &NetworkConfig,
    dao_id: &AccountId,
    proposal_id: u64,
) -> Result<Proposal, QueryError<RpcQueryError>> {
    let request = Contract(dao_id.clone())
        .call_function("get_proposal", json!({ "id": proposal_id }))
        .read_only::<Proposal>()
        .fetch_from(client)
        .await?;
    Ok(request.data)
}

pub async fn fetch_proposal_at_block(
    client: &NetworkConfig,
    dao_id: &AccountId,
    proposal_id: u64,
    block_height: u64,
) -> Result<Proposal, QueryError<RpcQueryError>> {
    Ok(Contract(dao_id.clone())
        .call_function("get_proposal", json!({ "id": proposal_id }))
        .read_only::<Proposal>()
        .at(Reference::AtBlock(block_height))
        .fetch_from(client)
        .await?
        .data)
}

pub async fn fetch_policy(
    client: &NetworkConfig,
    dao_id: &AccountId,
) -> Result<Policy, QueryError<RpcQueryError>> {
    Ok(Contract(dao_id.clone())
        .call_function("get_policy", ())
        .read_only::<Policy>()
        .fetch_from(client)
        .await?
        .data)
}

pub async fn fetch_contract_version(
    client: &NetworkConfig,
    dao_id: &AccountId,
) -> Result<StateVersion, Box<dyn std::error::Error + Send + Sync>> {
    let state = Contract(dao_id.clone())
        .view_storage_with_prefix("STATEVERSION".as_bytes())
        .fetch_from(client)
        .await?
        .data;

    if let Some(value) = state.values.first() {
        let version = StateVersion::try_from_slice(&BASE64_STANDARD.decode(&value.value.0)?)?;
        Ok(version)
    } else {
        Ok(StateVersion::V1)
    }
}

pub async fn fetch_actions_log(
    client: &NetworkConfig,
    dao_id: &AccountId,
) -> Option<Vec<ActionLog>> {
    Contract(dao_id.clone())
        .call_function("get_actions_log", ())
        .read_only::<Vec<ActionLog>>()
        .fetch_from(client)
        .await
        .ok()
        .map(|r| r.data)
}

pub async fn fetch_ft_metadata(
    cache: &Cache,
    network: &NetworkConfig,
    contract_id: &AccountId,
) -> Result<FungibleTokenMetadata, Box<dyn std::error::Error + Send + Sync>> {
    let cache_key = CacheKey::new("ft-metadata-filters")
        .with(contract_id.to_string())
        .build();
    let ft_metadata = cache
        .cached_contract_call(CacheTier::LongTerm, cache_key, async move {
            if contract_id == "near" {
                return Ok(FungibleTokenMetadata {
                    decimals: 24,
                    name: "Near".to_string(),
                    symbol: "NEAR".to_string(),
                    icon: None,
                    reference: None,
                    reference_hash: None,
                    spec: "".to_string(),
                });
            }
            Tokens::ft_metadata(contract_id.clone())
                .fetch_from(network)
                .await
                .map(|r| r.data)
        })
        .await
        .map_err(|e| e.1)?;
    Ok(ft_metadata)
}

pub async fn fetch_batch_payment_list(
    network: &NetworkConfig,
    batch_id: &str,
    bulk_payment_contract_id: &AccountId,
) -> Result<BatchPaymentResponse, QueryError<RpcQueryError>> {
    Contract(bulk_payment_contract_id.clone())
        .call_function(
            "view_list",
            json!({
                "list_id": batch_id,
            }),
        )
        .read_only::<BatchPaymentResponse>()
        .fetch_from(network)
        .await
        .map(|r| r.data)
}

pub fn extract_from_description(desc: &str, key: &str) -> Option<String> {
    let key_normalized = key.to_lowercase().replace(' ', "");

    // Early return for description key
    if key_normalized == "description" {
        return Some(desc.to_string());
    }

    // 1) Try parsing JSON (only if description looks like JSON)
    if desc.trim().starts_with('{')
        && desc.trim().ends_with('}')
        && let Ok(json_val) = serde_json::from_str::<serde_json::Value>(desc)
        && let Some(obj) = json_val.as_object()
    {
        for (k, v) in obj {
            if k.to_lowercase().replace(' ', "") == key_normalized {
                return v
                    .as_str()
                    .map(|s| s.to_string())
                    .or_else(|| Some(v.to_string()));
            }
        }
    }

    // 2) Parse lines split by newlines or <br>
    let lines = desc
        .split(['\n', '\r'])
        .flat_map(|line| line.split("<br>"))
        .map(|line| line.trim());

    for line in lines {
        if line.starts_with('*') {
            let line_content = line.trim_start_matches('*').trim();
            if let Some(pos) = line_content.find(':') {
                let key_part = line_content[..pos].trim().to_lowercase().replace(' ', "");
                let val = line_content[pos + 1..].trim();
                if key_part == key_normalized {
                    return Some(val.to_string());
                }
            }
        }
    }

    None
}

fn get_current_time_nanos() -> U64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards")
        .as_nanos();

    U64::from(nanos as u64)
}

pub fn get_status_display(
    status: &ProposalStatus,
    submission_time: u64,
    period: u64,
    pending_label: &str,
) -> String {
    match status {
        ProposalStatus::InProgress => {
            let current_time = get_current_time_nanos().0;
            if submission_time + period < current_time {
                "Expired".to_string()
            } else {
                pending_label.to_string()
            }
        }
        _ => format!("{:?}", status),
    }
}

pub trait ProposalType {
    /// Attempts to extract proposal-specific information from a proposal.
    /// Returns None if the proposal doesn't match this type.
    fn from_proposal(proposal: &Proposal) -> Option<Self>
    where
        Self: Sized;

    /// Returns the category name as a string constant.
    fn category_name() -> &'static str;
}

/// Trait for payment-related proposals that need to distinguish bulk payments from regular payments
pub trait PaymentProposalType {
    /// Attempts to extract proposal-specific information from a proposal.
    /// Takes the bulk payment contract ID to filter out bulk payment proposals.
    /// Returns None if the proposal doesn't match this type.
    fn from_proposal(
        proposal: &Proposal,
        bulk_payment_contract_id: Option<&AccountId>,
    ) -> Option<Self>
    where
        Self: Sized;

    /// Returns the category name as a string constant.
    fn category_name() -> &'static str;
}

#[derive(Debug, Clone)]
pub struct PaymentInfo {
    pub receiver: String,
    pub token: String,
    pub amount: String,
    pub is_lockup: bool,
}

#[derive(Debug, Clone)]
pub struct LockupInfo {
    pub amount: String,
    pub receiver: AccountId,
}

#[derive(Debug, Clone)]
pub struct BulkPayment {
    pub token_id: String,
    pub total_amount: String,
    pub batch_id: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct BatchPayment {
    pub recipient: AccountId,
    pub amount: String,
    pub status: serde_json::Value,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchPaymentResponse {
    pub token_id: String, // supports Intents format (nep141:xxx)
    pub submitter: AccountId,
    pub status: String,
    pub payments: Vec<BatchPayment>,
}
#[derive(Debug, Clone)]
pub struct AssetExchangeInfo {
    pub token_in_address: String,
    pub amount_in: u128,
    pub token_out_symbol: String,
    pub amount_out: String,
    pub deposit_address: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StakeDelegationInfo {
    pub amount: String,
    pub proposal_type: String,
    pub validator: AccountId,
}

impl PaymentProposalType for PaymentInfo {
    fn from_proposal(
        proposal: &Proposal,
        bulk_payment_contract_id: Option<&AccountId>,
    ) -> Option<Self> {
        if proposal.kind.get("Transfer").is_none() && proposal.kind.get("FunctionCall").is_none() {
            return None;
        }

        // Transfer kind
        if let Some(transfer_val) = proposal.kind.get("Transfer") {
            let token = transfer_val
                .get("token_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let amount = transfer_val
                .get("amount")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let receiver = transfer_val
                .get("receiver_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            return Some(PaymentInfo {
                receiver,
                token,
                amount,
                is_lockup: false,
            });
        }
        // FunctionCall kind
        if let Some(function_call) = proposal.kind.get("FunctionCall") {
            let receiver_id = function_call
                .get("receiver_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let actions: &[serde_json::Value] = function_call
                .get("actions")
                .and_then(|a| a.as_array())
                .map(|a| a.as_slice())
                .unwrap_or(&[]);

            // Check for approve_list or ft_transfer_call/mt_transfer_call to bulk payment contract
            if let Some(bulk_contract_id) = bulk_payment_contract_id {
                let is_bulk_payment = actions.iter().any(|action| {
                    let method_name = action
                        .get("method_name")
                        .and_then(|m| m.as_str())
                        .unwrap_or("");

                    // For approve_list to bulk payment contract
                    if method_name == "approve_list" {
                        return receiver_id == bulk_contract_id.as_str();
                    }

                    // For ft_transfer_call or mt_transfer_call, check if receiver_id in args is bulk payment contract
                    if (method_name == "ft_transfer_call" || method_name == "mt_transfer_call")
                        && let Some(args_b64) = action.get("args").and_then(|a| a.as_str())
                        && let Ok(decoded) =
                            base64::engine::general_purpose::STANDARD.decode(args_b64)
                        && let Ok(json_args) = serde_json::from_slice::<serde_json::Value>(&decoded)
                        && let Some(args_receiver) =
                            json_args.get("receiver_id").and_then(|r| r.as_str())
                        && args_receiver == bulk_contract_id.as_str()
                    {
                        return true;
                    }

                    false
                });

                if is_bulk_payment {
                    return None;
                }
            }

            // Intents payment
            if receiver_id == "intents.near"
                && actions
                    .first()
                    .and_then(|a| a.get("method_name"))
                    .and_then(|m| m.as_str())
                    == Some("ft_withdraw")
                && let Some(args_b64) = actions
                    .first()
                    .and_then(|a| a.get("args"))
                    .and_then(|a| a.as_str())
                && let Ok(decoded_bytes) =
                    base64::engine::general_purpose::STANDARD.decode(args_b64)
                && let Ok(json_args) = serde_json::from_slice::<serde_json::Value>(&decoded_bytes)
            {
                let token = json_args
                    .get("token")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let amount = json_args
                    .get("amount")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let receiver = if let Some(memo) = json_args.get("memo").and_then(|v| v.as_str()) {
                    if memo.contains("WITHDRAW_TO:") {
                        memo.split("WITHDRAW_TO:").nth(1).unwrap_or("").to_string()
                    } else {
                        json_args
                            .get("receiver_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string()
                    }
                } else {
                    json_args
                        .get("receiver_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string()
                };
                return Some(PaymentInfo {
                    receiver,
                    token,
                    amount,
                    is_lockup: false,
                });
            }
            // Lockup contract transfer
            let method_name = actions
                .first()
                .and_then(|a| a.get("method_name"))
                .and_then(|m| m.as_str())
                .unwrap_or("");
            if method_name == "transfer"
                && receiver_id.contains("lockup.near")
                && let Some(args_b64) = actions
                    .first()
                    .and_then(|a| a.get("args"))
                    .and_then(|a| a.as_str())
                && let Ok(decoded_bytes) =
                    base64::engine::general_purpose::STANDARD.decode(args_b64)
                && let Ok(json_args) = serde_json::from_slice::<serde_json::Value>(&decoded_bytes)
            {
                let token = json_args
                    .get("token_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let amount = json_args
                    .get("amount")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let receiver = json_args
                    .get("receiver_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                return Some(PaymentInfo {
                    receiver,
                    token,
                    amount,
                    is_lockup: true,
                });
            }

            // NEARN requests: storage_deposit + ft_transfer
            if actions.len() >= 2
                && actions
                    .first()
                    .and_then(|a| a.get("method_name"))
                    .and_then(|m| m.as_str())
                    == Some("storage_deposit")
                && actions
                    .get(1)
                    .and_then(|a| a.get("method_name"))
                    .and_then(|m| m.as_str())
                    == Some("ft_transfer")
            {
                let token = receiver_id.to_string();
                if let Some(args_b64) = actions
                    .get(1)
                    .and_then(|a| a.get("args"))
                    .and_then(|a| a.as_str())
                    && let Ok(decoded_bytes) =
                        base64::engine::general_purpose::STANDARD.decode(args_b64)
                    && let Ok(json_args) =
                        serde_json::from_slice::<serde_json::Value>(&decoded_bytes)
                {
                    let receiver = json_args
                        .get("receiver_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let amount = json_args
                        .get("amount")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    return Some(PaymentInfo {
                        receiver,
                        token,
                        amount,
                        is_lockup: false,
                    });
                }
            }
            // Standard ft_transfer
            if matches!(
                actions
                    .first()
                    .and_then(|a| a.get("method_name"))
                    .and_then(|m| m.as_str()),
                Some("ft_transfer")
                    | Some("ft_transfer_call")
                    | Some("mt_transfer")
                    | Some("mt_transfer_call")
            ) {
                let token = receiver_id.to_string();
                if let Some(args_b64) = actions
                    .first()
                    .and_then(|a| a.get("args"))
                    .and_then(|a| a.as_str())
                    && let Ok(decoded_bytes) =
                        base64::engine::general_purpose::STANDARD.decode(args_b64)
                    && let Ok(json_args) =
                        serde_json::from_slice::<serde_json::Value>(&decoded_bytes)
                {
                    let receiver = json_args
                        .get("receiver_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let amount = json_args
                        .get("amount")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    return Some(PaymentInfo {
                        receiver,
                        token,
                        amount,
                        is_lockup: false,
                    });
                }
            }
        }
        None
    }

    fn category_name() -> &'static str {
        "payments"
    }
}

impl ProposalType for LockupInfo {
    fn from_proposal(proposal: &Proposal) -> Option<Self> {
        if let Some(function_call) = proposal.kind.get("FunctionCall") {
            let receiver_id = function_call
                .get("receiver_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let actions = function_call.get("actions").and_then(|a| a.as_array())?;
            let first_action = actions.first()?;

            let method_name = first_action
                .get("method_name")
                .and_then(|m| m.as_str())
                .unwrap_or("");

            if receiver_id.contains("lockup.near") && method_name == "create" {
                // Extract amount from deposit
                let amount = first_action
                    .get("deposit")
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string();

                // Decode args to get receiver (owner_account_id)
                let args_b64 = first_action.get("args").and_then(|a| a.as_str())?;
                let decoded_bytes = base64::engine::general_purpose::STANDARD
                    .decode(args_b64)
                    .ok()?;
                let json_args = serde_json::from_slice::<serde_json::Value>(&decoded_bytes).ok()?;

                let receiver = json_args
                    .get("owner_account_id")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<AccountId>().ok())?;

                return Some(LockupInfo { amount, receiver });
            }
        }
        None
    }

    fn category_name() -> &'static str {
        "lockup"
    }
}

impl ProposalType for AssetExchangeInfo {
    fn from_proposal(proposal: &Proposal) -> Option<Self> {
        if let Some(function_call) = proposal.kind.get("FunctionCall") {
            let actions = function_call
                .get("actions")
                .and_then(|a| a.as_array())
                .map(|a| a.as_slice())
                .unwrap_or(&[]);

            let receiver_id = function_call
                .get("receiver_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if receiver_id == "wrap.near"
                && let Some(action) = actions.iter().find(|a| {
                    a.get("method_name")
                        .and_then(|m| m.as_str())
                        .map(|m| m == "near_deposit" || m == "near_withdraw")
                        .unwrap_or(false)
                })
            {
                let is_wrap = action
                    .get("method_name")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    == "near_deposit";
                // Decode the args
                let args_b64 = action.get("args").and_then(|a| a.as_str())?;
                let decoded_bytes = base64::engine::general_purpose::STANDARD
                    .decode(args_b64)
                    .ok()?;
                let json_args = serde_json::from_slice::<serde_json::Value>(&decoded_bytes).ok()?;

                if is_wrap {
                    let near_token: U128 = U128::from(
                        action
                            .get("deposit")
                            .and_then(|v| v.as_str())
                            .unwrap_or("0")
                            .parse::<u128>()
                            .unwrap_or_default(),
                    );

                    return Some(AssetExchangeInfo {
                        token_in_address: "wrap.near".to_string(),
                        amount_in: near_token.0,
                        token_out_symbol: "near".to_string(),
                        amount_out: W_NEAR_BALANCE
                            .with_amount(near_token.0)
                            .to_string()
                            .split(' ')
                            .nth(0)
                            .unwrap_or_default()
                            .to_string(),
                        deposit_address: None,
                    });
                } else {
                    let near_token: U128 = U128::from(
                        json_args
                            .get("amount")
                            .and_then(|v| v.as_str())
                            .unwrap_or("0")
                            .parse::<u128>()
                            .unwrap_or_default(),
                    );

                    return Some(AssetExchangeInfo {
                        token_in_address: "wrap.near".to_string(),
                        amount_in: near_token.0,
                        token_out_symbol: "near".to_string(),
                        amount_out: W_NEAR_BALANCE
                            .with_amount(near_token.0)
                            .to_string()
                            .split(' ')
                            .nth(0)
                            .unwrap_or("0")
                            .to_string(),
                        deposit_address: None,
                    });
                }
            } else if extract_from_description(&proposal.description, "proposalaction")
                == Some("asset-exchange".to_string())
            {
                // Find mt_transfer or mt_transfer_call action
                let action = actions.iter().find(|a| {
                    a.get("method_name")
                        .and_then(|m| m.as_str())
                        .map(|m| {
                            m == "mt_transfer"
                                || m == "mt_transfer_call"
                                || m == "ft_transfer"
                                || m == "ft_transfer_call"
                        })
                        .unwrap_or(false)
                })?;
                // Decode the args
                let args_b64 = action.get("args").and_then(|a| a.as_str())?;
                let decoded_bytes = base64::engine::general_purpose::STANDARD
                    .decode(args_b64)
                    .ok()?;
                let json_args = serde_json::from_slice::<serde_json::Value>(&decoded_bytes).ok()?;

                // Extract token_in from args
                let token_in_address = json_args
                    .get("token_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or(
                        function_call
                            .get("receiver_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or(""),
                    )
                    .to_string();
                if proposal.id == 457 {
                    println!("token_in_address: {:?}", token_in_address);
                }

                // Extract amount_in from args or description
                let amount_in = json_args
                    .get("amount")
                    .and_then(|v| v.as_str().map(|s| s.parse::<u128>().unwrap_or(0)))
                    .or_else(|| {
                        extract_from_description(&proposal.description, "amountIn")
                            .map(|s| s.parse::<u128>().unwrap_or(0))
                    })
                    .unwrap_or(0);
                if proposal.id == 457 {
                    println!("amount_in: {:?}", amount_in);
                }

                // Extract token_out from description
                let token_out_symbol =
                    extract_from_description(&proposal.description, "tokenOut").unwrap_or_default();

                // Extract amount_out from description
                let amount_out = extract_from_description(&proposal.description, "amountOut")
                    .unwrap_or_else(|| "0".to_string());
                if proposal.id == 457 {
                    println!("json_args: {:?}", json_args);
                }

                // Extract deposit_address from args
                let deposit_address = json_args
                    .get("receiver_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if proposal.id == 457 {
                    println!("proposal id: {}", proposal.id);
                    println!("token_in_address: {:?}", token_in_address);
                    println!("amount_in: {:?}", amount_in);
                    println!("token_out_symbol: {:?}", token_out_symbol);
                    println!("amount_out: {:?}", amount_out);
                    println!("deposit_address: {:?}", deposit_address);
                }

                return Some(AssetExchangeInfo {
                    token_in_address,
                    amount_in,
                    token_out_symbol,
                    amount_out,
                    deposit_address,
                });
            }
        }
        None
    }

    fn category_name() -> &'static str {
        "asset-exchange"
    }
}

impl ProposalType for StakeDelegationInfo {
    fn from_proposal(proposal: &Proposal) -> Option<Self> {
        if let Some(function_call) = proposal.kind.get("FunctionCall") {
            let proposal_action = extract_from_description(&proposal.description, "proposalaction");
            let is_stake_request =
                extract_from_description(&proposal.description, "isStakeRequest").is_some()
                    || matches!(
                        proposal_action.as_deref(),
                        Some("stake") | Some("unstake") | Some("withdraw")
                    );

            if is_stake_request {
                let receiver_account = function_call
                    .get("receiver_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let actions = function_call.get("actions").and_then(|v| v.as_array())?;

                let action = actions.first()?;
                let method_name = action
                    .get("method_name")
                    .and_then(|m| m.as_str())
                    .unwrap_or("");

                let mut validator_account = receiver_account.parse::<AccountId>().ok()?;
                let mut amount = action
                    .get("deposit")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                // Extract amount from args for unstake/withdraw
                let args_b64 = action.get("args").and_then(|a| a.as_str()).unwrap_or("");
                if let Ok(decoded_bytes) =
                    base64::engine::general_purpose::STANDARD.decode(args_b64)
                    && let Ok(json) = serde_json::from_slice::<serde_json::Value>(&decoded_bytes)
                {
                    if let Some(val) = json.get("amount").and_then(|v| v.as_str()) {
                        amount = val.to_string();
                    }
                    // Only extract validator from args if it's a select_staking_pool call
                    if method_name == "select_staking_pool"
                        && let Some(val) =
                            json.get("staking_pool_account_id").and_then(|v| v.as_str())
                    {
                        validator_account = val.parse::<AccountId>().ok()?;
                    }
                }

                // Handle withdraw amount from description
                if (method_name == "withdraw_all"
                    || method_name == "withdraw_all_from_staking_pool")
                    && let Some(withdraw_amount) =
                        extract_from_description(&proposal.description, "amount")
                {
                    amount = withdraw_amount;
                }

                let proposal_type = if method_name == "unstake" {
                    "unstake"
                } else if method_name == "deposit_and_stake" {
                    "stake"
                } else if method_name == "withdraw_all"
                    || method_name == "withdraw_all_from_staking_pool"
                {
                    "withdraw"
                } else if method_name == "select_staking_pool" {
                    "whitelist"
                } else {
                    "unknown"
                };

                return Some(StakeDelegationInfo {
                    amount,
                    proposal_type: proposal_type.to_string(),
                    validator: validator_account,
                });
            }
        }
        None
    }

    fn category_name() -> &'static str {
        "stake-delegation"
    }
}

impl BulkPayment {
    /// Helper method to extract bulk payment info with a given contract ID
    pub fn from_proposal_with_contract_id(
        proposal: &Proposal,
        bulk_payment_contract_id: &AccountId,
    ) -> Option<Self> {
        if let Some(function_call) = proposal.kind.get("FunctionCall") {
            let actions = function_call
                .get("actions")
                .and_then(|a| a.as_array())
                .map(|a| a.as_slice())
                .unwrap_or(&[]);

            // Find action with ft_transfer_call, mt_transfer_call, or approve_list method
            let action = actions.iter().find(|a| {
                let method_name = a.get("method_name").and_then(|m| m.as_str()).unwrap_or("");
                method_name == "ft_transfer_call"
                    || method_name == "mt_transfer_call"
                    || method_name == "approve_list"
            })?;

            // Decode args
            let args_b64 = action.get("args").and_then(|a| a.as_str())?;
            let decoded_bytes = base64::engine::general_purpose::STANDARD
                .decode(args_b64)
                .ok()?;
            let json_args = serde_json::from_slice::<serde_json::Value>(&decoded_bytes).ok()?;

            let method_name = action
                .get("method_name")
                .and_then(|m| m.as_str())
                .unwrap_or("");

            let (token_id, total_amount, batch_id) = if method_name == "approve_list" {
                let token_id = "near".to_string();
                let total_amount = action
                    .get("deposit")
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string();
                let batch_id = json_args
                    .get("list_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                (token_id, total_amount, batch_id)
            } else if method_name == "ft_transfer_call" || method_name == "mt_transfer_call" {
                // Check if receiver_id in args is the bulk payment contract
                let args_receiver_id = json_args
                    .get("receiver_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                // For ft_transfer_call/mt_transfer_call, the receiver_id in args should be bulk payment contract
                // If not, this is not a bulk payment proposal
                if args_receiver_id != bulk_payment_contract_id.as_str() {
                    return None;
                }

                // For ft_transfer_call/mt_transfer_call
                let token_id = function_call
                    .get("receiver_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let total_amount = json_args
                    .get("amount")
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string();
                let batch_id = json_args
                    .get("msg")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                (token_id, total_amount, batch_id)
            } else {
                return None;
            };

            Some(BulkPayment {
                token_id,
                total_amount,
                batch_id,
            })
        } else {
            None
        }
    }
}

impl ProposalType for BulkPayment {
    fn from_proposal(proposal: &Proposal) -> Option<Self> {
        // Use default contract ID from env or fallback
        // Note: For proper filtering, callers should use from_proposal_with_contract_id directly
        let bulk_payment_contract_id = std::env::var("BULK_PAYMENT_CONTRACT_ID")
            .unwrap_or_else(|_| "bulkpayment.near".to_string())
            .parse()
            .ok()?;

        BulkPayment::from_proposal_with_contract_id(proposal, &bulk_payment_contract_id)
    }

    fn category_name() -> &'static str {
        "bulk-payment"
    }
}
