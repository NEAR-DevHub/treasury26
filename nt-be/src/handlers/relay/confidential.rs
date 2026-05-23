//! Auto-submit confidential intents after DAO proposal approval.
//!
//! When a confidential_transfer proposal is created, the intent payload is stored
//! in `confidential_intents` keyed by its NEP-413 payload hash. When a vote
//! approves the proposal and the MPC signature is in the execution result, the
//! signed intent is submitted to the 1Click API automatically.

use crate::{
    AppState,
    constants::V1_SIGNER_CONTRACT_ID,
    handlers::intents::confidential::{
        balance_changes_projector::refresh_gold_metadata_for_intent,
        history_store::link_intent_to_history_event,
        history_worker::trigger_confidential_history_refresh,
    },
    utils::cache::CacheKey,
};
use base64::Engine;
use near_api::types::{Action, transaction::delegate_action::NonDelegateAction};
use reqwest::StatusCode;
use serde_json::Value;
use sqlx::PgPool;
use std::{ops::Deref, sync::Arc};

/// Compute the NEP-413 payload hash (the value used in `payload_v2.Eddsa`).
///
/// Takes the intent payload JSON (`{ message, nonce, recipient }`) and returns
/// the lowercase hex SHA-256 digest that v1.signer signs.
pub fn compute_nep413_hash(payload: &Value) -> Option<String> {
    let message = payload.get("message")?.as_str()?.to_string();
    let nonce_b64 = payload.get("nonce")?.as_str()?;
    let recipient = payload.get("recipient")?.as_str()?.to_string();

    let nonce_bytes = base64::engine::general_purpose::STANDARD
        .decode(nonce_b64)
        .ok()?;
    if nonce_bytes.len() != 32 {
        return None;
    }
    let mut nonce = [0u8; 32];
    nonce.copy_from_slice(&nonce_bytes);

    near_api::signer::NEP413Payload {
        message,
        nonce,
        recipient,
        callback_url: None,
    }
    .compute_hash()
    .ok()
    .map(|hash| hex::encode(hash.0))
}

/// Fetch the Ed25519 derived public key for a DAO's path from v1.signer.
pub(crate) async fn fetch_mpc_public_key(
    state: &Arc<AppState>,
    dao_id: &str,
) -> Result<String, (StatusCode, String)> {
    let args = serde_json::json!({
        "path": dao_id,
        "predecessor": dao_id,
        "domain_id": 1,
    });

    let result = state
        .cache
        .cached_contract_call(
            crate::utils::cache::CacheTier::LongTerm,
            CacheKey::new("mpc-public-key").with(dao_id).build(),
            async move {
                near_api::Contract(V1_SIGNER_CONTRACT_ID.into())
                    .call_function("derived_public_key", args)
                    .read_only::<String>()
                    .fetch_from(&state.network)
                    .await
            },
        )
        .await?;

    Ok(result.data)
}

/// Store a pending intent for later auto-submission.
pub async fn store_pending_intent(
    pool: &PgPool,
    dao_id: &str,
    payload_hash: &str,
    intent_payload: &Value,
    correlation_id: Option<&str>,
    quote_metadata: Option<&Value>,
    deposit_address: &str,
    notes: Option<&str>,
) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO confidential_intents (
            dao_id,
            payload_hash,
            intent_payload,
            correlation_id,
            quote_metadata,
            deposit_address,
            notes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (dao_id, payload_hash) DO UPDATE SET
            intent_payload = EXCLUDED.intent_payload,
            correlation_id = EXCLUDED.correlation_id,
            quote_metadata = EXCLUDED.quote_metadata,
            deposit_address = EXCLUDED.deposit_address,
            notes = EXCLUDED.notes,
            intent_type = 'shield',
            status = 'pending',
            submit_result = NULL,
            updated_at = NOW()
        "#,
    )
    .bind(dao_id)
    .bind(payload_hash)
    .bind(intent_payload)
    .bind(correlation_id)
    .bind(quote_metadata)
    .bind(deposit_address)
    .bind(notes)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to store pending intent: {}", e))?;

    log::info!(
        "Stored pending confidential intent for {} (hash={})",
        dao_id,
        payload_hash
    );
    Ok(())
}

