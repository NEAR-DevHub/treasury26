//! Confidential bulk-payment processor.
//!
//! Driven by the same worker loop as the public bulk-payment payouts.
//! Walks `confidential_bulk_payments` rows and pushes each through the
//! state machine:
//!
//! 1. `activating` → call sub `activate(proposal_id)` (0.5 NEAR deposit).
//!    Move to `signing`.
//! 2. `signing` → view sub `get_activation`. If the activation is `Ready`
//!    and there are still `Pending` entries, call `ping`. If `Done`,
//!    submit every recipient intent to 1Click in parallel and mark the
//!    bulk row `completed`.
//!
use std::sync::Arc;

use near_api::{AccountId, Contract, NearGas, NearToken, types::json::Base64VecU8};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::AppState;

const ACTIVATE_DEPOSIT: NearToken = NearToken::from_millinear(500); // 0.5 NEAR
const PING_GAS: NearGas = NearGas::from_tgas(300);

// Strongly-typed mirror of the on-chain contract types. Kept in lockstep
// with `contracts/confidential-bulk-payment/src/lib.rs`. Duplicating them
// here (rather than depending on the contract crate) keeps the BE binary
// independent of the contract's near-sdk version.

#[derive(Debug, Deserialize, Serialize)]
pub enum ActivationStatusView {
    Loading,
    Ready { cursor: u32 },
    Done,
}

#[derive(Debug, Deserialize, Serialize)]
pub enum HashInvalidReasonView {
    MalformedHex,
}

#[derive(Debug, Deserialize, Serialize)]
pub enum SignFailureReasonView {
    SignerCallFailed,
}

#[derive(Debug, Deserialize, Serialize)]
pub enum HashStatusView {
    Pending,
    Signing,
    Signed { signature: Base64VecU8 },
    SignFailed { reason: SignFailureReasonView },
    Invalid { reason: HashInvalidReasonView },
}

#[derive(Debug, Deserialize, Serialize)]
pub struct HashEntryView {
    pub payload_hash: String,
    pub status: HashStatusView,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ActivationView {
    pub status: ActivationStatusView,
    pub hashes: Vec<HashEntryView>,
    pub unresolved: u32,
}

impl ActivationStatusView {
    fn is_done(&self) -> bool {
        matches!(self, ActivationStatusView::Done)
    }
    fn is_ready(&self) -> bool {
        matches!(self, ActivationStatusView::Ready { .. })
    }
}

impl HashStatusView {
    fn signed_signature(&self) -> Option<&Base64VecU8> {
        match self {
            HashStatusView::Signed { signature } => Some(signature),
            _ => None,
        }
    }
    fn is_pending_or_signing(&self) -> bool {
        matches!(self, HashStatusView::Pending | HashStatusView::Signing)
    }
}

async fn fetch_activation(
    state: &Arc<AppState>,
    sub_id: &AccountId,
    proposal_id: i64,
) -> Result<Option<ActivationView>, String> {
    Contract(sub_id.clone())
        .call_function(
            "get_activation",
            json!({ "proposal_id": proposal_id.to_string() }),
        )
        .read_only::<Option<ActivationView>>()
        .fetch_from(&state.network)
        .await
        .map(|r| r.data)
        .map_err(|e| format!("get_activation: {}", e))
}

/// Drive every confidential bulk-payment row currently in `activating` or
/// `signing`. Called once per worker tick.
pub async fn process_confidential_bulk_payments(state: &Arc<AppState>) {
    let rows = match sqlx::query!(
        r#"
        SELECT id, dao_id, bulk_account_id, header_payload_hash,
               recipient_payload_hashes, proposal_id, status
        FROM confidential_bulk_payments
        WHERE status IN ('activating', 'signing') AND proposal_id IS NOT NULL
        "#
    )
    .fetch_all(&state.db_pool)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("Failed to fetch pending bulk-payments: {}", e);
            return;
        }
    };

    for row in rows {
        let proposal_id = match row.proposal_id {
            Some(id) => id,
            None => continue,
        };

        let sub_id: AccountId = match row.bulk_account_id.parse() {
            Ok(id) => id,
            Err(e) => {
                tracing::error!(
                    "invalid bulk_account_id {} in row {}: {}",
                    row.bulk_account_id,
                    row.id,
                    e
                );
                continue;
            }
        };

        if row.status == "activating" {
            if let Err(e) = activate_subaccount(state, &sub_id, proposal_id).await {
                tracing::error!(
                    "Failed to activate bulk #{} ({}): {}",
                    proposal_id,
                    row.dao_id,
                    e
                );
                continue;
            }
            // Move to `signing` — even if activation rejected the proposal
            // the per-cycle view below will detect a missing/empty activation
            // and the row will be marked failed.
            let _ = sqlx::query!(
                "UPDATE confidential_bulk_payments SET status = 'signing', updated_at = NOW() WHERE id = $1",
                row.id,
            )
            .execute(&state.db_pool)
            .await;
        }

        // Whether we just activated or already `signing`, view + drive ping
        // or submit on the same tick.
        if let Err(e) = drive_signing(
            state,
            row.id,
            &row.dao_id,
            &sub_id,
            proposal_id,
            &row.recipient_payload_hashes,
        )
        .await
        {
            tracing::error!(
                "Failed to drive bulk #{} ({}): {}",
                proposal_id,
                row.dao_id,
                e
            );
            let _ = sqlx::query!(
                "UPDATE confidential_bulk_payments SET last_error = $2, updated_at = NOW() WHERE id = $1",
                row.id,
                e,
            )
            .execute(&state.db_pool)
            .await;
        }
    }
}

