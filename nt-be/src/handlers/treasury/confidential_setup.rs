//! Confidential treasury setup — authenticates a newly created DAO with the
//! 1Click confidential intents API, then updates its policy to the user's
//! desired configuration.
//!
//! Flow (all executed by the backend signer which is the sole initial member):
//! 1. Submit auth proposal (v1.signer sign call) → vote → extract MPC signature
//! 2. Authenticate with 1Click API using the MPC signature
//! 3. Submit ChangePolicy proposal (user's real config) → vote

use std::sync::Arc;

use base64::Engine;
use near_api::{AccountId, Contract, NearGas, NearToken};
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::create::{ProgressEvent, send_progress};
use crate::AppState;
use crate::constants::INTENTS_CONTRACT_ID;
use crate::handlers::intents::confidential::prepare_auth::{
    build_auth_proposal, build_bulk_payment_auth_proposal,
};
use crate::handlers::relay::confidential::{extract_mpc_signature, fetch_mpc_public_key};
use crate::observability::sanitize_sensitive_json_value;

/// Run the full confidential setup for a newly created treasury.
///
/// The treasury must have been created with `state.signer_id` as the sole
/// Admin+Approver member (threshold=1) so this function can submit and
/// immediately approve proposals.
pub async fn setup_confidential_treasury(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    target_policy: Value,
    progress: Option<&mpsc::Sender<ProgressEvent>>,
) -> Result<(), (StatusCode, String)> {
    // ── Add Public Key to intents.near (idempotent) ─────────────────────
    if let Some(tx) = progress {
        send_progress(tx, "adding_public_key", "in_progress").await;
    }

    let treasury_id_public_key =
        fetch_mpc_public_key(state, treasury_id.as_str(), treasury_id.as_str()).await?;

    if intents_has_public_key(state, treasury_id, &treasury_id_public_key).await? {
        tracing::info!(
            "Confidential setup: public key already registered for {}, skipping add",
            treasury_id
        );
    } else {
        let public_key_args = json!({
            "public_key": treasury_id_public_key,
        });
        let public_key_args_b64 =
            base64::engine::general_purpose::STANDARD.encode(public_key_args.to_string());
        submit_and_approve_proposal(
            state,
            treasury_id,
            json!({
            "proposal": {
                "description": "Add public key to intents.near",
                "kind": {
                    "FunctionCall": {
                        "receiver_id": INTENTS_CONTRACT_ID,
                        "actions": [{
                            "method_name": "add_public_key",
                            "args": public_key_args_b64,
                            "deposit": "1",
                            "gas": NearGas::from_tgas(5),
                        }],
                    }
                }
            }}),
        )
        .await?;
    }

    if let Some(tx) = progress {
        send_progress(tx, "adding_public_key", "completed").await;
    }

    // ── Auth proposal + 1Click authentication (idempotent) ──────────────
    if let Some(tx) = progress {
        send_progress(tx, "authenticating", "in_progress").await;
    }

    if has_valid_confidential_token(&state.db_pool, treasury_id).await {
        tracing::info!(
            "Confidential setup: {} already authenticated with 1Click, skipping auth",
            treasury_id
        );
    } else {
        tracing::info!(
            "Confidential setup: creating auth proposal for {}",
            treasury_id
        );

        let (auth_proposal, auth_payload) =
            build_auth_proposal(state, treasury_id.as_str()).await?;

        let (proposal_id, vote_result_debug) =
            submit_and_approve_proposal(state, treasury_id, auth_proposal).await?;

        tracing::info!(
            "Confidential setup: auth proposal #{} approved for {}",
            proposal_id,
            treasury_id
        );

        let sig_bytes = extract_mpc_signature(&vote_result_debug).ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to extract MPC signature from auth proposal result".to_string(),
            )
        })?;
        let sig_b58 = format!("ed25519:{}", bs58::encode(&sig_bytes).into_string());

        authenticate_with_1click(
            state,
            treasury_id,
            &treasury_id_public_key,
            &auth_payload,
            &sig_b58,
        )
        .await?;

        tracing::info!(
            "Confidential setup: DAO {} authenticated with 1Click",
            treasury_id
        );
    }

    if let Some(tx) = progress {
        send_progress(tx, "authenticating", "completed").await;
    }

    // ── Create + auth bulk-payment subaccount ───────────────────────────
    if let Some(tx) = progress {
        send_progress(tx, "bulk_payment_setup", "in_progress").await;
    }

    if let Err(e) = setup_bulk_payment_subaccount(state, treasury_id).await {
        // Don't fail the whole confidential setup if bulk-payment provisioning
        // breaks — the DAO is still usable for non-bulk confidential flows.
        tracing::error!(
            "Bulk-payment subaccount setup failed for {}: {} ({})",
            treasury_id,
            e.1,
            e.0
        );
        if let Some(tx) = progress {
            send_progress(tx, "bulk_payment_setup", "failed").await;
        }
    } else if let Some(tx) = progress {
        send_progress(tx, "bulk_payment_setup", "completed").await;
    }

    // ── Change policy to user's config ──────────────────────────────────
    if let Some(tx) = progress {
        send_progress(tx, "setting_policy", "in_progress").await;
    }

    let change_policy_proposal = json!({
        "proposal": {
            "description": "Set treasury policy to user configuration",
            "kind": {
                "ChangePolicy": {
                    "policy": target_policy,
                }
            }
        }
    });

    let (policy_proposal_id, _) =
        submit_and_approve_proposal(state, treasury_id, change_policy_proposal).await?;

    tracing::info!(
        "Confidential setup: policy proposal #{} approved for {}",
        policy_proposal_id,
        treasury_id
    );

    if let Some(tx) = progress {
        send_progress(tx, "setting_policy", "completed").await;
    }

    Ok(())
}

