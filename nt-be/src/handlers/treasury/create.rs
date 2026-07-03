use std::collections::HashSet;
use std::sync::Arc;

use axum::response::sse::{Event, KeepAlive, Sse};
use axum::{Json, extract::State};
use base64::{Engine, prelude::BASE64_STANDARD};
use bigdecimal::BigDecimal;
use futures::stream::Stream;
use near_api::{Account, AccountId, Contract, NearToken, Tokens};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::{
    AppState,
    constants::TREASURY_FACTORY_CONTRACT_ID,
    handlers::balance_changes::utils::is_transport_error,
    services::{
        mark_testing_if_needed, register_new_dao_and_wait, register_or_refresh_monitored_account,
        should_mark_testing,
    },
};

use super::confidential_setup;
use super::creation_requests;

pub const TREASURY_CREATE_DEPOSIT: NearToken = NearToken::from_millinear(90);
pub const REGISTERING_DAO_TIMEOUT_IN_SECS: u64 = 10;

/// Total attempts for the idempotent creation flow before surfacing a terminal
/// error to the client. Retries fire for transient transport/RPC errors
/// (including near-api `Critical` transport errors like timeouts/connection
/// failures, which it won't fail over on) — each attempt resumes and skips
/// already-completed steps.
const MAX_CREATION_ATTEMPTS: u32 = 4;

/// Cap on the exponential backoff between creation attempts.
const MAX_CREATION_RETRY_BACKOFF_MS: u64 = 4_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTreasuryRequest {
    pub name: String,
    pub account_id: AccountId,
    pub payment_threshold: u8,
    pub governance_threshold: u8,
    pub governors: Vec<AccountId>,
    pub financiers: Vec<AccountId>,
    pub requestors: Vec<AccountId>,
    #[serde(default)]
    pub is_confidential: bool,
}

#[derive(Serialize, Deserialize)]
pub struct CreateTreasuryResponse {
    pub treasury: AccountId,
}

/// Build the sputnik-dao policy JSON for the given members and thresholds.
pub fn build_policy(
    requestors: &[AccountId],
    governors: &[AccountId],
    financiers: &[AccountId],
    governance_threshold: u8,
    payment_threshold: u8,
) -> serde_json::Value {
    let one_required_vote = serde_json::json!({
      "weight_kind": "RoleWeight",
      "quorum": "0",
      "threshold": "1",
    });

    let governance_threshold_json = serde_json::json!({
      "weight_kind": "RoleWeight",
      "quorum": "0",
      "threshold": governance_threshold.to_string(),
    });

    let payment_threshold_json = serde_json::json!({
      "weight_kind": "RoleWeight",
      "quorum": "0",
      "threshold": payment_threshold.to_string(),
    });

    serde_json::json!({
      "roles": [
        {
          "kind": {
            "Group": requestors,
          },
          "name": "Requestor",
          "permissions": [
            "call:AddProposal",
            "transfer:AddProposal",
            "call:VoteRemove",
            "transfer:VoteRemove"
          ],
          "vote_policy": {
            "transfer": one_required_vote.clone(),
            "call": one_required_vote.clone()
          }
        },
        {
          "kind": {
            "Group": governors,
          },
          "name": "Admin",
          "permissions": [
            "config:*",
            "policy:*",
            "add_member_to_role:*",
            "remove_member_from_role:*",
            "upgrade_self:*",
            "upgrade_remote:*",
            "set_vote_token:*",
            "add_bounty:*",
            "bounty_done:*",
            "factory_info_update:*",
            "policy_add_or_update_role:*",
            "policy_remove_role:*",
            "policy_update_default_vote_policy:*",
            "policy_update_parameters:*",
          ],
          "vote_policy": {
            "config": governance_threshold_json.clone(),
            "policy": governance_threshold_json.clone(),
            "add_member_to_role": governance_threshold_json.clone(),
            "remove_member_from_role": governance_threshold_json.clone(),
            "upgrade_self": governance_threshold_json.clone(),
            "upgrade_remote": governance_threshold_json.clone(),
            "set_vote_token": governance_threshold_json.clone(),
            "add_bounty": governance_threshold_json.clone(),
            "bounty_done": governance_threshold_json.clone(),
            "factory_info_update": governance_threshold_json.clone(),
            "policy_add_or_update_role": governance_threshold_json.clone(),
            "policy_remove_role": governance_threshold_json.clone(),
            "policy_update_default_vote_policy": governance_threshold_json.clone(),
            "policy_update_parameters": governance_threshold_json.clone(),
          },
        },
        {
          "kind": {
            "Group": financiers,
          },
          "name": "Approver",
          "permissions": [
            "call:VoteReject",
            "call:VoteApprove",
            "call:RemoveProposal",
            "call:Finalize",
            "transfer:VoteReject",
            "transfer:VoteApprove",
            "transfer:RemoveProposal",
            "transfer:Finalize",
          ],
          "vote_policy": {
            "transfer": payment_threshold_json.clone(),
            "call": payment_threshold_json.clone(),
          },
        },
      ],
      "default_vote_policy": {
        "weight_kind": "RoleWeight",
        "quorum": "0",
        "threshold": [1, 2],
      },
      "proposal_bond": NearToken::from_millinear(0),
      "proposal_period": "604800000000000",
      "bounty_bond": NearToken::from_millinear(0),
      "bounty_forgiveness_period": "604800000000000",
    })
}

