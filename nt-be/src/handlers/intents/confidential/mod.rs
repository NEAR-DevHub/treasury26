use near_account_id::AccountIdRef;
use near_api::AccountId;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::AppState;

pub mod balances;
pub mod bronze;
pub mod generate_intent;
pub mod gold;
pub mod prepare_auth;
pub mod types;

pub use bronze::store::link_intent_to_history_event;
pub use bronze::{
    HistoryEvent, HistoryPage, fetch_history, fetch_history_with_token,
    spawn_confidential_history_worker, trigger_confidential_history_refresh,
};
pub use gold::{
    get_confidential_balance_chart, mark_gold_dirty_for_history_event, mark_gold_dirty_tx,
    project_confidential_gold_for_dao, refresh_gold_metadata_for_intent,
    snapshot_confidential_dao_balances, spawn_confidential_gold_reconciliation_worker,
    spawn_confidential_snapshot_worker,
};
pub use types::{ConfidentialTxType, HistoryStatus, accounts_equal, bare_account};

/// Request body for authenticating a DAO with the 1Click confidential intents API.
/// The signed data is a NEP-413 signature over an empty-intents auth payload,
/// produced by v1.signer (MPC chain-signatures) on behalf of the DAO.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticateRequest {
    /// The DAO account ID (e.g., "mydao.sputnik-dao.near")
    pub dao_id: AccountId,
    /// The signed authentication data
    pub signed_data: serde_json::Value,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct AuthenticateResponse {
    access_token: String,
    /// Access token lifetime in seconds
    expires_in: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticateResult {
    pub success: bool,
    pub dao_id: AccountId,
    pub expires_in: i64,
}

/// Refresh the JWT access token for a DAO using its stored refresh token.
/// Called internally before making authenticated API calls.
pub async fn refresh_dao_jwt(
    state: &AppState,
    dao_id: &AccountIdRef,
) -> Result<String, (StatusCode, String)> {
    // Load tokens from DB
    let row = sqlx::query!(
        r#"
        SELECT confidential_access_token, confidential_refresh_token, confidential_token_expires_at
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
        dao_id.as_str(),
    )
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to load JWT for DAO {}: {}", dao_id, e),
        )
    })?;

    let row = row.ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            format!("DAO {} not found in monitored_accounts", dao_id),
        )
    })?;

    let access_token = row.confidential_access_token.ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            format!("No confidential JWT stored for DAO {}", dao_id),
        )
    })?;

    let refresh_token = row.confidential_refresh_token.ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            format!("No confidential refresh token for DAO {}", dao_id),
        )
    })?;

    // If access token is still valid (more than 60s remaining), return it
    if let Some(expires_at) = row.confidential_token_expires_at {
        let remaining = expires_at.signed_duration_since(chrono::Utc::now());
        if remaining.num_seconds() > 60 {
            return Ok(access_token);
        }
    }

    // Refresh the token
    let url = format!("{}/v0/auth/refresh", state.env_vars.confidential_api_url);

    let mut req = state
        .http_client
        .post(&url)
        .header("content-type", "application/json");
    if let Some(api_key) = &state.env_vars.oneclick_api_key {
        req = req.header("x-api-key", api_key);
    }
    let response = req
        .json(&serde_json::json!({ "refreshToken": refresh_token }))
        .send()
        .await
        .map_err(|e| {
            tracing::error!("Error refreshing JWT for DAO {}: {}", dao_id, e);
            (
                StatusCode::BAD_GATEWAY,
                format!("Failed to refresh JWT: {}", e),
            )
        })?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        tracing::error!(
            "JWT refresh failed for DAO {} ({}): {}",
            dao_id,
            status,
            error_text
        );

        return Err((
            StatusCode::UNAUTHORIZED,
            format!("JWT refresh failed for DAO {}: {}", dao_id, error_text),
        ));
    }

    let json_value: serde_json::Value = response.json().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to parse refresh response: {}", e),
        )
    })?;
    println!("json_value: {:?}", json_value);
    let auth_response: AuthenticateResponse = serde_json::from_value(json_value).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to parse refresh response: {}", e),
        )
    })?;

    let new_expires_at = chrono::Utc::now() + chrono::Duration::seconds(auth_response.expires_in);

    // Update stored tokens
    sqlx::query!(
        r#"
        UPDATE monitored_accounts
        SET confidential_access_token = $1,
            confidential_token_expires_at = $2
        WHERE account_id = $3
        "#,
        auth_response.access_token,
        new_expires_at,
        dao_id.as_str(),
    )
    .execute(&state.db_pool)
    .await
    .map_err(|e| {
        tracing::error!("Failed to update JWT for DAO {}: {}", dao_id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to update JWT tokens: {}", e),
        )
    })?;

    tracing::info!("Refreshed confidential JWT for DAO {}", dao_id);
    Ok(auth_response.access_token)
}