/// Derive `<prefix>.<factory>` from a sputnik-dao id and the factory account.
/// Mirrors the contract-side derivation in `bulk-payment::create_confidential_subaccount`.
pub fn derive_bulk_subaccount_id(
    dao_id: &AccountId,
    factory_id: &AccountId,
) -> Result<AccountId, (StatusCode, String)> {
    let prefix = dao_id
        .as_str()
        .strip_suffix(".sputnik-dao.near")
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                format!("dao_id {} must end with .sputnik-dao.near", dao_id),
            )
        })?;
    if prefix.is_empty() || prefix.contains('.') {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "dao_id {} must have exactly one label before the suffix",
                dao_id
            ),
        ));
    }
    format!("{}.{}", prefix, factory_id).parse().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("derived sub id invalid: {}", e),
        )
    })
}

/// Provision the per-DAO bulk-payment subaccount and authenticate it with 1Click.
///
/// Steps:
/// 1. Call factory `bulk-payment.near::create_confidential_subaccount({dao_id})`.
///    Factory creates `<prefix>.bulk-payment.near`, deploys global code, runs init + bootstrap.
/// 2. Poll `<sub>::get_bootstrap_status` until `Ready { mpc_public_key, dao_mpc_public_key }`.
/// 3. Build NEP-413 auth proposal with `signer_id=<sub>`, `path=<dao_id>`. The DAO
///    submits + approves; the resulting MPC signature uses the DAO's key, which is
///    valid for `<sub>` because `bootstrap` registered the DAO's pubkey under `<sub>`
///    on intents.near.
/// 4. Authenticate with 1Click using sub as `signer_id` + DAO's pubkey + extracted sig.
/// 5. Store JWT in `bulk_payment_*` columns on `monitored_accounts`.
async fn setup_bulk_payment_subaccount(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
) -> Result<(), (StatusCode, String)> {
    let factory_id = state.bulk_payment_contract_id.clone();
    let sub_id = derive_bulk_subaccount_id(treasury_id, &factory_id)?;

    tracing::info!(
        "Bulk-payment setup: creating subaccount {} via factory {}",
        sub_id,
        factory_id
    );

    // 1. Factory call. Backend-signed (subsidized); the contract requires
    //    `>= 0.1 NEAR` attached, but we send a bit more for storage headroom.
    near_api::Contract(factory_id.clone())
        .call_function(
            "create_confidential_subaccount",
            json!({ "dao_id": treasury_id }),
        )
        .transaction()
        .deposit(NearToken::from_millinear(150))
        .gas(NearGas::from_tgas(150))
        .with_signer(state.signer_id.clone(), state.signer.clone())
        .send_to(&state.network)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("factory create_confidential_subaccount failed: {}", e),
            )
        })?
        .into_result()
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("factory create_confidential_subaccount failed: {}", e),
            )
        })?;

    // 2. Poll bootstrap status. Bootstrap fans out 2× derived_public_key + 2×
    //    add_public_key, so it usually settles in 1–2 blocks; cap at ~30s.
    let dao_mpc_public_key = poll_bootstrap_ready(state, &sub_id).await?;

    // 3. Build + submit auth proposal (DAO signs, JWT issued for sub).
    let (auth_proposal, auth_payload) =
        build_bulk_payment_auth_proposal(state, sub_id.as_str()).await?;

    let (proposal_id, vote_result_debug) =
        submit_and_approve_proposal(state, treasury_id, auth_proposal).await?;

    tracing::info!(
        "Bulk-payment setup: auth proposal #{} approved for {}",
        proposal_id,
        sub_id
    );

    // 4. Extract MPC sig + authenticate with 1Click.
    let sig_bytes = extract_mpc_signature(&vote_result_debug).ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to extract MPC signature from bulk-payment auth proposal".to_string(),
        )
    })?;
    let sig_b58 = format!("ed25519:{}", bs58::encode(&sig_bytes).into_string());

    authenticate_bulk_payment_with_1click(
        state,
        treasury_id,
        &dao_mpc_public_key,
        &auth_payload,
        &sig_b58,
    )
    .await?;

    tracing::info!(
        "Bulk-payment setup: subaccount {} authenticated with 1Click",
        sub_id
    );

    Ok(())
}