fn collect_payload_members(payload: &CreateTreasuryRequest) -> HashSet<String> {
    payload
        .requestors
        .iter()
        .chain(payload.governors.iter())
        .chain(payload.financiers.iter())
        .map(|account_id| account_id.as_str().to_string())
        .collect()
}

fn build_treasury_created_message(
    treasury: &AccountId,
    is_confidential: bool,
    is_testing: bool,
    balance_after: &str,
) -> String {
    let conf_label = if is_confidential {
        " (confidential)"
    } else {
        ""
    };
    let testing_label = if is_testing { " [TESTING]" } else { "" };
    format!(
        "Treasury created{conf_label}{testing_label}: {treasury}\nBalance after: {}",
        balance_after
    )
}

fn prepare_args(
    payload: &CreateTreasuryRequest,
    policy: &serde_json::Value,
) -> Result<serde_json::Value, serde_json::Error> {
    let config = serde_json::json!({
      "config": {
        "name": payload.name,
        "purpose": "managing digital assets",
        "metadata": "",
      },
      "policy": policy,
    });

    let bytes = BASE64_STANDARD.encode(serde_json::to_vec(&config)?);

    let name = payload
        .account_id
        .as_str()
        .strip_suffix(".sputnik-dao.near")
        .unwrap_or(payload.account_id.as_str());
    Ok(serde_json::json!({
      "name": name,
      "args": bytes,
    }))
}

#[derive(Serialize, Clone)]
pub struct ProgressEvent {
    pub step: &'static str,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub treasury: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Send a progress update through the channel.
pub async fn send_progress(
    tx: &mpsc::Sender<ProgressEvent>,
    step: &'static str,
    status: &'static str,
) {
    let _ = tx
        .send(ProgressEvent {
            step,
            status,
            treasury: None,
            message: None,
        })
        .await;
}

pub async fn create_treasury_stream(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateTreasuryRequest>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let (tx, mut rx) = mpsc::channel::<ProgressEvent>(32);

    tokio::spawn(async move {
        if let Err(evt) = run_creation(state, payload, tx.clone()).await {
            tracing::error!(
                "Treasury creation failed: step={}, status={}, message={}",
                evt.step,
                evt.status,
                evt.message.as_deref().unwrap_or("unknown error")
            );
            let _ = tx.send(evt).await;
        }
    });

    let stream = async_stream::stream! {
        while let Some(evt) = rx.recv().await {
            let is_terminal = evt.step == "done" || evt.step == "error";
            if let Ok(json) = serde_json::to_string(&evt) {
                yield Ok(Event::default().data(json));
            }
            if is_terminal {
                break;
            }
        }
    };

    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Treasury creation is blocked if either the env kill-switch is set, or an
/// active `paused` `treasury-creation` warning slot is live (so the team can
/// pause creation from the admin panel without a redeploy).
async fn treasury_creation_blocked(state: &AppState) -> bool {
    if state.env_vars.disable_treasury_creation {
        return true;
    }

    sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM warning_slots
            WHERE slot = 'treasury-creation'
              AND response = 'paused'
              AND (
                is_active = true
                OR (show_from IS NOT NULL AND show_from <= NOW())
              )
              AND (ends_at IS NULL OR ends_at > NOW())
        )
        "#,
    )
    .fetch_one(&state.db_pool)
    .await
    .unwrap_or_else(|e| {
        tracing::error!("Failed to check treasury-creation pause warning: {}", e);
        false
    })
}

