//! Links DAO proposal receipts from bronze ingest into `dao_proposals`.
//!
//! Receipt roles are strict:
//! - `add_proposal` writes creation facts only.
//! - `act_proposal` (votes) never writes execution fields or an inferred
//!   status; it only triggers a live status refresh.
//! - `on_proposal_callback` is the sole execution signal: Sputnik fires it
//!   exactly once, in the execution block, only when an approved proposal's
//!   promise actually ran (the public analog of the confidential `sign:` log).
//!
//! Status comes exclusively from a live `get_proposal` fetch and is monotonic:
//! a terminal status is never downgraded to `in_progress`, so replayed or
//! out-of-order receipts (backfill walks newest→oldest) cannot regress a row.
//! Rows the RPC left stale converge via the reconciler (see `reconciler.rs`).

use std::collections::HashMap;
use std::sync::Arc;

use axum::http::StatusCode;
use base64::Engine;
use chrono::{DateTime, Utc};
use near_api::AccountId;
use near_jsonrpc_client::methods;
use near_primitives::{
    hash::CryptoHash,
    types::AccountId as RpcAccountId,
    views::{FinalExecutionOutcomeViewEnum, TxExecutionStatus},
};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};

use crate::AppState;
use crate::handlers::balance_changes::utils::with_transport_retry;
use crate::handlers::intents::confidential::gold::history_events::refresh_gold_metadata_for_intent;
use crate::handlers::intents::confidential::link_intent_to_history_event;
use crate::handlers::intents::swap_status::fetch_public_swap_status;
use crate::handlers::proposals::scraper::{
    ProposalStatus, extract_from_description, extract_payload_hash_from_kind, fetch_proposal,
};
use crate::handlers::public_history::bronze::store::BronzePublicHistoryEvent;
use crate::handlers::public_history::silver::cursors::mark_silver_dirty_tx;
use crate::utils::jsonrpc::create_rpc_client;

const PUBLIC_PROPOSAL_TX_STATUS_LABEL: &str = "public_proposal_tx_status";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProposalReceiptRole {
    Created,
    Voted,
    Executed,
}

#[derive(Debug, Clone)]
struct ProposalReceipt {
    dao_id: String,
    role: ProposalReceiptRole,
    proposal_id: Option<i64>,
    action: Option<String>,
}

/// All proposal receipts for one `(dao_id, proposal_id)` within a page,
/// collapsed so the proposal is fetched and upserted once.
#[derive(Debug)]
struct ProposalGroup<'a> {
    dao_id: String,
    proposal_id: i64,
    created: Option<&'a BronzePublicHistoryEvent>,
    executed: Option<&'a BronzePublicHistoryEvent>,
    vote_remove_succeeded: bool,
    earliest_block_time: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct PublicProposalDetails {
    status: Option<&'static str>,
    kind: Option<Value>,
    description: Option<String>,
}

/// Block/tx coordinates of a creation or execution receipt.
#[derive(Debug, Clone)]
struct ReceiptFacts {
    at: DateTime<Utc>,
    block_height: i64,
    transaction_hash: Option<String>,
    receipt_id: Option<String>,
}

impl ReceiptFacts {
    fn from_event(event: &BronzePublicHistoryEvent) -> Self {
        Self {
            at: event.block_time,
            block_height: event.block_height,
            transaction_hash: event.transaction_hash.clone(),
            receipt_id: event.receipt_id.clone(),
        }
    }
}

/// One merged write per proposal per page. `status: None` leaves the stored
/// status untouched; creation/execution facts are first-writer-wins because
/// each has exactly one authoritative receipt.
#[derive(Debug)]
struct DaoProposalUpsert<'a> {
    dao_id: &'a str,
    proposal_id: i64,
    status: Option<&'static str>,
    proposal_kind: Option<Value>,
    quote_metadata: Option<Value>,
    quote_deposit_address: Option<String>,
    creation: Option<ReceiptFacts>,
    execution: Option<ReceiptFacts>,
}

