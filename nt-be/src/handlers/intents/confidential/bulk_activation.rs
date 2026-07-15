//! Bulk-payment activation for EXISTING confidential treasuries.
//!
//! Newly created confidential treasuries get their bulk-payment subaccount
//! provisioned and 1Click-authenticated during creation (the backend signer
//! is the sole threshold-1 member at that point). Treasuries created before
//! the feature — or whose setup step failed — need a retrofit that involves
//! their real multisig:
//!
//! 1. `POST /activation/prepare` — the backend (subsidized) makes sure the
//!    `<prefix>.bulkpayment.near` subaccount exists and is bootstrapped,
//!    builds the `v1.signer` `sign` auth proposal, stores the pending auth
//!    payload as a `confidential_intents` row (`intent_type = 'bulk_auth'`),
//!    and returns the proposal for the frontend to submit with the user's
//!    wallet.
//! 2. The DAO members approve the proposal — the one round of multisig
//!    approvals. The final approving vote executes the `v1.signer.sign`
//!    call, and the vote relay (`try_auto_submit_intent`) extracts the MPC
//!    signature, authenticates the subaccount with 1Click, and stores the
//!    JWT in `monitored_accounts.bulk_payment_*`.
//! 3. `GET /activation` — status polling for the UI.

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

use crate::handlers::intents::confidential::prepare_auth::build_bulk_payment_auth_proposal;
use crate::handlers::relay::confidential::compute_nep413_hash;
use crate::handlers::treasury::confidential_setup::{
    derive_bulk_subaccount_id, ensure_bulk_subaccount,
};
use crate::{AppState, auth::AuthUser};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BulkActivationState {
    /// JWT stored — bulk payments work.
    Active,
    /// An auth proposal payload is pending — waiting for the proposal to be
    /// created and/or approved by the multisig.
    AwaitingApproval,
    /// The last activation attempt failed (e.g. auth deadline passed before
    /// enough approvals) — the flow can be restarted with `prepare`.
    Failed,
    /// No activation in progress.
    Inactive,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BulkActivationStatus {
    pub status: BulkActivationState,
    /// The DAO's bulk-payment subaccount id.
    pub bulk_account_id: String,
    /// NEP-413 payload hash of the pending auth proposal, when awaiting
    /// approval. Matches the `payload_v2.Eddsa` hex inside the proposal's
    /// `v1.signer` FunctionCall args — the FE uses it to find the proposal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_payload_hash: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActivationStatusQuery {
    pub dao_id: String,
}

fn parse_dao_id(dao_id: &str) -> Result<AccountId, (StatusCode, String)> {
    dao_id.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid daoId '{}': {}", dao_id, e),
        )
    })
}

/// Confirms the account is a monitored confidential treasury; returns
/// whether the bulk-payment JWT is already stored.
async fn load_bulk_token_state(
    state: &AppState,
    dao_id: &str,
) -> Result<bool, (StatusCode, String)> {
    let row: Option<(bool, Option<String>)> = sqlx::query_as(
        r#"
        SELECT is_confidential_account, bulk_payment_access_token
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
    )
    .bind(dao_id)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to load treasury {}: {}", dao_id, e),
        )
    })?;

    match row {
        Some((true, token)) => Ok(token.is_some()),
        Some((false, _)) => Err((
            StatusCode::BAD_REQUEST,
            format!("{} is not a confidential treasury", dao_id),
        )),
        None => Err((
            StatusCode::NOT_FOUND,
            format!("Treasury {} not found", dao_id),
        )),
    }
}

/// Whether the activation proposal for `payload_hash` still exists on-chain
/// and is pending approval. A `pending` DB row is written by `prepare` before
/// the client creates the proposal, so it alone doesn't mean a live proposal
/// exists — check the DAO's recent proposals (matched by the NEP-413
/// `payload_hash`) so a never-created / rejected / expired proposal doesn't
/// strand the UI on "awaiting approvals".
async fn activation_proposal_pending(
    state: &Arc<AppState>,
    dao_id: &AccountId,
    payload_hash: &str,
) -> bool {
    use crate::handlers::proposals::scraper::{
        ProposalStatus, extract_payload_hash_from_kind, fetch_recent_proposals,
    };
    // The activation proposal is created right after prepare, so it's in the
    // tail of the proposal list.
    const RECENT_PROPOSALS: u64 = 50;
    match fetch_recent_proposals(&state.network, dao_id, RECENT_PROPOSALS).await {
        Ok(proposals) => proposals.iter().any(|p| {
            p.status == ProposalStatus::InProgress
                && extract_payload_hash_from_kind(&p.kind).as_deref() == Some(payload_hash)
        }),
        Err(e) => {
            // On RPC failure don't flip a genuine awaiting state to inactive —
            // keep the current behavior and let the next poll re-check.
            tracing::warn!(
                dao = %dao_id,
                error = %e,
                "activation proposal check failed; assuming still pending"
            );
            true
        }
    }
}