/// Whether a failed creation attempt should be retried: only transient
/// transport/RPC errors are retried, and only while attempts remain.
fn creation_error_retryable(attempt: u32, message: &str) -> bool {
    attempt < MAX_CREATION_ATTEMPTS && is_transport_error(message)
}

/// Whether an error is terminal — it can never succeed on retry, so neither the
/// in-request loop nor the background sweeper should keep trying. Currently this
/// is the `ExistingDaoState::Taken` case: the handle exists and belongs to an
/// account we don't control.
pub(crate) fn is_terminal_creation_error(message: &str) -> bool {
    message.contains("already taken")
}

/// Build an SSE error event with the given message.
fn error_event(message: String) -> ProgressEvent {
    ProgressEvent {
        step: "error",
        status: "error",
        treasury: None,
        message: Some(message),
    }
}

/// On-chain classification of a treasury account, used to make creation
/// idempotent/resumable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExistingDaoState {
    /// Account does not exist yet — proceed to create it.
    Absent,
    /// Account exists and our backend signer is still a policy member — a
    /// partially-completed (confidential) setup we own; safe to resume.
    OursIncomplete,
    /// Account exists and ownership already reflects the user's members — the
    /// prior run effectively finished; skip creation/setup and finalize.
    AlreadyOwnedByUser,
    /// Account exists but is not ours — the handle is taken by someone else.
    Taken,
}

/// Fetch a DAO's current sputnik policy.
async fn fetch_dao_policy(
    state: &AppState,
    treasury: &AccountId,
) -> Result<serde_json::Value, String> {
    Contract(treasury.clone())
        .call_function("get_policy", ())
        .read_only::<serde_json::Value>()
        .fetch_from(&state.network)
        .await
        .map(|r| r.data)
        .map_err(|e| format!("Failed to fetch DAO policy: {e}"))
}

/// Collect all member account IDs across every `Group` role in a policy.
fn policy_group_members(policy: &serde_json::Value) -> HashSet<String> {
    let mut members = HashSet::new();
    if let Some(roles) = policy.get("roles").and_then(|r| r.as_array()) {
        for role in roles {
            if let Some(group) = role
                .get("kind")
                .and_then(|k| k.get("Group"))
                .and_then(|g| g.as_array())
            {
                for m in group {
                    if let Some(s) = m.as_str() {
                        members.insert(s.to_string());
                    }
                }
            }
        }
    }
    members
}

/// Determine whether the treasury account already exists and, if so, whether
/// it's a resumable half-created DAO we own, an already-finished one, or a
/// name taken by someone else.
async fn classify_treasury_account(
    state: &AppState,
    treasury: &AccountId,
    signer_id: &str,
    expected_members: &HashSet<String>,
) -> Result<ExistingDaoState, String> {
    match Account(treasury.clone())
        .view()
        .fetch_from(&state.network)
        .await
    {
        Err(e) if e.to_string().contains("UnknownAccount") => Ok(ExistingDaoState::Absent),
        Err(e) => Err(format!("Failed to check treasury account: {e}")),
        Ok(_) => {
            // Account exists — inspect its DAO policy to decide ownership.
            let policy = fetch_dao_policy(state, treasury).await?;
            let members = policy_group_members(&policy);
            if members.contains(signer_id) {
                // Backend signer still controls the DAO → sponsor-only policy,
                // confidential setup never finished. Resume it.
                Ok(ExistingDaoState::OursIncomplete)
            } else if !expected_members.is_empty() && expected_members.is_subset(&members) {
                // Ownership already handed to the user's members.
                Ok(ExistingDaoState::AlreadyOwnedByUser)
            } else {
                Ok(ExistingDaoState::Taken)
            }
        }
    }
}