impl DaoProposalUpsert<'_> {
    /// Upserts the row and returns the merged `proposal_kind` so callers can
    /// mirror confidential proposals without a second read.
    async fn write(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<Option<Value>, sqlx::Error> {
        let row = sqlx::query_as::<_, (Option<Value>,)>(
            r#"
            INSERT INTO dao_proposals (
                dao_id,
                proposal_id,
                status,
                proposal_kind,
                quote_metadata,
                quote_deposit_address,
                proposal_created_at,
                proposal_creation_block_height,
                proposal_creation_transaction_hash,
                proposal_creation_receipt_id,
                proposal_executed_at,
                proposal_execution_block_height,
                proposal_execution_transaction_hash,
                proposal_execution_receipt_id,
                updated_at
            )
            VALUES (
                $1, $2, COALESCE($3::proposal_status, 'in_progress'),
                $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW()
            )
            ON CONFLICT (dao_id, proposal_id) DO UPDATE SET
                status = CASE
                    WHEN $3::proposal_status IS NULL THEN dao_proposals.status
                    WHEN dao_proposals.status <> 'in_progress'
                         AND $3::proposal_status = 'in_progress'
                        THEN dao_proposals.status
                    ELSE $3::proposal_status
                END,
                proposal_kind = COALESCE(
                    EXCLUDED.proposal_kind,
                    dao_proposals.proposal_kind
                ),
                quote_metadata = COALESCE(
                    EXCLUDED.quote_metadata,
                    dao_proposals.quote_metadata
                ),
                quote_deposit_address = COALESCE(
                    EXCLUDED.quote_deposit_address,
                    dao_proposals.quote_deposit_address
                ),
                proposal_created_at = COALESCE(
                    dao_proposals.proposal_created_at,
                    EXCLUDED.proposal_created_at
                ),
                proposal_creation_block_height = COALESCE(
                    dao_proposals.proposal_creation_block_height,
                    EXCLUDED.proposal_creation_block_height
                ),
                proposal_creation_transaction_hash = COALESCE(
                    dao_proposals.proposal_creation_transaction_hash,
                    EXCLUDED.proposal_creation_transaction_hash
                ),
                proposal_creation_receipt_id = COALESCE(
                    dao_proposals.proposal_creation_receipt_id,
                    EXCLUDED.proposal_creation_receipt_id
                ),
                proposal_executed_at = COALESCE(
                    dao_proposals.proposal_executed_at,
                    EXCLUDED.proposal_executed_at
                ),
                proposal_execution_block_height = COALESCE(
                    dao_proposals.proposal_execution_block_height,
                    EXCLUDED.proposal_execution_block_height
                ),
                proposal_execution_transaction_hash = COALESCE(
                    dao_proposals.proposal_execution_transaction_hash,
                    EXCLUDED.proposal_execution_transaction_hash
                ),
                proposal_execution_receipt_id = COALESCE(
                    dao_proposals.proposal_execution_receipt_id,
                    EXCLUDED.proposal_execution_receipt_id
                ),
                updated_at = NOW()
            RETURNING proposal_kind
            "#,
        )
        .bind(self.dao_id)
        .bind(self.proposal_id)
        .bind(self.status)
        .bind(&self.proposal_kind)
        .bind(&self.quote_metadata)
        .bind(&self.quote_deposit_address)
        .bind(self.creation.as_ref().map(|facts| facts.at))
        .bind(self.creation.as_ref().map(|facts| facts.block_height))
        .bind(
            self.creation
                .as_ref()
                .and_then(|facts| facts.transaction_hash.as_deref()),
        )
        .bind(
            self.creation
                .as_ref()
                .and_then(|facts| facts.receipt_id.as_deref()),
        )
        .bind(self.execution.as_ref().map(|facts| facts.at))
        .bind(self.execution.as_ref().map(|facts| facts.block_height))
        .bind(
            self.execution
                .as_ref()
                .and_then(|facts| facts.transaction_hash.as_deref()),
        )
        .bind(
            self.execution
                .as_ref()
                .and_then(|facts| facts.receipt_id.as_deref()),
        )
        .fetch_one(&mut **tx)
        .await?;

        Ok(row.0)
    }
}

pub(crate) fn proposal_status_as_str(status: &ProposalStatus) -> &'static str {
    match status {
        ProposalStatus::InProgress => "in_progress",
        ProposalStatus::Approved => "approved",
        ProposalStatus::Rejected => "rejected",
        ProposalStatus::Removed => "removed",
        ProposalStatus::Expired => "expired",
        ProposalStatus::Moved => "moved",
        ProposalStatus::Failed => "failed",
    }
}