/// GET /api/confidential-intents/bulk-payment/activation?daoId=…
pub async fn get_bulk_activation_status(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Query(query): Query<ActivationStatusQuery>,
) -> Result<Json<BulkActivationStatus>, (StatusCode, String)> {
    let dao_id = parse_dao_id(&query.dao_id)?;
    // Don't leak activation/monitoring state to non-members. Read-only, so a
    // plain membership check (not AddProposal) — matches the other
    // confidential GET endpoints (history refresh, snapshot chart).
    auth_user
        .verify_member_if_confidential(&state.db_pool, &dao_id)
        .await?;
    let bulk_account_id =
        derive_bulk_subaccount_id(&dao_id, &state.bulk_payment_contract_id)?.to_string();

    if load_bulk_token_state(&state, dao_id.as_str()).await? {
        return Ok(Json(BulkActivationStatus {
            status: BulkActivationState::Active,
            bulk_account_id,
            pending_payload_hash: None,
        }));
    }

    // Latest bulk_auth attempt decides between awaiting / failed / inactive.
    let latest: Option<(String, String)> = sqlx::query_as(
        r#"
        SELECT status, payload_hash
        FROM confidential_intents
        WHERE dao_id = $1 AND intent_type = 'bulk_auth'
        ORDER BY updated_at DESC
        LIMIT 1
        "#,
    )
    .bind(dao_id.as_str())
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to load activation state: {}", e),
        )
    })?;

    let (status, pending_payload_hash) = match latest {
        Some((status, hash)) if status == "pending" => {
            // A `pending` row means `prepare` built + stored the proposal, but
            // it's only genuinely "awaiting approvals" if that proposal was
            // actually created on-chain and is still pending. If the client
            // never created it (e.g. the wallet never showed the signing
            // dialog), or it was rejected/expired, treat activation as
            // `inactive` so the UI offers "Start activation" again instead of
            // getting stuck on "awaiting approvals".
            if activation_proposal_pending(&state, &dao_id, &hash).await {
                (BulkActivationState::AwaitingApproval, Some(hash))
            } else {
                (BulkActivationState::Inactive, None)
            }
        }
        Some((status, _)) if status == "failed" => (BulkActivationState::Failed, None),
        _ => (BulkActivationState::Inactive, None),
    };

    Ok(Json(BulkActivationStatus {
        status,
        bulk_account_id,
        pending_payload_hash,
    }))
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrepareActivationRequest {
    pub dao_id: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrepareActivationResponse {
    pub bulk_account_id: String,
    /// SputnikDAO `add_proposal` args (`{ proposal: { description, kind } }`)
    /// — submit with the user's wallet.
    pub proposal: Value,
    /// NEP-413 hash of the auth payload inside the proposal.
    pub payload_hash: String,
}

/// POST /api/confidential-intents/bulk-payment/activation/prepare
///
/// Idempotent: re-preparing supersedes any previous pending attempt (its
/// proposal would authenticate a stale payload and is ignored on approval).
pub async fn prepare_bulk_activation(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Json(request): Json<PrepareActivationRequest>,
) -> Result<Json<PrepareActivationResponse>, (StatusCode, String)> {
    let dao_id = parse_dao_id(&request.dao_id)?;
    auth_user.verify_can_add_proposal(&state, &dao_id).await?;

    if load_bulk_token_state(&state, dao_id.as_str()).await? {
        return Err((
            StatusCode::CONFLICT,
            "Bulk payments are already activated for this treasury".to_string(),
        ));
    }

    // 1. Subaccount + MPC bootstrap (backend-subsidized, idempotent).
    let (sub_id, _dao_mpc_public_key) = ensure_bulk_subaccount(&state, &dao_id).await?;

    // 2. Build the auth proposal the multisig must approve.
    let (proposal, auth_payload) =
        build_bulk_payment_auth_proposal(&state, sub_id.as_str()).await?;
    let payload_hash = compute_nep413_hash(&auth_payload).ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to compute auth payload hash".to_string(),
        )
    })?;

    // 3. Supersede any previous pending attempt, then store this one for the
    //    vote relay to complete after the multisig approves.
    let mut tx = state.db_pool.begin().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to start activation transaction: {}", e),
        )
    })?;

    sqlx::query(
        r#"
        UPDATE confidential_intents
        SET status = 'superseded', updated_at = NOW()
        WHERE dao_id = $1 AND intent_type = 'bulk_auth' AND status = 'pending'
        "#,
    )
    .bind(dao_id.as_str())
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to supersede previous activation: {}", e),
        )
    })?;

    sqlx::query(
        r#"
        INSERT INTO confidential_intents (dao_id, payload_hash, intent_payload, intent_type)
        VALUES ($1, $2, $3, 'bulk_auth')
        ON CONFLICT (dao_id, payload_hash) DO UPDATE SET
            intent_payload = EXCLUDED.intent_payload,
            intent_type = 'bulk_auth',
            status = 'pending',
            submit_result = NULL,
            updated_at = NOW()
        "#,
    )
    .bind(dao_id.as_str())
    .bind(&payload_hash)
    .bind(&auth_payload)
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to store pending activation: {}", e),
        )
    })?;

    tx.commit().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to commit activation: {}", e),
        )
    })?;

    tracing::info!(
        "Prepared bulk-payment activation for {} (sub={}, hash={})",
        dao_id,
        sub_id,
        payload_hash
    );

    Ok(Json(PrepareActivationResponse {
        bulk_account_id: sub_id.to_string(),
        proposal,
        payload_hash,
    }))
}
