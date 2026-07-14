use near_account_id::AccountIdRef;
use near_api::AccountId;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::observability::sanitize_sensitive_text;

pub mod balances;
pub mod bronze;
pub mod bulk_activation;
pub mod bulk_payment_prepare;
pub mod generate_intent;
pub mod gold;
pub mod history_refresh;
pub mod prepare_auth;
pub mod types;

pub use bronze::store::link_intent_to_history_event;
pub use bronze::{
    HistoryEvent, HistoryPage, fetch_history, fetch_history_with_token,
    trigger_confidential_history_refresh,
};
pub use gold::{
    get_confidential_balance_chart, mark_gold_dirty_for_history_event, mark_gold_dirty_tx,
    project_confidential_gold_for_dao, refresh_gold_metadata_for_intent,
    snapshot_confidential_dao_balances,
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

/// Bundle of token columns loaded from DB.
struct StoredTokens {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Generic JWT-refresh core. Takes already-loaded tokens and the account label
/// (for log/error messages). Returns the new access token + the new
/// `expires_at` to persist; caller writes them back to the appropriate columns.
async fn refresh_jwt_inner(
    state: &AppState,
    account_label: &str,
    tokens: StoredTokens,
) -> Result<(String, chrono::DateTime<chrono::Utc>), (StatusCode, String)> {
    let access_token = tokens.access_token.ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            format!("No JWT stored for {}", account_label),
        )
    })?;

    let refresh_token = tokens.refresh_token.ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            format!("No refresh token for {}", account_label),
        )
    })?;

    // If access token is still valid (more than 60s remaining), return it as-is.
    if let Some(expires_at) = tokens.expires_at {
        let remaining = expires_at.signed_duration_since(chrono::Utc::now());
        if remaining.num_seconds() > 60 {
            return Ok((access_token, expires_at));
        }
    }

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
            tracing::error!("Error refreshing JWT for {}: {}", account_label, e);
            (
                StatusCode::BAD_GATEWAY,
                format!("Failed to refresh JWT: {}", e),
            )
        })?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        let sanitized_error = sanitize_sensitive_text(&error_text);
        tracing::error!(
            "JWT refresh failed for {} ({}): {}",
            account_label,
            status,
            sanitized_error
        );
        return Err((
            StatusCode::UNAUTHORIZED,
            format!(
                "JWT refresh failed for {}: {}",
                account_label, sanitized_error
            ),
        ));
    }

    let auth_response: AuthenticateResponse = response.json().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to parse refresh response: {}", e),
        )
    })?;

    let new_expires_at = chrono::Utc::now() + chrono::Duration::seconds(auth_response.expires_in);
    Ok((auth_response.access_token, new_expires_at))
}

/// Refresh the DAO-side confidential JWT.
pub async fn refresh_dao_jwt(
    state: &AppState,
    dao_id: &AccountIdRef,
) -> Result<String, (StatusCode, String)> {
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
    })?
    .ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            format!("DAO {} not found in monitored_accounts", dao_id),
        )
    })?;

    let label = format!("DAO {}", dao_id);
    let (access_token, new_expires_at) = refresh_jwt_inner(
        state,
        &label,
        StoredTokens {
            access_token: row.confidential_access_token,
            refresh_token: row.confidential_refresh_token,
            expires_at: row.confidential_token_expires_at,
        },
    )
    .await?;

    sqlx::query!(
        r#"
        UPDATE monitored_accounts
        SET confidential_access_token = $1,
            confidential_token_expires_at = $2
        WHERE account_id = $3
        "#,
        access_token,
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
    Ok(access_token)
}

/// Refresh the bulk-payment-subaccount confidential JWT.
pub async fn refresh_bulk_dao_jwt(
    state: &AppState,
    dao_id: &str,
) -> Result<String, (StatusCode, String)> {
    let row = sqlx::query!(
        r#"
        SELECT bulk_payment_access_token, bulk_payment_refresh_token, bulk_payment_token_expires_at
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
        dao_id,
    )
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to load bulk-payment JWT for DAO {}: {}", dao_id, e),
        )
    })?
    .ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            format!("DAO {} not found in monitored_accounts", dao_id),
        )
    })?;

    let label = format!("bulk-payment for DAO {}", dao_id);
    let (access_token, new_expires_at) = refresh_jwt_inner(
        state,
        &label,
        StoredTokens {
            access_token: row.bulk_payment_access_token,
            refresh_token: row.bulk_payment_refresh_token,
            expires_at: row.bulk_payment_token_expires_at,
        },
    )
    .await?;

    sqlx::query!(
        r#"
        UPDATE monitored_accounts
        SET bulk_payment_access_token = $1,
            bulk_payment_token_expires_at = $2
        WHERE account_id = $3
        "#,
        access_token,
        new_expires_at,
        dao_id,
    )
    .execute(&state.db_pool)
    .await
    .map_err(|e| {
        tracing::error!(
            "Failed to update bulk-payment JWT for DAO {}: {}",
            dao_id,
            e
        );
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to update bulk-payment JWT tokens: {}", e),
        )
    })?;

    tracing::info!("Refreshed bulk-payment JWT for DAO {}", dao_id);
    Ok(access_token)
}