fn decode_success_value_u64(status: &Value) -> Option<u64> {
    let encoded = status
        .get("SuccessValue")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let text = String::from_utf8(bytes).ok()?;
    text.trim().parse::<u64>().ok()
}

fn decode_success_value_i64(status: &Value) -> Option<i64> {
    decode_success_value_u64(status).and_then(|value| i64::try_from(value).ok())
}

fn action_args(event: &BronzePublicHistoryEvent) -> Option<&Value> {
    event.raw_payload.get("action")
}

fn receipt_status(event: &BronzePublicHistoryEvent) -> Option<&Value> {
    event
        .raw_payload
        .get("receipt")?
        .get("outcome")?
        .get("status")
}

fn decode_receipt(event: &BronzePublicHistoryEvent) -> Option<ProposalReceipt> {
    let method = event.method_name.as_deref()?;
    let dao_id = event.contract_account_id.clone()?;
    let args = action_args(event);
    let args_proposal_id = args.and_then(|args| {
        args.get("id")
            .or_else(|| args.get("proposal_id"))
            .and_then(Value::as_i64)
    });

    match method {
        "add_proposal" => Some(ProposalReceipt {
            dao_id,
            role: ProposalReceiptRole::Created,
            proposal_id: receipt_status(event)
                .and_then(decode_success_value_i64)
                .or(args_proposal_id),
            action: None,
        }),
        "act_proposal" => Some(ProposalReceipt {
            dao_id,
            role: ProposalReceiptRole::Voted,
            proposal_id: args_proposal_id,
            action: args
                .and_then(|args| args.get("action"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
        }),
        "on_proposal_callback" => {
            // A failed callback receipt executed nothing.
            if event.outcome_status == Some(false) {
                return None;
            }
            Some(ProposalReceipt {
                dao_id,
                role: ProposalReceiptRole::Executed,
                proposal_id: args_proposal_id,
                action: None,
            })
        }
        _ => None,
    }
}

fn receipt_predecessor_account_id(event: &BronzePublicHistoryEvent) -> Option<&str> {
    event
        .raw_payload
        .get("receipt")?
        .get("predecessor_account_id")?
        .as_str()
}

fn proposal_id_from_rpc_outcome(
    response: &methods::EXPERIMENTAL_tx_status::RpcTransactionResponse,
    receipt_id: CryptoHash,
) -> Result<i64, String> {
    let receipts_outcome = match &response.final_execution_outcome {
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(outcome)) => {
            &outcome.receipts_outcome
        }
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcomeWithReceipt(outcome)) => {
            &outcome.final_outcome.receipts_outcome
        }
        None => return Err("RPC response missing execution outcome".to_string()),
    };

    let receipt_outcome = receipts_outcome
        .iter()
        .find(|receipt| receipt.id == receipt_id)
        .ok_or_else(|| format!("RPC response missing outcome for receipt {}", receipt_id))?;

    serde_json::to_value(&receipt_outcome.outcome.status)
        .ok()
        .and_then(|status| decode_success_value_i64(&status))
        .ok_or_else(|| format!("receipt {} outcome did not contain proposal id", receipt_id))
}

async fn fetch_proposal_receipt_from_rpc(
    state: &AppState,
    event: &BronzePublicHistoryEvent,
) -> Result<methods::EXPERIMENTAL_tx_status::RpcTransactionResponse, String> {
    let tx_hash = event
        .transaction_hash
        .as_deref()
        .ok_or_else(|| "missing transaction_hash".to_string())?
        .parse::<CryptoHash>()
        .map_err(|error| format!("invalid transaction_hash: {}", error))?;
    let sender_account_id = receipt_predecessor_account_id(event)
        .ok_or_else(|| "missing receipt.predecessor_account_id".to_string())?
        .parse::<RpcAccountId>()
        .map_err(|error| format!("invalid receipt.predecessor_account_id: {}", error))?;
    let client = create_rpc_client(&state.archival_network).map_err(|error| error.to_string())?;

    with_transport_retry(PUBLIC_PROPOSAL_TX_STATUS_LABEL, || {
        let req = methods::EXPERIMENTAL_tx_status::RpcTransactionStatusRequest {
            transaction_info: methods::EXPERIMENTAL_tx_status::TransactionInfo::TransactionId {
                tx_hash,
                sender_account_id: sender_account_id.clone(),
            },
            wait_until: TxExecutionStatus::Final,
        };
        client.call(req)
    })
    .await
    .map_err(|error| error.to_string())
}

