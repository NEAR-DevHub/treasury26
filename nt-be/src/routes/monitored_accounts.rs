use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::types::chrono::{DateTime, Utc};
use std::sync::Arc;

use crate::AppState;

// Default credits granted when a treasury is first registered
const DEFAULT_EXPORT_CREDITS: i32 = 10;
const DEFAULT_BATCH_PAYMENT_CREDITS: i32 = 5;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct MonitoredAccount {
    pub account_id: String,
    pub enabled: bool,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub export_credits: i32,
    pub batch_payment_credits: i32,
}

#[derive(Debug, Deserialize)]
pub struct AddAccountRequest {
    pub account_id: String,
}

#[derive(Debug, Serialize)]
pub struct AddAccountResponse {
    pub account_id: String,
    pub enabled: bool,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub export_credits: i32,
    pub batch_payment_credits: i32,
    pub is_new_registration: bool,
}

#[derive(Debug, Deserialize)]
pub struct ListAccountsQuery {
    pub enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAccountRequest {
    pub enabled: bool,
}

/// Add/register a monitored account
/// - If not registered: creates new record with default credits (10 export, 120 batch payment)
/// - If already registered: returns existing record without changes
pub async fn add_monitored_account(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<AddAccountRequest>,
) -> Result<Json<AddAccountResponse>, (StatusCode, Json<Value>)> {
    // Validate that this is a sputnik-dao account to prevent abuse
    if !payload.account_id.ends_with(".sputnik-dao.near") {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Only sputnik-dao accounts can be monitored",
                "message": "Account ID must end with '.sputnik-dao.near'"
            })),
        ));
    }

    // Check if already exists
    let existing = sqlx::query_as::<_, MonitoredAccount>(
        r#"
        SELECT account_id, enabled, last_synced_at, created_at, updated_at, export_credits, batch_payment_credits
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
    )
    .bind(&payload.account_id)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Database error: {}", e) })),
        )
    })?;

    if let Some(account) = existing {
        // Already registered - return without changes
        return Ok(Json(AddAccountResponse {
            account_id: account.account_id,
            enabled: account.enabled,
            last_synced_at: account.last_synced_at,
            created_at: account.created_at,
            updated_at: account.updated_at,
            export_credits: account.export_credits,
            batch_payment_credits: account.batch_payment_credits,
            is_new_registration: false,
        }));
    }

    // New registration - insert with default credits
    let account = sqlx::query_as::<_, MonitoredAccount>(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled, export_credits, batch_payment_credits)
        VALUES ($1, true, $2, $3)
        RETURNING account_id, enabled, last_synced_at, created_at, updated_at, export_credits, batch_payment_credits
        "#,
    )
    .bind(&payload.account_id)
    .bind(DEFAULT_EXPORT_CREDITS)
    .bind(DEFAULT_BATCH_PAYMENT_CREDITS)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Database error: {}", e) })),
        )
    })?;

    Ok(Json(AddAccountResponse {
        account_id: account.account_id,
        enabled: account.enabled,
        last_synced_at: account.last_synced_at,
        created_at: account.created_at,
        updated_at: account.updated_at,
        export_credits: account.export_credits,
        batch_payment_credits: account.batch_payment_credits,
        is_new_registration: true,
    }))
}

/// List monitored accounts
pub async fn list_monitored_accounts(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListAccountsQuery>,
) -> Result<Json<Vec<MonitoredAccount>>, (StatusCode, Json<Value>)> {
    let accounts = if let Some(enabled) = params.enabled {
        sqlx::query_as::<_, MonitoredAccount>(
            r#"
            SELECT account_id, enabled, last_synced_at, created_at, updated_at, export_credits, batch_payment_credits
            FROM monitored_accounts
            WHERE enabled = $1
            ORDER BY account_id
            "#,
        )
        .bind(enabled)
        .fetch_all(&state.db_pool)
        .await
    } else {
        sqlx::query_as::<_, MonitoredAccount>(
            r#"
            SELECT account_id, enabled, last_synced_at, created_at, updated_at, export_credits, batch_payment_credits
            FROM monitored_accounts
            ORDER BY account_id
            "#,
        )
        .fetch_all(&state.db_pool)
        .await
    }
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Database error: {}", e) })),
        )
    })?;

    Ok(Json(accounts))
}

/// Update a monitored account (enable/disable)
pub async fn update_monitored_account(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<String>,
    Json(payload): Json<UpdateAccountRequest>,
) -> Result<Json<MonitoredAccount>, (StatusCode, Json<Value>)> {
    let account = sqlx::query_as::<_, MonitoredAccount>(
        r#"
        UPDATE monitored_accounts
        SET enabled = $2,
            updated_at = NOW()
        WHERE account_id = $1
        RETURNING account_id, enabled, last_synced_at, created_at, updated_at, export_credits, batch_payment_credits
        "#,
    )
    .bind(&account_id)
    .bind(payload.enabled)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Database error: {}", e) })),
        )
    })?;

    account
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "Account not found" })),
            )
        })
        .map(Json)
}

/// Delete a monitored account
pub async fn delete_monitored_account(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<Value>)> {
    let result = sqlx::query!(
        r#"
        DELETE FROM monitored_accounts
        WHERE account_id = $1
        "#,
        account_id
    )
    .execute(&state.db_pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Database error: {}", e) })),
        )
    })?;

    if result.rows_affected() == 0 {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Account not found" })),
        ));
    }

    Ok(StatusCode::NO_CONTENT)
}
