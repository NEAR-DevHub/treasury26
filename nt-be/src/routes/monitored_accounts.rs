use axum::{Json, extract::State, http::StatusCode};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::types::chrono::{DateTime, Utc};
use std::sync::Arc;

use crate::AppState;
use crate::config::PlanType;
use crate::services::{
    NOT_MANAGED_TREASURY_MESSAGE, RegisterMonitoredAccountError, RegistrationMode,
    register_or_refresh_monitored_account,
};

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
/// Under `MANAGED_TREASURIES_ONLY` unknown accounts are rejected with 404.
pub async fn add_monitored_account(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<AddAccountRequest>,
) -> Result<Json<AddAccountResponse>, (StatusCode, Json<Value>)> {
    let result = register_or_refresh_monitored_account(
        &state.db_pool,
        state.goldsky_pool.as_ref(),
        &payload.account_id,
        false,
        RegistrationMode::for_user_action(&state.env_vars),
    )
    .await
    .map_err(|e| match e {
        RegisterMonitoredAccountError::NotSputnikDao => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "Only sputnik-dao accounts can be monitored",
                "message": "Account ID must end with '.sputnik-dao.near'"
            })),
        ),
        RegisterMonitoredAccountError::NotManaged => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": NOT_MANAGED_TREASURY_MESSAGE })),
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

#[cfg(test)]
mod tests {
    use crate::routes::create_routes;
    use crate::utils::test_utils::{build_test_state, send};
    use axum::http::StatusCode;
    use serde_json::json;
    use sqlx::PgPool;
    use std::sync::Arc;

    const URI: &str = "/api/monitored-accounts";
    const UNKNOWN_DAO: &str = "unknown-managed-test.sputnik-dao.near";
    const MANAGED_DAO: &str = "managed-test.sputnik-dao.near";

    fn managed_only_state(pool: PgPool) -> Arc<crate::AppState> {
        let mut state = build_test_state(pool);
        state.env_vars.managed_treasuries_only = true;
        Arc::new(state)
    }

    async fn row_count(pool: &PgPool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM monitored_accounts")
            .fetch_one(pool)
            .await
            .expect("count monitored accounts")
    }

    #[sqlx::test]
    async fn managed_only_rejects_unknown_treasury(pool: PgPool) {
        let app = create_routes(managed_only_state(pool.clone()));

        let (status, body) = send(
            app,
            "POST",
            URI.to_string(),
            "",
            Some(json!({ "accountId": UNKNOWN_DAO })),
        )
        .await;

        assert_eq!(status, StatusCode::NOT_FOUND, "unexpected body: {body}");
        assert_eq!(row_count(&pool).await, 0, "no row may be created");
    }

    #[sqlx::test]
    async fn managed_only_refreshes_known_treasury(pool: PgPool) {
        sqlx::query("INSERT INTO monitored_accounts (account_id) VALUES ($1)")
            .bind(MANAGED_DAO)
            .execute(&pool)
            .await
            .expect("seed managed treasury");
        let app = create_routes(managed_only_state(pool.clone()));

        let (status, body) = send(
            app,
            "POST",
            URI.to_string(),
            "",
            Some(json!({ "accountId": MANAGED_DAO })),
        )
        .await;

        assert_eq!(status, StatusCode::OK, "unexpected body: {body}");
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["accountId"], MANAGED_DAO);
        assert_eq!(parsed["isNewRegistration"], false);
        assert!(parsed["dirtyAt"].is_string(), "refresh must set dirtyAt");
        assert_eq!(row_count(&pool).await, 1);
    }

    #[sqlx::test]
    async fn default_mode_registers_unknown_treasury(pool: PgPool) {
        let app = create_routes(Arc::new(build_test_state(pool.clone())));

        let (status, body) = send(
            app,
            "POST",
            URI.to_string(),
            "",
            Some(json!({ "accountId": UNKNOWN_DAO })),
        )
        .await;

        assert_eq!(status, StatusCode::OK, "unexpected body: {body}");
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["isNewRegistration"], true);
        assert_eq!(row_count(&pool).await, 1);
    }
}