#[derive(Debug, Clone)]
struct RpcReceiptArgs {
    proposal_id: Option<i64>,
    action: Option<String>,
}

/// Decodes the FunctionCall args of one receipt from an `EXPERIMENTAL_tx_status`
/// response. Needed because NearBlocks' receipts endpoint returns actions
/// without args, so vote/callback proposal ids only exist on-chain.
fn receipt_args_from_rpc_response(
    response: &methods::EXPERIMENTAL_tx_status::RpcTransactionResponse,
    receipt_id: &str,
    method_name: &str,
) -> Result<RpcReceiptArgs, String> {
    let raw_response = serde_json::to_value(response)
        .map_err(|error| format!("failed to serialize RPC response: {}", error))?;
    let receipts = raw_response
        .get("receipts")
        .and_then(Value::as_array)
        .ok_or_else(|| "RPC response missing receipts".to_string())?;
    let receipt = receipts
        .iter()
        .find(|receipt| receipt.get("receipt_id").and_then(Value::as_str) == Some(receipt_id))
        .ok_or_else(|| format!("RPC response missing receipt {}", receipt_id))?;
    let actions = receipt
        .get("receipt")
        .and_then(|receipt| receipt.get("Action"))
        .and_then(|action| action.get("actions"))
        .and_then(Value::as_array)
        .ok_or_else(|| format!("RPC receipt {} missing actions", receipt_id))?;

    let function_call = actions
        .iter()
        .filter_map(|action| action.get("FunctionCall"))
        .find(|function_call| {
            function_call.get("method_name").and_then(Value::as_str) == Some(method_name)
        })
        .ok_or_else(|| format!("RPC receipt {} missing {} action", receipt_id, method_name))?;
    let args_b64 = function_call
        .get("args")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("RPC {} action missing args", method_name))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(args_b64)
        .map_err(|error| format!("failed to decode {} args: {}", method_name, error))?;
    let args: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("failed to parse {} args: {}", method_name, error))?;

    Ok(RpcReceiptArgs {
        proposal_id: args
            .get("id")
            .or_else(|| args.get("proposal_id"))
            .and_then(Value::as_i64),
        action: args
            .get("action")
            .and_then(Value::as_str)
            .map(ToString::to_string),
    })
}

async fn fetch_proposal_details(
    state: &AppState,
    dao_id: &str,
    proposal_id: i64,
) -> PublicProposalDetails {
    let Ok(account_id) = dao_id.parse::<AccountId>() else {
        return PublicProposalDetails {
            status: None,
            kind: None,
            description: None,
        };
    };
    let Ok(proposal_id) = u64::try_from(proposal_id) else {
        return PublicProposalDetails {
            status: None,
            kind: None,
            description: None,
        };
    };
    match fetch_proposal(&state.network, &account_id, proposal_id).await {
        Ok(proposal) => PublicProposalDetails {
            status: Some(proposal_status_as_str(&proposal.status)),
            kind: Some(proposal.kind),
            description: Some(proposal.description),
        },
        Err(e) => {
            tracing::warn!(
                dao_id = dao_id,
                proposal_id = proposal_id,
                error = ?e,
                "failed to fetch proposal for public history linker"
            );
            PublicProposalDetails {
                status: None,
                kind: None,
                description: None,
            }
        }
    }
}

fn proposal_kind_from_raw_add(event: &BronzePublicHistoryEvent) -> Option<Value> {
    action_args(event)?.get("proposal")?.get("kind").cloned()
}

fn proposal_description_from_raw_add(event: &BronzePublicHistoryEvent) -> Option<String> {
    action_args(event)?
        .get("proposal")?
        .get("description")?
        .as_str()
        .map(ToString::to_string)
}

fn transfer_receiver_from_kind(kind: &Value) -> Option<String> {
    let actions = kind.get("FunctionCall")?.get("actions")?.as_array()?;
    for action in actions {
        let method = action.get("method_name")?.as_str()?;
        if !matches!(
            method,
            "ft_transfer" | "ft_transfer_call" | "mt_transfer" | "mt_transfer_call"
        ) {
            continue;
        }
        let args_b64 = action.get("args")?.as_str()?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(args_b64)
            .ok()?;
        let args: Value = serde_json::from_slice(&bytes).ok()?;
        if let Some(receiver_id) = args.get("receiver_id").and_then(Value::as_str) {
            return Some(receiver_id.to_string());
        }
    }
    None
}