async fn activate_subaccount(
    state: &Arc<AppState>,
    sub_id: &AccountId,
    proposal_id: i64,
) -> Result<(), String> {
    Contract(sub_id.clone())
        .call_function(
            "activate",
            json!({ "proposal_id": proposal_id.to_string() }),
        )
        .transaction()
        .max_gas()
        .deposit(ACTIVATE_DEPOSIT)
        .with_signer(state.signer_id.clone(), state.signer.clone())
        .send_to(&state.network)
        .await
        .map_err(|e| format!("activate send: {}", e))?
        .into_result()
        .map_err(|e| format!("activate send: {}", e))?;
    tracing::info!("Activated bulk proposal {} on {}", proposal_id, sub_id);
    Ok(())
}

async fn drive_signing(
    state: &Arc<AppState>,
    bulk_id: i32,
    dao_id: &str,
    sub_id: &AccountId,
    proposal_id: i64,
    recipient_hashes: &[String],
) -> Result<(), String> {
    let activation = fetch_activation(state, sub_id, proposal_id).await?;
    let activation = match activation {
        Some(a) => a,
        None => {
            // `activate` did not produce state (e.g. proposal not Approved
            // on-chain at the time). Mark failed.
            sqlx::query!(
                "UPDATE confidential_bulk_payments SET status = 'failed', last_error = 'activation missing', updated_at = NOW() WHERE id = $1",
                bulk_id,
            )
            .execute(&state.db_pool)
            .await
            .map_err(|e| format!("mark-failed: {}", e))?;
            return Ok(());
        }
    };

    if !activation.status.is_done() {
        // Still mid-signing. If the activation is `Ready` and any entry is
        // pending, kick a ping. Skip submit until all entries terminal.
        if activation.status.is_ready()
            && activation
                .hashes
                .iter()
                .any(|h| h.status.is_pending_or_signing())
        {
            ping_subaccount(state, sub_id, proposal_id).await?;
        }
        return Ok(());
    }

    // Done — only now do we submit recipient intents to 1Click.
    let public_key =
        crate::handlers::relay::confidential::fetch_mpc_public_key(state, sub_id.as_ref(), "")
            .await
            .map_err(|(c, m)| format!("sub pubkey ({}): {}", c, m))?;

    submit_done_activation(
        state,
        bulk_id,
        dao_id,
        sub_id,
        &activation,
        recipient_hashes,
        &public_key,
    )
    .await
}

async fn ping_subaccount(
    state: &Arc<AppState>,
    sub_id: &AccountId,
    proposal_id: i64,
) -> Result<(), String> {
    Contract(sub_id.clone())
        .call_function("ping", json!({ "proposal_id": proposal_id.to_string() }))
        .transaction()
        .gas(PING_GAS)
        .with_signer(state.signer_id.clone(), state.signer.clone())
        .send_to(&state.network)
        .await
        .map_err(|e| format!("ping send: {}", e))?
        .into_result()
        .map_err(|e| format!("ping send: {}", e))?;
    tracing::info!("Pinged bulk proposal {} on {}", proposal_id, sub_id);
    Ok(())
}

