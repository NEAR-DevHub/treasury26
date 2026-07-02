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
use sqlx::PgPool;

use crate::AppState;
use crate::handlers::balance_changes::utils::with_transport_retry;
use crate::handlers::intents::confidential::gold::history_events::refresh_gold_metadata_for_intent;
use crate::handlers::intents::confidential::link_intent_to_history_event;
use crate::handlers::intents::swap_status::fetch_swap_status_response;
use crate::handlers::proposals::scraper::{
    ProposalStatus, extract_from_description, extract_payload_hash_from_kind, fetch_proposal,
};
use crate::handlers::public_history::bronze::store::BronzePublicHistoryEvent;
use crate::handlers::public_history::silver::cursors::mark_silver_dirty;
use crate::utils::jsonrpc::create_rpc_client;

const PUBLIC_PROPOSAL_TX_STATUS_LABEL: &str = "public_proposal_tx_status";

#[derive(Debug, Clone, Copy)]
enum ProposalReceiptKind {
    AddProposal,
    ExecuteProposal,
}

#[derive(Debug, Clone)]
struct DecodedProposalReceipt {
    kind: ProposalReceiptKind,
    dao_id: String,
    proposal_id: Option<i64>,
    action: Option<String>,
    proposal_kind: Option<Value>,
    receipt_status_success: Option<bool>,
}

#[derive(Debug, Clone)]
struct PublicProposalDetails {
    status: Option<&'static str>,
    kind: Option<Value>,
    description: Option<String>,
}

#[derive(Debug, Clone)]
struct RpcProposalAction {
    proposal_id: i64,
    action: Option<String>,
}

fn proposal_status_as_str(status: &ProposalStatus) -> &'static str {
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

fn decoded_receipt(event: &BronzePublicHistoryEvent) -> Option<DecodedProposalReceipt> {
    let method = event.method_name.as_deref()?;
    let dao_id = event.contract_account_id.clone()?;
    let args = action_args(event);

    match method {
        "add_proposal" => {
            let proposal_id = receipt_status(event)
                .and_then(decode_success_value_i64)
                .or_else(|| {
                    args.and_then(|args| {
                        args.get("id")
                            .or_else(|| args.get("proposal_id"))
                            .and_then(Value::as_u64)
                            .and_then(|value| i64::try_from(value).ok())
                    })
                });
            let proposal_kind = args
                .and_then(|args| args.get("proposal"))
                .and_then(|proposal| proposal.get("kind"))
                .cloned();
            Some(DecodedProposalReceipt {
                kind: ProposalReceiptKind::AddProposal,
                dao_id,
                proposal_id,
                action: None,
                proposal_kind,
                receipt_status_success: event.outcome_status,
            })
        }
        "act_proposal" | "on_proposal_callback" => {
            let proposal_id = args
                .and_then(|args| {
                    args.get("id")
                        .or_else(|| args.get("proposal_id"))
                        .and_then(Value::as_u64)
                })
                .or_else(|| receipt_status(event).and_then(decode_success_value_u64))
                .and_then(|value| i64::try_from(value).ok());
            let action = args
                .and_then(|args| args.get("action"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            Some(DecodedProposalReceipt {
                kind: ProposalReceiptKind::ExecuteProposal,
                dao_id,
                proposal_id,
                action,
                proposal_kind: None,
                receipt_status_success: event.outcome_status,
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

fn proposal_action_from_rpc_receipt(
    response: &methods::EXPERIMENTAL_tx_status::RpcTransactionResponse,
    receipt_id: &str,
    method_name: &str,
) -> Result<RpcProposalAction, String> {
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
    let args = function_call
        .get("args")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("RPC {} action missing args", method_name))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(args)
        .map_err(|error| format!("failed to decode {} args: {}", method_name, error))?;
    let args: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("failed to parse {} args: {}", method_name, error))?;
    let proposal_id = args
        .get("id")
        .or_else(|| args.get("proposal_id"))
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("{} args missing proposal id", method_name))?;
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    Ok(RpcProposalAction {
        proposal_id,
        action,
    })
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
                tx_hash: tx_hash.clone(),
                sender_account_id: sender_account_id.clone(),
            },
            wait_until: TxExecutionStatus::Final,
        };
        client.call(req)
    })
    .await
    .map_err(|error| error.to_string())
}