/// Extract MPC signature from the execution result debug string.
/// Searches for the base64 marker "eyJzY2hlbWUi" (= `{"scheme"`).
pub(crate) fn extract_mpc_signature(result_debug: &str) -> Option<Vec<u8>> {
    let marker = "eyJzY2hlbWUi";
    let start = result_debug.find(marker)?;
    let rest = &result_debug[start..];
    let end = rest
        .find(|c: char| !c.is_alphanumeric() && c != '+' && c != '/' && c != '=')
        .unwrap_or(rest.len());
    let b64_value = &rest[..end];

    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(b64_value)
        .ok()?;
    let sig_json: Value = serde_json::from_slice(&decoded).ok()?;

    if sig_json.get("scheme")?.as_str()? != "Ed25519" {
        return None;
    }

    let sig_array = sig_json.get("signature")?.as_array()?;
    if sig_array.len() != 64 {
        return None;
    }

    let bytes: Option<Vec<u8>> = sig_array
        .iter()
        .map(|v| v.as_u64().map(|n| n as u8))
        .collect();

    bytes
}

/// Extract the `payload_v2.Eddsa` hash from a delegate action's `act_proposal` call.
///
/// Looks for a `FunctionCall` with `method_name == "act_proposal"`, then checks if
/// `proposal.FunctionCall.receiver_id == "v1.signer"` and extracts the hash from the
/// inner `sign` action's args.
pub fn extract_v1_signer_hash(actions: &[NonDelegateAction]) -> Option<String> {
    for action in actions {
        if let Action::FunctionCall(fc) = action.deref() {
            if fc.method_name != "act_proposal" {
                continue;
            }
            let args: Value = serde_json::from_slice(&fc.args).ok()?;
            let proposal = args.get("proposal")?;
            let func_call = proposal.get("FunctionCall")?;

            if func_call.get("receiver_id")?.as_str()? != "v1.signer" {
                return None;
            }

            let inner_actions = func_call.get("actions")?.as_array()?;
            let first_action = inner_actions.first()?;
            let inner_args_b64 = first_action.get("args")?.as_str()?;

            use base64::Engine;
            let inner_args_bytes = base64::engine::general_purpose::STANDARD
                .decode(inner_args_b64)
                .ok()?;
            let inner_args: Value = serde_json::from_slice(&inner_args_bytes).ok()?;

            let hash = inner_args
                .get("request")?
                .get("payload_v2")?
                .get("Eddsa")?
                .as_str()?;

            return Some(hash.to_string());
        }
    }
    None
}