/// Poll `<sub>::get_bootstrap_status` until `Ready` or timeout (~30s).
/// Returns the DAO MPC pubkey from the Ready state.
async fn poll_bootstrap_ready(
    state: &Arc<AppState>,
    sub_id: &AccountId,
) -> Result<String, (StatusCode, String)> {
    const MAX_ATTEMPTS: u32 = 30;
    const SLEEP_MS: u64 = 1000;

    for attempt in 0..MAX_ATTEMPTS {
        let status: Value = match Contract(sub_id.clone())
            .call_function("get_bootstrap_status", ())
            .read_only()
            .fetch_from(&state.network)
            .await
        {
            Ok(r) => r.data,
            Err(e) => {
                // Subaccount may not exist yet on the very first attempts.
                tracing::debug!(
                    "get_bootstrap_status attempt {} for {}: {}",
                    attempt + 1,
                    sub_id,
                    e
                );
                tokio::time::sleep(std::time::Duration::from_millis(SLEEP_MS)).await;
                continue;
            }
        };

        // Status enum is serialized as `"Pending"` | `"InProgress"` |
        // `{ "Ready": { "mpc_public_key": ..., "dao_mpc_public_key": ... } }`
        // | `{ "Failed": { "reason": ... } }`.
        if let Some(ready) = status.get("Ready") {
            if let Some(dao_pk) = ready.get("dao_mpc_public_key").and_then(|v| v.as_str()) {
                return Ok(dao_pk.to_string());
            }
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "Ready state missing dao_mpc_public_key".to_string(),
            ));
        }
        if let Some(failed) = status.get("Failed") {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("bulk-payment subaccount bootstrap failed: {:?}", failed),
            ));
        }

        // Pending / InProgress — keep polling.
        tokio::time::sleep(std::time::Duration::from_millis(SLEEP_MS)).await;
    }

    Err((
        StatusCode::GATEWAY_TIMEOUT,
        format!(
            "bulk-payment subaccount {} did not reach Ready in time",
            sub_id
        ),
    ))
}