/// Entry point spawned by the SSE handler. Serializes concurrent/duplicate
/// creation attempts for the same treasury behind a Postgres advisory lock,
/// then runs the (idempotent, resumable) creation flow.
pub(crate) async fn run_creation(
    state: Arc<AppState>,
    payload: CreateTreasuryRequest,
    tx: mpsc::Sender<ProgressEvent>,
) -> Result<(), ProgressEvent> {
    let treasury = payload.account_id.clone();

    if treasury_creation_blocked(&state).await {
        let message = format!("Treasury creation disabled. Treasury: {treasury} is not created.");
        if let Err(e) = state.telegram_client.send_message(&message).await {
            tracing::warn!("Failed to send Telegram notification: {}", e);
        }
        return Err(error_event(message));
    }

    // Per-account advisory lock: two concurrent create-stream calls for the
    // same treasury must not run the multi-step flow at the same time. We hold
    // a dedicated connection for the lock's lifetime and unlock explicitly
    // (returning a pooled connection does not release a session-level lock).
    let mut lock_conn = state.db_pool.acquire().await.map_err(|e| {
        tracing::error!("Failed to acquire DB connection for creation lock: {e}");
        error_event(format!("Internal error acquiring creation lock: {e}"))
    })?;

    let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtext($1)::bigint)")
        .bind(treasury.as_str())
        .fetch_one(&mut *lock_conn)
        .await
        .unwrap_or(false);

    if !locked {
        return Err(error_event(format!(
            "Treasury creation is already in progress for {treasury}. Please wait for it to finish."
        )));
    }

    // Persist the creation intent so the background sweeper can resume/finish
    // this treasury if every in-request attempt below fails (or the process
    // dies). For confidential DAOs the target policy isn't recoverable from
    // chain, so this stored request is the only way to complete them later.
    if let Err(e) = creation_requests::record_creation_started(&state.db_pool, &payload).await {
        tracing::warn!("Failed to record creation start for {}: {}", treasury, e);
    }

    // Auto-retry the (idempotent) flow on transient failures so the user never
    // has to intervene. The spawned task outlives the SSE connection, so this
    // keeps making progress even if the client disconnects.
    let mut result = Ok(());
    for attempt in 1..=MAX_CREATION_ATTEMPTS {
        result = run_creation_inner(&state, &payload, &tx).await;

        match &result {
            Ok(()) => break,
            Err(evt) => {
                let message = evt.message.as_deref().unwrap_or_default();
                if !creation_error_retryable(attempt, message) {
                    break;
                }
                let delay = std::time::Duration::from_millis(
                    (500 * 2u64.pow(attempt - 1)).min(MAX_CREATION_RETRY_BACKOFF_MS),
                );
                tracing::warn!(
                    "Treasury creation for {} failed on attempt {}/{} (retryable): {}. Retrying in {:?}",
                    treasury,
                    attempt,
                    MAX_CREATION_ATTEMPTS,
                    message,
                    delay
                );
                tokio::time::sleep(delay).await;
            }
        }
    }

    // Record the terminal outcome so the sweeper knows whether to keep trying.
    match &result {
        Ok(()) => {
            // Success → drop the row so the table doesn't accumulate finished
            // creations; only pending/failed rows are retained.
            if let Err(e) =
                creation_requests::delete_creation_request(&state.db_pool, treasury.as_str()).await
            {
                tracing::warn!("Failed to delete creation request for {}: {}", treasury, e);
            }
        }
        Err(evt) => {
            let message = evt.message.as_deref().unwrap_or_default();
            if is_terminal_creation_error(message) {
                // The handle is taken by an account we don't control — retrying
                // can never succeed, so mark it `failed` and do NOT wake the
                // sweeper (which would otherwise burn its attempts + alert).
                if let Err(e) = creation_requests::mark_creation_failed(
                    &state.db_pool,
                    treasury.as_str(),
                    message,
                )
                .await
                {
                    tracing::warn!("Failed to mark creation failed for {}: {}", treasury, e);
                }
            } else {
                // Flip to `pending` so the sweeper picks it up, then wake the
                // sweeper right away instead of waiting for its next poll tick.
                if let Err(e) = creation_requests::mark_creation_pending(
                    &state.db_pool,
                    treasury.as_str(),
                    message,
                )
                .await
                {
                    tracing::warn!("Failed to mark creation pending for {}: {}", treasury, e);
                }
                state.creation_sweep_notify.notify_one();
            }
        }
    }

    if let Err(e) = sqlx::query("SELECT pg_advisory_unlock(hashtext($1)::bigint)")
        .bind(treasury.as_str())
        .execute(&mut *lock_conn)
        .await
    {
        tracing::warn!("Failed to release creation lock for {}: {}", treasury, e);
    }

    result
}

