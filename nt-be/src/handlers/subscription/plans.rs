//! Subscription plan endpoints

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::types::chrono::{DateTime, Utc};
use std::sync::Arc;

use crate::AppState;
use crate::config::{PlanConfig, PlanType, get_all_plans, get_plan_config};

/// Response for GET /api/subscription/plans
#[derive(Debug, Serialize)]
pub struct PlansResponse {
    pub plans: Vec<PlanConfig>,
}

/// GET /api/subscription/plans
/// Returns all available subscription plans with their limits and pricing
pub async fn get_plans() -> Json<PlansResponse> {
    Json(PlansResponse {
        plans: get_all_plans(),
    })
}

/// Response for GET /api/subscription/{account_id}
#[derive(Debug, Serialize)]
pub struct SubscriptionStatusResponse {
    pub account_id: String,
    pub plan_type: PlanType,
    pub plan_config: PlanConfig,
    pub export_credits: i32,
    pub batch_payment_credits: i32,
    pub gas_covered_transactions: i32,
    pub credits_reset_at: DateTime<Utc>,
}

/// Account plan info from monitored_accounts (reusable across handlers)
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AccountPlanInfo {
    pub account_id: String,
    pub plan_type: PlanType,
    pub export_credits: i32,
    pub batch_payment_credits: i32,
    pub gas_covered_transactions: i32,
    pub credits_reset_at: DateTime<Utc>,
}

/// Fetch account plan info from the database
/// Returns None if account not found
pub async fn get_account_plan_info(
    pool: &sqlx::PgPool,
    account_id: &str,
) -> Result<Option<AccountPlanInfo>, sqlx::Error> {
    sqlx::query_as::<_, AccountPlanInfo>(
        r#"
        SELECT account_id, plan_type, export_credits, batch_payment_credits, gas_covered_transactions, credits_reset_at
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
}

/// GET /api/subscription/{account_id}
/// Returns the subscription status for a specific treasury account
pub async fn get_subscription_status(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<String>,
) -> Result<Json<SubscriptionStatusResponse>, (StatusCode, Json<Value>)> {
    // Get account info using shared function
    let account = get_account_plan_info(&state.db_pool, &account_id)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("Database error: {}", e) })),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "Account not found" })),
            )
        })?;

    let plan_config = get_plan_config(account.plan_type);

    Ok(Json(SubscriptionStatusResponse {
        account_id: account.account_id,
        plan_type: account.plan_type,
        plan_config,
        gas_covered_transactions: account.gas_covered_transactions,
        export_credits: account.export_credits,
        batch_payment_credits: account.batch_payment_credits,
        credits_reset_at: account.credits_reset_at,
    }))
}