/// Authenticate the bulk-payment subaccount with the 1Click API and persist
/// the JWT in the `bulk_payment_*` columns of `monitored_accounts`.
async fn authenticate_bulk_payment_with_1click(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    dao_public_key: &str,
    auth_payload: &Value,
    signature: &str,
) -> Result<(), (StatusCode, String)> {
    let url = format!(
        "{}/v0/auth/authenticate",
        state.env_vars.confidential_api_url
    );

    let body = json!({
        "signedData": {
            "standard": "nep413",
            "payload": auth_payload,
            "public_key": dao_public_key,
            "signature": signature,
        }
    });

    let mut req = state
        .http_client
        .post(&url)
        .header("content-type", "application/json");
    if let Some(api_key) = &state.env_vars.oneclick_api_key {
        req = req.header("x-api-key", api_key);
    }

    let response = req.json(&body).send().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("1Click bulk-payment auth request failed: {}", e),
        )
    })?;

    let status = response.status();
    let resp_body: Value = response.json().await.unwrap_or_default();

    if !status.is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!(
                "1Click bulk-payment auth failed ({}): {:?}",
                status, resp_body
            ),
        ));
    }

    if let (Some(access_token), Some(refresh_token)) = (
        resp_body.get("accessToken").and_then(|v| v.as_str()),
        resp_body.get("refreshToken").and_then(|v| v.as_str()),
    ) {
        let expires_in = resp_body
            .get("expiresIn")
            .and_then(|v| v.as_i64())
            .unwrap_or(3600);
        let expires_at = chrono::Utc::now() + chrono::Duration::seconds(expires_in);

        sqlx::query!(
            r#"
            UPDATE monitored_accounts
            SET bulk_payment_access_token = $1,
                bulk_payment_refresh_token = $2,
                bulk_payment_token_expires_at = $3
            WHERE account_id = $4
            "#,
            access_token,
            refresh_token,
            expires_at,
            treasury_id.as_str(),
        )
        .execute(&state.db_pool)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to persist bulk-payment JWT: {}", e),
            )
        })?;

        tracing::info!(
            "Stored bulk-payment JWT for DAO {} (expires in {}s)",
            treasury_id,
            expires_in
        );
    } else {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!(
                "1Click bulk-payment auth response missing tokens: {:?}",
                resp_body
            ),
        ));
    }

    Ok(())
}

/// Check whether `intents.near` already has the given public key registered
/// for the treasury. Used to make the `add_public_key` step idempotent on
/// resume.
async fn intents_has_public_key(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    public_key: &str,
) -> Result<bool, (StatusCode, String)> {
    Contract(INTENTS_CONTRACT_ID.into())
        .call_function(
            "has_public_key",
            json!({
                "account_id": treasury_id.as_str(),
                "public_key": public_key,
            }),
        )
        .read_only::<bool>()
        .fetch_from(&state.network)
        .await
        .map(|r| r.data)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to check has_public_key on intents.near: {e}"),
            )
        })
}

/// Whether a treasury already holds a non-expired 1Click access token. Used to
/// skip the auth proposal + 1Click authentication on resume.
async fn has_valid_confidential_token(pool: &sqlx::PgPool, treasury_id: &AccountId) -> bool {
    sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM monitored_accounts
            WHERE account_id = $1
              AND confidential_access_token IS NOT NULL
              AND (
                confidential_token_expires_at IS NULL
                OR confidential_token_expires_at > NOW()
              )
        )
        "#,
    )
    .bind(treasury_id.as_str())
    .fetch_one(pool)
    .await
    .unwrap_or(false)
}