async fn run_creation_inner(
    state: &Arc<AppState>,
    payload: &CreateTreasuryRequest,
    tx: &mpsc::Sender<ProgressEvent>,
) -> Result<(), ProgressEvent> {
    let treasury = payload.account_id.clone();
    let is_confidential = payload.is_confidential;

    let user_policy = build_policy(
        &payload.requestors,
        &payload.governors,
        &payload.financiers,
        payload.governance_threshold,
        payload.payment_threshold,
    );

    let creation_policy = if is_confidential {
        let sponsor = vec![state.signer_id.clone()];
        build_policy(&sponsor, &sponsor, &sponsor, 1, 1)
    } else {
        user_policy.clone()
    };

    let payload_members = collect_payload_members(payload);

    // ── Step 1: Create DAO (idempotent / resumable) ────────────────────
    send_progress(tx, "creating_dao", "in_progress").await;

    let existing =
        classify_treasury_account(state, &treasury, state.signer_id.as_str(), &payload_members)
            .await
            .map_err(error_event)?;

    let mut did_create = false;
    match existing {
        ExistingDaoState::Taken => {
            return Err(error_event(format!(
                "The name \"{treasury}\" is already taken. Please choose a different treasury name."
            )));
        }
        ExistingDaoState::Absent => {
            let args = prepare_args(payload, &creation_policy).map_err(|e| {
                tracing::error!("Error preparing args: {}", e);
                error_event(e.to_string())
            })?;

            // near-api retries the broadcast of this single signed transaction
            // across endpoints (same tx hash → no duplicate), so we don't add
            // an app-level retry that would re-sign and risk a second DAO.
            Contract(TREASURY_FACTORY_CONTRACT_ID.into())
                .call_function("create", args)
                .transaction()
                .max_gas()
                .deposit(TREASURY_CREATE_DEPOSIT)
                .with_signer(state.signer_id.clone(), state.signer.clone())
                .send_to(&state.network)
                .await
                .map_err(|e| {
                    tracing::error!("Error creating treasury: {}", e);
                    error_event(format!("Failed to create treasury: {e}"))
                })?
                .into_result()
                .map_err(|e| {
                    tracing::error!("Error creating treasury: {}", e);
                    error_event(format!("Failed to create treasury: {e}"))
                })?;
            did_create = true;
        }
        ExistingDaoState::OursIncomplete | ExistingDaoState::AlreadyOwnedByUser => {
            tracing::info!(
                "Resuming treasury creation for {} (existing state: {:?})",
                treasury,
                existing
            );
        }
    }

    send_progress(tx, "creating_dao", "completed").await;

    if let Err(e) =
        register_or_refresh_monitored_account(&state.db_pool, &treasury, is_confidential).await
    {
        tracing::warn!("Failed to add treasury to monitored accounts: {:?}", e);
    }

    // Only charge the creation deposit + stamp created_by_trezu_at when we
    // actually broadcast the create this run; resumes must not double-count.
    if did_create {
        let creation_cost: BigDecimal = TREASURY_CREATE_DEPOSIT.as_yoctonear().into();
        if let Err(e) = sqlx::query!(
            r#"
        UPDATE monitored_accounts
        SET paid_near = paid_near + $2,
            created_by_trezu_at = NOW(),
            updated_at = NOW()
        WHERE account_id = $1
        "#,
            treasury.as_str(),
            creation_cost,
        )
        .execute(&state.db_pool)
        .await
        {
            tracing::warn!(
                "Failed to update paid_near for {}: {}",
                treasury.as_str(),
                e
            );
        }
    }

    // ── Confidential setup (idempotent per-step) ───────────────────────
    // Skip entirely if ownership already transferred to the user (finished).
    if is_confidential && existing != ExistingDaoState::AlreadyOwnedByUser {
        confidential_setup::setup_confidential_treasury(state, &treasury, user_policy, Some(tx))
            .await
            .map_err(|(_, msg)| error_event(msg))?;
    }

    let should_mark = should_mark_testing(
        treasury.as_str(),
        &payload_members,
        &state.env_vars.testing_sputnik_dao_ids,
        &state.env_vars.testing_near_account_ids,
    );
    let is_testing =
        match mark_testing_if_needed(&state.db_pool, treasury.as_str(), should_mark).await {
            Ok(value) => value,
            Err(e) => {
                tracing::warn!(
                    "Failed to update testing flag for treasury {}: {}",
                    treasury.as_str(),
                    e
                );
                should_mark
            }
        };

    // ── Finalize ───────────────────────────────────────────────────────
    send_progress(tx, "finalizing", "in_progress").await;

    match register_new_dao_and_wait(
        &state.db_pool,
        treasury.as_str(),
        std::time::Duration::from_secs(REGISTERING_DAO_TIMEOUT_IN_SECS),
    )
    .await
    {
        Ok(true) => {}
        Ok(false) => tracing::warn!("DAO {} registered but sync timed out", treasury),
        Err(e) => tracing::warn!("Failed to register new DAO in cache: {}", e),
    }

    let balance_after = Tokens::account(state.signer_id.clone())
        .near_balance()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            tracing::error!("Error fetching near balance: {}", e);
            ProgressEvent {
                step: "error",
                status: "error",
                treasury: None,
                message: Some(format!("Failed to fetch balance: {e}")),
            }
        })?;

    let message = build_treasury_created_message(
        &treasury,
        is_confidential,
        is_testing,
        &balance_after.total.to_string(),
    );
    if let Err(e) = state.telegram_client.send_message(&message).await {
        tracing::warn!("Failed to send Telegram notification: {}", e);
    }

    send_progress(tx, "finalizing", "completed").await;

    // ── Done ───────────────────────────────────────────────────────────
    let _ = tx
        .send(ProgressEvent {
            step: "done",
            status: "completed",
            treasury: Some(treasury.to_string()),
            message: None,
        })
        .await;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creation_retry_only_on_transport_errors() {
        // Transient transport errors are retried while attempts remain.
        assert!(creation_error_retryable(
            1,
            "TransportError: error sending request"
        ));
        assert!(creation_error_retryable(1, "operation timed out"));
        assert!(creation_error_retryable(
            MAX_CREATION_ATTEMPTS - 1,
            "connection reset"
        ));

        // Non-transport (logic) errors are never retried.
        assert!(!creation_error_retryable(
            1,
            "The name \"foo.sputnik-dao.near\" is already taken. Please choose a different treasury name."
        ));
        assert!(!creation_error_retryable(1, "1Click auth failed (400)"));

        // No retry on the final attempt, even for transport errors.
        assert!(!creation_error_retryable(
            MAX_CREATION_ATTEMPTS,
            "connection timed out"
        ));
    }

    #[test]
    fn policy_group_members_extracts_all_group_roles() {
        let policy = build_policy(
            &["req.near".parse().unwrap()],
            &["gov.near".parse().unwrap()],
            &["fin.near".parse().unwrap()],
            1,
            1,
        );
        let members = policy_group_members(&policy);
        assert!(members.contains("req.near"));
        assert!(members.contains("gov.near"));
        assert!(members.contains("fin.near"));
        assert_eq!(members.len(), 3);
    }

    #[test]
    fn collect_payload_members_deduplicates_roles() {
        let payload = CreateTreasuryRequest {
            name: "Treasury".to_string(),
            account_id: "team.sputnik-dao.near".parse().expect("valid account"),
            payment_threshold: 1,
            governance_threshold: 1,
            governors: vec![
                "alice.near".parse().expect("valid account"),
                "bob.near".parse().expect("valid account"),
            ],
            financiers: vec!["alice.near".parse().expect("valid account")],
            requestors: vec!["carol.near".parse().expect("valid account")],
            is_confidential: true,
        };

        let members = collect_payload_members(&payload);
        assert_eq!(members.len(), 3, "duplicate member should be deduplicated");
        assert!(members.contains("alice.near"));
        assert!(members.contains("bob.near"));
        assert!(members.contains("carol.near"));
    }

    #[test]
    fn build_treasury_created_message_includes_testing_flag() {
        let treasury: AccountId = "team.sputnik-dao.near".parse().expect("valid account");
        let message = build_treasury_created_message(&treasury, true, true, "10 NEAR");

        assert!(
            message.contains("Treasury created (confidential) [TESTING]: team.sputnik-dao.near"),
            "confidential and testing labels should be present"
        );
        assert!(
            message.contains("Balance after: 10 NEAR"),
            "balance should remain part of the notification"
        );
    }

    #[test]
    fn build_treasury_created_message_hides_testing_label_for_normal_treasury() {
        let treasury: AccountId = "team.sputnik-dao.near".parse().expect("valid account");
        let message = build_treasury_created_message(&treasury, false, false, "10 NEAR");

        assert!(
            message.contains("Treasury created: team.sputnik-dao.near"),
            "base message should be unchanged for non-testing treasuries"
        );
        assert!(
            !message.contains("[TESTING]"),
            "non-testing message should not include testing label"
        );
    }
}
