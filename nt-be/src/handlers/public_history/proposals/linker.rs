use axum::http::StatusCode;
use base64::Engine;
use chrono::{DateTime, Utc};
use near_api::AccountId;
use serde_json::Value;
use sqlx::PgPool;

use crate::AppState;
use crate::handlers::intents::confidential::link_intent_to_history_event;
use crate::handlers::intents::confidential::gold::history_events::refresh_gold_metadata_for_intent;
use crate::handlers::proposals::scraper::{
    ProposalStatus, extract_payload_hash_from_kind, fetch_proposal,
};
use crate::handlers::public_history::bronze::store::BronzePublicHistoryEvent;
use crate::handlers::public_history::silver::cursors::mark_silver_dirty;

#[derive(Debug, Clone, Copy)]
enum ProposalReceiptKind {
    AddProposal,
    ExecuteProposal,
}

#[derive(Debug, Clone)]
struct DecodedProposalReceipt {
    kind: ProposalReceiptKind,
    dao_id: String,
    proposal_id: i64,
    action: Option<String>,
    proposal_kind: Option<Value>,
    receipt_status_success: Option<bool>,
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
                .and_then(decode_success_value_u64)
                .or_else(|| {
                    args.and_then(|args| {
                        args.get("id")
                            .or_else(|| args.get("proposal_id"))
                            .and_then(Value::as_u64)
                    })
                })?;
            let proposal_kind = args
                .and_then(|args| args.get("proposal"))
                .and_then(|proposal| proposal.get("kind"))
                .cloned();
            Some(DecodedProposalReceipt {
                kind: ProposalReceiptKind::AddProposal,
                dao_id,
                proposal_id: i64::try_from(proposal_id).ok()?,
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
                .or_else(|| receipt_status(event).and_then(decode_success_value_u64))?;
            let action = args
                .and_then(|args| args.get("action"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            Some(DecodedProposalReceipt {
                kind: ProposalReceiptKind::ExecuteProposal,
                dao_id,
                proposal_id: i64::try_from(proposal_id).ok()?,
                action,
                proposal_kind: None,
                receipt_status_success: event.outcome_status,
            })
        }
        _ => None,
    }
}

async fn fetch_status_and_kind(
    state: &AppState,
    dao_id: &str,
    proposal_id: i64,
) -> (Option<&'static str>, Option<Value>) {
    let Ok(account_id) = dao_id.parse::<AccountId>() else {
        return (None, None);
    };
    let Ok(proposal_id) = u64::try_from(proposal_id) else {
        return (None, None);
    };
    match fetch_proposal(&state.network, &account_id, proposal_id).await {
        Ok(proposal) => (
            Some(proposal_status_as_str(&proposal.status)),
            Some(proposal.kind),
        ),
        Err(e) => {
            tracing::warn!(
                dao_id = dao_id,
                proposal_id = proposal_id,
                error = ?e,
                "failed to fetch proposal for public history linker"
            );
            (None, None)
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

    if let Some(history_event_id) =
        link_intent_to_history_event(pool, dao_id, payload_hash).await?
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

    if let Some(history_event_id) =
        link_intent_to_history_event(pool, dao_id, payload_hash).await?
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

        match decoded.kind {
            ProposalReceiptKind::AddProposal => {
                let (fetched_status, fetched_kind) =
                    fetch_status_and_kind(state, &decoded.dao_id, decoded.proposal_id).await;
                let proposal_kind = fetched_kind.or(decoded.proposal_kind);
                let status = fetched_status.unwrap_or("in_progress");

                sqlx::query(
                    r#"
                    INSERT INTO dao_proposals (
                        dao_id,
                        proposal_id,
                        status,
                        proposal_kind,
                        proposal_created_at,
                        proposal_creation_block_height,
                        proposal_creation_transaction_hash,
                        proposal_creation_receipt_id,
                        updated_at
                    )
                    VALUES (
                        $1, $2, $3::proposal_status, $4, $5, $6, $7, $8, NOW()
                    )
                    ON CONFLICT (dao_id, proposal_id) DO UPDATE SET
                        status = EXCLUDED.status,
                        proposal_kind = COALESCE(
                            EXCLUDED.proposal_kind,
                            dao_proposals.proposal_kind
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
                .bind(decoded.proposal_id)
                .bind(status)
                .bind(&proposal_kind)
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

                if let Some(payload_hash) =
                    proposal_kind.as_ref().and_then(extract_payload_hash_from_kind)
                    && let Err(e) = mirror_confidential_proposal_created(
                        &state.db_pool,
                        &decoded.dao_id,
                        &payload_hash,
                        decoded.proposal_id,
                        event.block_time,
                    )
                    .await
                {
                    tracing::warn!(
                        dao_id = decoded.dao_id,
                        proposal_id = decoded.proposal_id,
                        error = %e,
                        "failed to mirror confidential proposal creation"
                    );
                }
            }
            ProposalReceiptKind::ExecuteProposal => {
                let status = if decoded.receipt_status_success == Some(false) {
                    "failed"
                } else {
                    let (status, _) =
                        fetch_status_and_kind(state, &decoded.dao_id, decoded.proposal_id).await;
                    status.unwrap_or(match decoded.action.as_deref() {
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
                .bind(decoded.proposal_id)
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

                if let Some(payload_hash) =
                    row.0.as_ref().and_then(extract_payload_hash_from_kind)
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
                        proposal_id = decoded.proposal_id,
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
                proposal_id = decoded.proposal_id,
                error = %e,
                "failed to mark public silver dirty after proposal linkage"
            );
        }
    }

    Ok(())
}