/// Try to auto-submit a confidential intent after a vote relay succeeds.
///
/// This is called in a background task after a successful vote relay.
/// It uses the payload hash extracted from the delegate action to find the
/// matching pending intent.
pub async fn try_auto_submit_intent(
    state: &Arc<AppState>,
    treasury_id: &str,
    payload_hash: &str,
    result_debug: &str,
) {
    // Extract MPC signature from execution result
    let sig_bytes = match extract_mpc_signature(result_debug) {
        Some(bytes) => bytes,
        None => {
            log::warn!(
                "No MPC signature found in vote result for {} (hash={})",
                treasury_id,
                payload_hash
            );
            return;
        }
    };

    let sig_b58 = format!("ed25519:{}", bs58::encode(&sig_bytes).into_string());
    log::info!(
        "Extracted MPC signature for {} (hash={}) — looking for pending intent",
        treasury_id,
        payload_hash
    );

    // Find the pending intent matching this payload hash.
    let pending = sqlx::query_as::<_, (Value, Option<String>, String)>(
        r#"
        SELECT intent_payload, correlation_id, intent_type
        FROM confidential_intents
        WHERE dao_id = $1 AND payload_hash = $2 AND status = 'pending'
        "#,
    )
    .bind(treasury_id)
    .bind(payload_hash)
    .fetch_optional(&state.db_pool)
    .await;

    let (intent_payload, _correlation_id, intent_type) = match pending {
        Ok(Some(row)) => row,
        Ok(None) => {
            log::warn!(
                "MPC signature found but no pending intent for {} (hash={})",
                treasury_id,
                payload_hash
            );
            return;
        }
        Err(e) => {
            log::error!(
                "DB error looking up pending intent for {} (hash={}): {}",
                treasury_id,
                payload_hash,
                e
            );
            return;
        }
    };

    // Fetch the DAO's derived MPC public key from v1.signer
    let mpc_public_key = match fetch_mpc_public_key(state, treasury_id).await {
        Ok(key) => key,
        Err(e) => {
            log::error!(
                "Failed to fetch MPC public key for {}: {:?}",
                treasury_id,
                e
            );
            return;
        }
    };

    log::info!(
        "Auto-submitting {} for {} (hash={}, mpc_key={})",
        intent_type,
        treasury_id,
        payload_hash,
        mpc_public_key
    );

    let (url, body) = if intent_type == "auth" {
        // Authentication: call 1Click auth/authenticate
        let url = format!(
            "{}/v0/auth/authenticate",
            state.env_vars.confidential_api_url
        );
        let body = serde_json::json!({
            "signedData": {
                "standard": "nep413",
                "payload": intent_payload,
                "public_key": mpc_public_key,
                "signature": sig_b58,
            }
        });
        (url, body)
    } else {
        // Shield: call 1Click submit-intent
        let url = format!("{}/v0/submit-intent", state.env_vars.confidential_api_url);
        let body = serde_json::json!({
            "type": "swap_transfer",
            "signedData": {
                "standard": "nep413",
                "payload": intent_payload,
                "public_key": mpc_public_key,
                "signature": sig_b58,
            }
        });
        (url, body)
    };

    let mut req = state
        .http_client
        .post(&url)
        .header("content-type", "application/json");

    if let Some(api_key) = &state.env_vars.oneclick_api_key {
        req = req.header("x-api-key", api_key);
    }

    let result = req.json(&body).send().await;

    match result {
        Ok(resp) => {
            let status = resp.status();
            let resp_body: Value = resp.json().await.unwrap_or_default();

            if status.is_success() {
                log::info!(
                    "Successfully submitted {} for {} (hash={}): {:?}",
                    intent_type,
                    treasury_id,
                    payload_hash,
                    resp_body
                );

                // For auth: store the JWT tokens in monitored_accounts
                if intent_type == "auth"
                    && let (Some(access_token), Some(refresh_token)) = (
                        resp_body.get("accessToken").and_then(|v| v.as_str()),
                        resp_body.get("refreshToken").and_then(|v| v.as_str()),
                    )
                {
                    let expires_in = resp_body
                        .get("expiresIn")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(3600);
                    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(expires_in);

                    let _ = sqlx::query!(
                        r#"
                            UPDATE monitored_accounts
                            SET confidential_access_token = $1,
                                confidential_refresh_token = $2,
                                confidential_token_expires_at = $3
                            WHERE account_id = $4
                            "#,
                        access_token,
                        refresh_token,
                        expires_at,
                        treasury_id,
                    )
                    .execute(&state.db_pool)
                    .await;

                    log::info!(
                        "Stored confidential JWT for DAO {} (expires in {}s)",
                        treasury_id,
                        expires_in
                    );
                }

                let update_result = sqlx::query!(
                    "UPDATE confidential_intents SET status = 'submitted', submit_result = $1, updated_at = NOW() WHERE dao_id = $2 AND payload_hash = $3",
                    &resp_body,
                    treasury_id,
                    payload_hash,
                )
                .execute(&state.db_pool)
                .await;

                if update_result.is_ok() {
                    match link_intent_to_history_event(&state.db_pool, treasury_id, payload_hash)
                        .await
                    {
                        Ok(Some(history_event_id)) => {
                            log::info!(
                                "Linked submitted confidential intent for {} (hash={}) to history_event_id={}",
                                treasury_id,
                                payload_hash,
                                history_event_id
                            );
                        }
                        Ok(None) => {}
                        Err(e) => {
                            log::warn!(
                                "Failed to link submitted confidential intent for {} (hash={}): {}",
                                treasury_id,
                                payload_hash,
                                e
                            );
                        }
                    }

                    // Pull fresh Bronze for this DAO so the just-submitted intent's
                    // 1Click history row is available immediately. Resets the
                    // activity timestamp + next_poll_at so the scheduler stays
                    // in the hot tier.
                    trigger_confidential_history_refresh(state.as_ref(), treasury_id).await;

                    // Must run after the refresh above so the Gold row exists.
                    if let Err(e) =
                        refresh_gold_metadata_for_intent(&state.db_pool, treasury_id, payload_hash)
                            .await
                    {
                        log::warn!(
                            "Failed to refresh confidential gold metadata for {} (hash={}): {}",
                            treasury_id,
                            payload_hash,
                            e
                        );
                    }
                }
            } else {
                log::error!(
                    "1Click {} failed ({}) for {} (hash={}): {:?}",
                    intent_type,
                    status,
                    treasury_id,
                    payload_hash,
                    resp_body
                );
                let _ = sqlx::query!(
                    "UPDATE confidential_intents SET status = 'failed', submit_result = $1, updated_at = NOW() WHERE dao_id = $2 AND payload_hash = $3",
                    &resp_body,
                    treasury_id,
                    payload_hash,
                )
                .execute(&state.db_pool)
                .await;
            }
        }
        Err(e) => {
            log::error!(
                "Failed to call 1Click {} for {} (hash={}): {}",
                intent_type,
                treasury_id,
                payload_hash,
                e
            );
            let _ = sqlx::query!(
                "UPDATE confidential_intents SET status = 'failed', submit_result = $1, updated_at = NOW() WHERE dao_id = $2 AND payload_hash = $3",
                serde_json::json!({"error": e.to_string()}),
                treasury_id,
                payload_hash,
            )
            .execute(&state.db_pool)
            .await;
        }
    }
}