async fn fetch_proposal_id_from_rpc_receipt(
    state: &AppState,
    event: &BronzePublicHistoryEvent,
) -> Result<i64, String> {
    let receipt_id = event
        .receipt_id
        .as_deref()
        .ok_or_else(|| "missing receipt_id".to_string())?
        .parse::<CryptoHash>()
        .map_err(|error| format!("invalid receipt_id: {}", error))?;
    let response = fetch_proposal_receipt_from_rpc(state, event).await?;
    proposal_id_from_rpc_outcome(&response, receipt_id)
}

async fn fetch_proposal_action_from_rpc_receipt(
    state: &AppState,
    event: &BronzePublicHistoryEvent,
    method_name: &str,
) -> Result<RpcProposalAction, String> {
    let receipt_id = event
        .receipt_id
        .as_deref()
        .ok_or_else(|| "missing receipt_id".to_string())?;
    let response = fetch_proposal_receipt_from_rpc(state, event).await?;
    proposal_action_from_rpc_receipt(&response, receipt_id, method_name)
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
    match fetch_swap_status_response(
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

pub async fn link_public_proposal_receipts(
    state: &AppState,
    events: &[BronzePublicHistoryEvent],
) -> Result<(), (StatusCode, String)> {
    for event in events {
        let Some(decoded) = decoded_receipt(event) else {
            continue;
        };

        let proposal_id;
        match decoded.kind {
            ProposalReceiptKind::AddProposal => {
                proposal_id = match decoded.proposal_id {
                    Some(proposal_id) => proposal_id,
                    None => match fetch_proposal_id_from_rpc_receipt(state, event).await {
                        Ok(proposal_id) => proposal_id,
                        Err(error) => {
                            tracing::warn!(
                                dao_id = decoded.dao_id,
                                transaction_hash = ?event.transaction_hash,
                                receipt_id = ?event.receipt_id,
                                error = %error,
                                "skipping add_proposal receipt because proposal_id could not be resolved"
                            );
                            continue;
                        }
                    },
                };
                let details = fetch_proposal_details(state, &decoded.dao_id, proposal_id).await;
                let proposal_kind = details.kind.or(decoded.proposal_kind);
                let description = details
                    .description
                    .or_else(|| proposal_description_from_raw_add(event));
                let status = details.status.unwrap_or("in_progress");
                let quote_deposit_address =
                    exchange_deposit_address(description.as_deref(), proposal_kind.as_ref());
                let quote_metadata = match quote_deposit_address.as_deref() {
                    Some(deposit_address) => {
                        fetch_quote_metadata_for_deposit(
                            state,
                            &decoded.dao_id,
                            proposal_id,
                            deposit_address,
                        )
                        .await
                    }
                    None => None,
                };

                sqlx::query(
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
                        updated_at
                    )
                    VALUES (
                        $1, $2, $3::proposal_status, $4, $5, $6, $7, $8, $9, $10, NOW()
                    )
                    ON CONFLICT (dao_id, proposal_id) DO UPDATE SET
                        status = EXCLUDED.status,
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
                        updated_at = NOW()
                    "#,
                )
                .bind(&decoded.dao_id)
                .bind(proposal_id)
                .bind(status)
                .bind(&proposal_kind)
                .bind(&quote_metadata)
                .bind(&quote_deposit_address)
                .bind(event.block_time)
                .bind(event.block_height)
                .bind(&event.transaction_hash)
                .bind(&event.receipt_id)
                .execute(&state.db_pool)
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("dao_proposals add_proposal upsert failed: {}", e),
                    )
                })?;

                if let Some(payload_hash) = proposal_kind
                    .as_ref()
                    .and_then(extract_payload_hash_from_kind)
                    && let Err(e) = mirror_confidential_proposal_created(
                        &state.db_pool,
                        &decoded.dao_id,
                        &payload_hash,
                        proposal_id,
                        event.block_time,
                    )
                    .await
                {
                    tracing::warn!(
                        dao_id = decoded.dao_id,
                        proposal_id = proposal_id,
                        error = %e,
                        "failed to mirror confidential proposal creation"
                    );
                }
            }
            ProposalReceiptKind::ExecuteProposal => {
                let mut action = decoded.action.clone();
                proposal_id = match decoded.proposal_id {
                    Some(proposal_id) => proposal_id,
                    None => match event.method_name.as_deref() {
                        Some(method_name) => {
                            match fetch_proposal_action_from_rpc_receipt(state, event, method_name)
                                .await
                            {
                                Ok(rpc_action) => {
                                    action = action.or(rpc_action.action);
                                    rpc_action.proposal_id
                                }
                                Err(error) => {
                                    tracing::warn!(
                                        dao_id = decoded.dao_id,
                                        transaction_hash = ?event.transaction_hash,
                                        receipt_id = ?event.receipt_id,
                                        error = %error,
                                        "skipping proposal execution receipt because proposal_id could not be resolved"
                                    );
                                    continue;
                                }
                            }
                        }
                        None => {
                            tracing::warn!(
                                dao_id = decoded.dao_id,
                                transaction_hash = ?event.transaction_hash,
                                receipt_id = ?event.receipt_id,
                                "skipping proposal execution receipt because method_name is missing"
                            );
                            continue;
                        }
                    },
                };
                let status = if decoded.receipt_status_success == Some(false) {
                    "failed"
                } else {
                    let details = fetch_proposal_details(state, &decoded.dao_id, proposal_id).await;
                    details.status.unwrap_or(match action.as_deref() {
                        Some("VoteReject") => "rejected",
                        Some("VoteRemove") => "removed",
                        _ => "approved",
                    })
                };

                let row = sqlx::query_as::<_, (Option<Value>,)>(
                    r#"
                    INSERT INTO dao_proposals (
                        dao_id,
                        proposal_id,
                        status,
                        proposal_executed_at,
                        proposal_execution_block_height,
                        proposal_execution_transaction_hash,
                        proposal_execution_receipt_id,
                        updated_at
                    )
                    VALUES (
                        $1, $2, $3::proposal_status, $4, $5, $6, $7, NOW()
                    )
                    ON CONFLICT (dao_id, proposal_id) DO UPDATE SET
                        status = EXCLUDED.status,
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
                .bind(&decoded.dao_id)
                .bind(proposal_id)
                .bind(status)
                .bind(event.block_time)
                .bind(event.block_height)
                .bind(&event.transaction_hash)
                .bind(&event.receipt_id)
                .fetch_one(&state.db_pool)
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("dao_proposals execution upsert failed: {}", e),
                    )
                })?;

                if let Some(payload_hash) = row.0.as_ref().and_then(extract_payload_hash_from_kind)
                    && let Err(e) = mirror_confidential_proposal_executed(
                        &state.db_pool,
                        &decoded.dao_id,
                        &payload_hash,
                        event.block_time,
                        event.block_height,
                        event.transaction_hash.as_deref(),
                    )
                    .await
                {
                    tracing::warn!(
                        dao_id = decoded.dao_id,
                        proposal_id = proposal_id,
                        error = %e,
                        "failed to mirror confidential proposal execution"
                    );
                }
            }
        }

        if let Err(e) =
            mark_silver_dirty(&state.db_pool, &decoded.dao_id, Some(event.block_time)).await
        {
            tracing::warn!(
                dao_id = decoded.dao_id,
                proposal_id = proposal_id,
                error = %e,
                "failed to mark public silver dirty after proposal linkage"
            );
        }
    }

    Ok(())
}