/// Submit a proposal and immediately approve it.
///
/// Returns `(proposal_id, vote_result_debug)`. The debug string can be
/// inspected for MPC signatures when the proposal triggers a v1.signer call.
///
/// Assumes `state.signer_id` is a member with sufficient permissions and
/// the vote threshold is 1.
async fn submit_and_approve_proposal(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    proposal: Value,
) -> Result<(u64, String), (StatusCode, String)> {
    // Submit proposal
    near_api::Contract(treasury_id.clone())
        .call_function("add_proposal", proposal)
        .transaction()
        .gas(NearGas::from_tgas(100))
        .with_signer(state.signer_id.clone(), state.signer.clone())
        .wait_until(near_openapi_types::TxExecutionStatus::ExecutedOptimistic)
        .send_to(&state.network)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to submit proposal: {}", e),
            )
        })?
        .into_result()
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Proposal submission failed: {}", e),
            )
        })?;

    // Get the proposal ID (last_id - 1)
    let last_id: u64 = Contract(treasury_id.clone())
        .call_function("get_last_proposal_id", ())
        .read_only::<u64>()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to get last proposal ID: {}", e),
            )
        })?
        .data;
    let proposal_id = last_id - 1;

    // Fetch the proposal to get its kind (required by act_proposal)
    let proposal_data: Value = Contract(treasury_id.clone())
        .call_function("get_proposal", json!({"id": proposal_id}))
        .read_only::<Value>()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch proposal #{}: {}", proposal_id, e),
            )
        })?
        .data;
    let kind = &proposal_data["kind"];

    // Vote to approve
    let result = near_api::Contract(treasury_id.clone())
        .call_function(
            "act_proposal",
            json!({
                "id": proposal_id,
                "action": "VoteApprove",
                "proposal": kind,
            }),
        )
        .transaction()
        .max_gas()
        .deposit(NearToken::from_yoctonear(0))
        .with_signer(state.signer_id.clone(), state.signer.clone())
        .send_to(&state.network)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to vote on proposal #{}: {}", proposal_id, e),
            )
        })?;

    Ok((proposal_id, format!("{:?}", result)))
}

/// Authenticate the DAO with the 1Click API using an MPC signature.
async fn authenticate_with_1click(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    treasury_id_public_key: &String,
    auth_payload: &Value,
    signature: &str,
) -> Result<(), (StatusCode, String)> {
    let url = format!(
        "{}/v0/auth/authenticate",
        state.env_vars.confidential_api_url
    );

    let body = json!({
        "signedData": {
            "standard": "nep413",
            "payload": auth_payload,
            "public_key": treasury_id_public_key,
            "signature": signature,
        }
    });

    let mut req = state
        .http_client
        .post(&url)
        .header("content-type", "application/json");

    if let Some(api_key) = &state.env_vars.oneclick_api_key {
        req = req.header("x-api-key", api_key);
    }

    let response = req.json(&body).send().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("1Click auth request failed: {}", e),
        )
    })?;

    let status = response.status();
    let resp_body: Value = response.json().await.unwrap_or_default();

    if !status.is_success() {
        let sanitized_body = sanitize_sensitive_json_value(&resp_body);
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("1Click auth failed ({}): {:?}", status, sanitized_body),
        ));
    }

    // Store JWT tokens in monitored_accounts
    if let (Some(access_token), Some(refresh_token)) = (
        resp_body.get("accessToken").and_then(|v| v.as_str()),
        resp_body.get("refreshToken").and_then(|v| v.as_str()),
    ) {
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
            treasury_id.as_str(),
        )
        .execute(&state.db_pool)
        .await;

        tracing::info!(
            "Stored confidential JWT for DAO {} (expires in {}s)",
            treasury_id,
            expires_in
        );
    }

    Ok(())
}