fn exchange_deposit_address(description: Option<&str>, kind: Option<&Value>) -> Option<String> {
    let description = description?;
    if extract_from_description(description, "proposalaction").as_deref() != Some("asset-exchange")
    {
        return None;
    }
    extract_from_description(description, "depositAddress")
        .or_else(|| extract_from_description(description, "Deposit Address"))
        .or_else(|| kind.and_then(transfer_receiver_from_kind))
}

async fn fetch_quote_metadata_for_deposit(
    state: &AppState,
    dao_id: &str,
    proposal_id: i64,
    deposit_address: &str,
) -> Option<Value> {
    match fetch_public_swap_status(
        &state.http_client,
        &state.env_vars.oneclick_api_url,
        state.env_vars.oneclick_jwt_token.as_ref(),
        deposit_address,
        None,
    )
    .await
    {
        Ok(response) => serde_json::to_value(response).ok(),
        Err((status, reason)) => {
            tracing::warn!(
                dao_id = dao_id,
                proposal_id = proposal_id,
                deposit_address = deposit_address,
                status = %status,
                reason = %reason,
                "failed to fetch 1Click status for public exchange proposal"
            );
            None
        }
    }
}

async fn mirror_confidential_proposal_created(
    pool: &PgPool,
    dao_id: &str,
    payload_hash: &str,
    proposal_id: i64,
    proposal_created_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE confidential_intents
        SET proposal_id = COALESCE(proposal_id, $3),
            proposal_created_at = COALESCE(proposal_created_at, $4),
            updated_at = NOW()
        WHERE dao_id = $1
          AND payload_hash = $2
        "#,
    )
    .bind(dao_id)
    .bind(payload_hash)
    .bind(proposal_id)
    .bind(proposal_created_at)
    .execute(pool)
    .await?;

    if let Some(history_event_id) = link_intent_to_history_event(pool, dao_id, payload_hash).await?
    {
        tracing::info!(
            dao_id = dao_id,
            payload_hash = payload_hash,
            history_event_id = history_event_id,
            "linked confidential intent from public proposal linker"
        );
    }
    refresh_gold_metadata_for_intent(pool, dao_id, payload_hash).await?;
    Ok(())
}

async fn mirror_confidential_proposal_executed(
    pool: &PgPool,
    dao_id: &str,
    payload_hash: &str,
    proposal_executed_at: DateTime<Utc>,
    block_height: i64,
    transaction_hash: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE confidential_intents
        SET status = 'submitted',
            proposal_executed_at = COALESCE(proposal_executed_at, $3),
            proposal_execution_block_height = COALESCE(proposal_execution_block_height, $4),
            proposal_execution_transaction_hash = COALESCE(proposal_execution_transaction_hash, $5),
            updated_at = NOW()
        WHERE dao_id = $1
          AND payload_hash = $2
        "#,
    )
    .bind(dao_id)
    .bind(payload_hash)
    .bind(proposal_executed_at)
    .bind(block_height)
    .bind(transaction_hash)
    .execute(pool)
    .await?;

    if let Some(history_event_id) = link_intent_to_history_event(pool, dao_id, payload_hash).await?
    {
        tracing::info!(
            dao_id = dao_id,
            payload_hash = payload_hash,
            history_event_id = history_event_id,
            "linked executed confidential intent from public proposal linker"
        );
    }
    refresh_gold_metadata_for_intent(pool, dao_id, payload_hash).await?;
    Ok(())
}