/// Submit every recipient intent that's already-`Signed` on-chain and not
/// yet posted to 1Click. Marks the bulk row `completed` after the last
/// recipient is submitted.
async fn submit_done_activation(
    state: &Arc<AppState>,
    bulk_id: i32,
    dao_id: &str,
    sub_id: &AccountId,
    activation: &ActivationView,
    recipient_hashes: &[String],
    public_key: &str,
) -> Result<(), String> {
    // Fetch any recipient rows still pending submission to 1Click.
    let pending = sqlx::query!(
        r#"
        SELECT payload_hash, intent_payload
        FROM confidential_intents
        WHERE payload_hash = ANY($1) AND status = 'pending'
        "#,
        recipient_hashes,
    )
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| format!("fetch pending recipients: {}", e))?;

    if pending.is_empty() {
        // All already submitted (or none pending). Mark completed.
        sqlx::query!(
            "UPDATE confidential_bulk_payments SET status = 'completed', updated_at = NOW() WHERE id = $1",
            bulk_id,
        )
        .execute(&state.db_pool)
        .await
        .map_err(|e| format!("mark-completed: {}", e))?;
        tracing::info!("Bulk-payment {} for {} fully submitted", bulk_id, dao_id);
        return Ok(());
    }

    // Build a hash → on-chain entry map for sig lookup.
    let sig_by_hash: std::collections::HashMap<&str, &Base64VecU8> = activation
        .hashes
        .iter()
        .filter_map(|h| {
            h.status
                .signed_signature()
                .map(|sig| (h.payload_hash.as_str(), sig))
        })
        .collect();

    // Submit in parallel.
    let mut futures = Vec::with_capacity(pending.len());
    for row in &pending {
        let hash = row.payload_hash.clone();
        let intent_payload = row.intent_payload.clone();
        let sig = match sig_by_hash.get(hash.as_str()) {
            Some(s) => (*s).clone(),
            None => {
                // Sub recorded the entry as Invalid/SignFailed — mark recipient
                // failed and move on.
                let _ = sqlx::query!(
                    r#"
                    UPDATE confidential_intents
                    SET status = 'failed',
                        submit_result = '"no signature on chain"'::jsonb,
                        updated_at = NOW()
                    WHERE payload_hash = $1
                    "#,
                    hash,
                )
                .execute(&state.db_pool)
                .await;
                continue;
            }
        };
        let state = state.clone();
        let public_key = public_key.to_string();
        let sub_id = sub_id.to_string();
        futures.push(async move {
            let res = crate::handlers::relay::confidential::submit_intent_to_oneclick(
                &state,
                crate::handlers::relay::confidential::IntentSubmitKind::Shield,
                &intent_payload,
                &public_key,
                &sig.0,
            )
            .await;
            (sub_id, hash, res)
        });
    }

    let results = futures::future::join_all(futures).await;
    for (sub_id, hash, res) in results {
        match res {
            Ok(body) => {
                let _ = sqlx::query!(
                    "UPDATE confidential_intents SET status = 'submitted', submit_result = $2, updated_at = NOW() WHERE payload_hash = $1",
                    hash,
                    body,
                )
                .execute(&state.db_pool)
                .await;
            }
            Err(err) => {
                tracing::error!(
                    "submit-intent failed for {} (hash={}): {}",
                    sub_id,
                    hash,
                    err
                );
                let _ = sqlx::query!(
                    "UPDATE confidential_intents SET status = 'failed', submit_result = $2, updated_at = NOW() WHERE payload_hash = $1",
                    hash,
                    json!({ "error": err }),
                )
                .execute(&state.db_pool)
                .await;
            }
        }
    }

    sqlx::query!(
        "UPDATE confidential_bulk_payments SET status = 'completed', updated_at = NOW() WHERE id = $1",
        bulk_id,
    )
    .execute(&state.db_pool)
    .await
    .map_err(|e| format!("mark-completed: {}", e))?;

    tracing::info!("Bulk-payment {} for {} fully submitted", bulk_id, dao_id);
    Ok(())
}
