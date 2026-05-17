use axum::{Json, extract::State, http::StatusCode};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::types::chrono::{DateTime, Utc};
use std::sync::Arc;

use crate::AppState;
use crate::config::PlanType;
use crate::services::{RegisterMonitoredAccountError, register_or_refresh_monitored_account};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddAccountRequest {
    pub account_id: AccountId,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddAccountResponse {
    pub account_id: AccountId,
    pub enabled: bool,
    pub is_confidential: bool,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub export_credits: i32,
    pub batch_payment_credits: i32,
    pub plan_type: PlanType,
    pub credits_reset_at: DateTime<Utc>,
    pub dirty_at: Option<DateTime<Utc>>,
    pub is_new_registration: bool,
}

/// Add/register a monitored account
/// - If not registered: creates new record with default credits (10 export, 120 batch payment)
/// - If already registered: updates dirty_at to trigger priority gap filling
///
/// Called on every treasury open via the frontend's `openTreasury` hook.
pub async fn add_monitored_account(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<AddAccountRequest>,
) -> Result<Json<AddAccountResponse>, (StatusCode, Json<Value>)> {
    let result = register_or_refresh_monitored_account(&state.db_pool, &payload.account_id, false)
        .await
        .map_err(|e| match e {
            RegisterMonitoredAccountError::NotSputnikDao => (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "Only sputnik-dao accounts can be monitored",
                    "message": "Account ID must end with '.sputnik-dao.near'"
                })),
            ),
            RegisterMonitoredAccountError::Db(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("Database error: {}", e) })),
            ),
        })?;

    let account = result.account;

    Ok(Json(AddAccountResponse {
        account_id: account.account_id,
        enabled: account.enabled,
        is_confidential: account.is_confidential_account,
        last_synced_at: account.last_synced_at,
        created_at: account.created_at,
        updated_at: account.updated_at,
        export_credits: account.export_credits,
        batch_payment_credits: account.batch_payment_credits,
        plan_type: account.plan_type,
        credits_reset_at: account.credits_reset_at,
        dirty_at: account.dirty_at,
        is_new_registration: result.is_new_registration,
    }))
}