fn group_resolved_receipts<'a>(
    receipts: Vec<(ProposalReceipt, i64, &'a BronzePublicHistoryEvent)>,
) -> Vec<ProposalGroup<'a>> {
    let mut groups: Vec<ProposalGroup<'a>> = Vec::new();
    let mut index: HashMap<(String, i64), usize> = HashMap::new();

    for (receipt, proposal_id, event) in receipts {
        let slot = *index
            .entry((receipt.dao_id.clone(), proposal_id))
            .or_insert_with(|| {
                groups.push(ProposalGroup {
                    dao_id: receipt.dao_id.clone(),
                    proposal_id,
                    created: None,
                    executed: None,
                    vote_remove_succeeded: false,
                    earliest_block_time: event.block_time,
                });
                groups.len() - 1
            });
        let group = &mut groups[slot];
        group.earliest_block_time = group.earliest_block_time.min(event.block_time);
        match receipt.role {
            ProposalReceiptRole::Created => {
                if group.created.is_none() {
                    group.created = Some(event);
                }
            }
            ProposalReceiptRole::Executed => {
                let is_earlier = group
                    .executed
                    .is_none_or(|current| event.block_time < current.block_time);
                if is_earlier {
                    group.executed = Some(event);
                }
            }
            ProposalReceiptRole::Voted => {
                if receipt.action.as_deref() == Some("VoteRemove")
                    && event.outcome_status != Some(false)
                {
                    group.vote_remove_succeeded = true;
                }
            }
        }
    }

    groups
}

type RpcResponseCache =
    HashMap<String, Option<Arc<methods::EXPERIMENTAL_tx_status::RpcTransactionResponse>>>;

/// Fetches the `EXPERIMENTAL_tx_status` response for an event's transaction,
/// once per transaction hash — the deciding vote and its execution callback
/// share a transaction, so one call serves all its receipts.
async fn rpc_response_for_event(
    state: &AppState,
    event: &BronzePublicHistoryEvent,
    cache: &mut RpcResponseCache,
) -> Option<Arc<methods::EXPERIMENTAL_tx_status::RpcTransactionResponse>> {
    let tx_hash = event.transaction_hash.clone()?;
    if let Some(cached) = cache.get(&tx_hash) {
        return cached.clone();
    }
    let response = match fetch_proposal_receipt_from_rpc(state, event).await {
        Ok(response) => Some(Arc::new(response)),
        Err(error) => {
            tracing::warn!(
                transaction_hash = tx_hash,
                error = %error,
                "failed to fetch tx status for proposal receipt resolution"
            );
            None
        }
    };
    cache.insert(tx_hash, response.clone());
    response
}

/// Fills `proposal_id` (and vote `action`) from the chain. NearBlocks'
/// receipts endpoint carries neither action args nor receipt SuccessValues
/// (`outcome.status` is a bare boolean), so in practice every proposal
/// receipt resolves through the archival RPC.
async fn resolve_receipt_from_rpc(
    state: &AppState,
    event: &BronzePublicHistoryEvent,
    receipt: &mut ProposalReceipt,
    cache: &mut RpcResponseCache,
) {
    let Some(response) = rpc_response_for_event(state, event, cache).await else {
        return;
    };

    match receipt.role {
        // The creation id is the receipt's SuccessValue, not an argument.
        ProposalReceiptRole::Created => {
            let outcome_id = event
                .receipt_id
                .as_deref()
                .ok_or_else(|| "missing receipt_id".to_string())
                .and_then(|receipt_id| {
                    receipt_id
                        .parse::<CryptoHash>()
                        .map_err(|error| format!("invalid receipt_id: {}", error))
                })
                .and_then(|receipt_id| proposal_id_from_rpc_outcome(&response, receipt_id));
            match outcome_id {
                Ok(proposal_id) => receipt.proposal_id = Some(proposal_id),
                Err(error) => {
                    tracing::warn!(
                        dao_id = receipt.dao_id,
                        receipt_id = ?event.receipt_id,
                        error = %error,
                        "failed to resolve add_proposal id from RPC outcome"
                    );
                }
            }
        }
        ProposalReceiptRole::Voted | ProposalReceiptRole::Executed => {
            let (Some(receipt_id), Some(method_name)) =
                (event.receipt_id.as_deref(), event.method_name.as_deref())
            else {
                return;
            };
            match receipt_args_from_rpc_response(&response, receipt_id, method_name) {
                Ok(args) => {
                    receipt.proposal_id = args.proposal_id;
                    if receipt.action.is_none() {
                        receipt.action = args.action;
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        dao_id = receipt.dao_id,
                        receipt_id = receipt_id,
                        method_name = method_name,
                        error = %error,
                        "failed to resolve proposal receipt args from RPC"
                    );
                }
            }
        }
    }
}

async fn collect_proposal_groups<'a>(
    state: &AppState,
    events: &'a [BronzePublicHistoryEvent],
) -> Vec<ProposalGroup<'a>> {
    let mut resolved = Vec::new();
    let mut rpc_cache: RpcResponseCache = HashMap::new();

    for event in events {
        let Some(mut receipt) = decode_receipt(event) else {
            continue;
        };
        if receipt.proposal_id.is_none() {
            resolve_receipt_from_rpc(state, event, &mut receipt, &mut rpc_cache).await;
        }
        let Some(proposal_id) = receipt.proposal_id else {
            tracing::warn!(
                dao_id = receipt.dao_id,
                method_name = ?event.method_name,
                transaction_hash = ?event.transaction_hash,
                receipt_id = ?event.receipt_id,
                "skipping proposal receipt because proposal_id could not be resolved"
            );
            continue;
        };
        resolved.push((receipt, proposal_id, event));
    }

    group_resolved_receipts(resolved)
}

fn db_error(error: sqlx::Error) -> (StatusCode, String) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("dao_proposals linkage failed: {}", error),
    )
}

async fn link_proposal_group(
    state: &AppState,
    group: &ProposalGroup<'_>,
) -> Result<(), (StatusCode, String)> {
    let details = fetch_proposal_details(state, &group.dao_id, group.proposal_id).await;
    let status = match details.status {
        Some(status) => Some(status),
        // Sputnik deletes removed proposals from state, so a fetch failure
        // after a successful VoteRemove is the expected signal, not an outage.
        None if group.vote_remove_succeeded => Some("removed"),
        None => None,
    };
    let proposal_kind = details
        .kind
        .or_else(|| group.created.and_then(proposal_kind_from_raw_add));
    let description = details
        .description
        .or_else(|| group.created.and_then(proposal_description_from_raw_add));
    let quote_deposit_address =
        exchange_deposit_address(description.as_deref(), proposal_kind.as_ref());
    let quote_metadata = match quote_deposit_address.as_deref() {
        Some(deposit_address) => {
            fetch_quote_metadata_for_deposit(
                state,
                &group.dao_id,
                group.proposal_id,
                deposit_address,
            )
            .await
        }
        None => None,
    };

    let upsert = DaoProposalUpsert {
        dao_id: &group.dao_id,
        proposal_id: group.proposal_id,
        status,
        proposal_kind,
        quote_metadata,
        quote_deposit_address,
        creation: group.created.map(ReceiptFacts::from_event),
        execution: group.executed.map(ReceiptFacts::from_event),
    };

    // The upsert and the silver dirty-mark must commit together: silver may
    // recompute between bronze ingest and this write (producing unlinked
    // legs), and this mark is what forces the re-link afterwards.
    let mut tx = state.db_pool.begin().await.map_err(db_error)?;
    let merged_kind = upsert.write(&mut tx).await.map_err(db_error)?;
    mark_silver_dirty_tx(&mut tx, &group.dao_id, Some(group.earliest_block_time))
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;

    if let Some(payload_hash) = merged_kind
        .as_ref()
        .and_then(extract_payload_hash_from_kind)
    {
        if let Some(created) = group.created
            && let Err(e) = mirror_confidential_proposal_created(
                &state.db_pool,
                &group.dao_id,
                &payload_hash,
                group.proposal_id,
                created.block_time,
            )
            .await
        {
            tracing::error!(
                dao_id = group.dao_id,
                proposal_id = group.proposal_id,
                error = %e,
                "failed to mirror confidential proposal creation"
            );
        }
        if let Some(executed) = group.executed
            && let Err(e) = mirror_confidential_proposal_executed(
                &state.db_pool,
                &group.dao_id,
                &payload_hash,
                executed.block_time,
                executed.block_height,
                executed.transaction_hash.as_deref(),
            )
            .await
        {
            tracing::error!(
                dao_id = group.dao_id,
                proposal_id = group.proposal_id,
                error = %e,
                "failed to mirror confidential proposal execution"
            );
        }
    }

    Ok(())
}

pub async fn link_public_proposal_receipts(
    state: &AppState,
    events: &[BronzePublicHistoryEvent],
) -> Result<(), (StatusCode, String)> {
    let groups = collect_proposal_groups(state, events).await;
    for group in &groups {
        link_proposal_group(state, group).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handlers::public_history::bronze::store::PublicHistorySource;

    fn receipt_event(
        method_name: &str,
        args: Value,
        outcome_status: Option<bool>,
        block_time_secs: i64,
    ) -> BronzePublicHistoryEvent {
        BronzePublicHistoryEvent {
            account_id: "dao.near".to_string(),
            source: PublicHistorySource::NearblocksReceipt,
            source_event_key: format!("key-{method_name}-{block_time_secs}"),
            transaction_hash: Some("tx-hash".to_string()),
            receipt_id: Some("receipt-id".to_string()),
            event_index: None,
            block_height: block_time_secs,
            block_timestamp: bigdecimal::BigDecimal::from(block_time_secs),
            block_time: chrono::DateTime::<Utc>::from_timestamp(block_time_secs, 0).unwrap(),
            affected_account_id: "dao.near".to_string(),
            involved_account_id: None,
            contract_account_id: Some("dao.near".to_string()),
            token_id: None,
            cause: None,
            action_kind: Some("FUNCTION_CALL".to_string()),
            method_name: Some(method_name.to_string()),
            delta_amount_raw: None,
            decimals: None,
            deposit_raw: None,
            outcome_status,
            raw_payload: serde_json::json!({ "action": args }),
        }
    }

    #[test]
    fn vote_receipt_decodes_as_voted_not_executed() {
        let event = receipt_event(
            "act_proposal",
            serde_json::json!({ "id": 7, "action": "VoteApprove" }),
            Some(true),
            100,
        );
        let receipt = decode_receipt(&event).expect("decoded");
        assert_eq!(receipt.role, ProposalReceiptRole::Voted);
        assert_eq!(receipt.proposal_id, Some(7));
    }

    #[test]
    fn callback_decodes_as_executed_with_proposal_id_from_args() {
        let event = receipt_event(
            "on_proposal_callback",
            serde_json::json!({ "proposal_id": 42 }),
            Some(true),
            100,
        );
        let receipt = decode_receipt(&event).expect("decoded");
        assert_eq!(receipt.role, ProposalReceiptRole::Executed);
        assert_eq!(receipt.proposal_id, Some(42));
    }

    #[test]
    fn failed_callback_is_ignored() {
        let event = receipt_event(
            "on_proposal_callback",
            serde_json::json!({ "proposal_id": 42 }),
            Some(false),
            100,
        );
        assert!(decode_receipt(&event).is_none());
    }

    #[test]
    fn groups_collapse_receipts_per_proposal() {
        let events = [
            receipt_event(
                "on_proposal_callback",
                serde_json::json!({ "proposal_id": 5 }),
                Some(true),
                300,
            ),
            receipt_event(
                "act_proposal",
                serde_json::json!({ "id": 5, "action": "VoteApprove" }),
                Some(true),
                200,
            ),
            receipt_event(
                "act_proposal",
                serde_json::json!({ "id": 6, "action": "VoteRemove" }),
                Some(true),
                250,
            ),
        ];
        let resolved = events
            .iter()
            .map(|event| {
                let receipt = decode_receipt(event).unwrap();
                let proposal_id = receipt.proposal_id.unwrap();
                (receipt, proposal_id, event)
            })
            .collect();
        let groups = group_resolved_receipts(resolved);

        assert_eq!(groups.len(), 2);
        let proposal_5 = &groups[0];
        assert_eq!(proposal_5.proposal_id, 5);
        assert!(proposal_5.executed.is_some());
        assert!(!proposal_5.vote_remove_succeeded);
        assert_eq!(
            proposal_5.earliest_block_time,
            chrono::DateTime::<Utc>::from_timestamp(200, 0).unwrap()
        );
        let proposal_6 = &groups[1];
        assert_eq!(proposal_6.proposal_id, 6);
        assert!(proposal_6.vote_remove_succeeded);
        assert!(proposal_6.executed.is_none());
    }

    #[test]
    fn vote_never_carries_execution_facts() {
        let vote = receipt_event(
            "act_proposal",
            serde_json::json!({ "id": 9, "action": "VoteApprove" }),
            Some(true),
            100,
        );
        let receipt = decode_receipt(&vote).unwrap();
        let groups = group_resolved_receipts(vec![(receipt, 9, &vote)]);
        assert_eq!(groups.len(), 1);
        assert!(groups[0].created.is_none());
        assert!(groups[0].executed.is_none());
    }
}
