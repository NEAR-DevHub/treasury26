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

/// Subscription status for a treasury
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SubscriptionInfo {
    pub id: sqlx::types::Uuid,
    pub monitored_account_id: String,
    pub plan_type: PlanType,
    pub billing_period: String,
    pub payment_provider: String,
    pub status: String,
    pub current_period_start: DateTime<Utc>,
    pub current_period_end: DateTime<Utc>,
    pub amount_cents: i32,
    pub currency: String,
    pub auto_renew: bool,
    pub created_at: DateTime<Utc>,
}

/// Response for GET /api/subscription/{account_id}
#[derive(Debug, Serialize)]
pub struct SubscriptionStatusResponse {
    pub account_id: String,
    pub plan_type: PlanType,
    pub plan_config: PlanConfig,
    pub subscription: Option<SubscriptionInfo>,
    pub export_credits: i32,
    pub batch_payment_credits: i32,
    pub credits_reset_at: DateTime<Utc>,
}

/// Account info from monitored_accounts
#[derive(Debug, sqlx::FromRow)]
struct AccountInfo {
    pub account_id: String,
    pub plan_type: PlanType,
    pub export_credits: i32,
    pub batch_payment_credits: i32,
    pub credits_reset_at: DateTime<Utc>,
}

/// GET /api/subscription/{account_id}
/// Returns the subscription status for a specific treasury account
pub async fn get_subscription_status(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<String>,
) -> Result<Json<SubscriptionStatusResponse>, (StatusCode, Json<Value>)> {
    // Get account info
    let account = sqlx::query_as::<_, AccountInfo>(
        r#"
        SELECT account_id, plan_type, export_credits, batch_payment_credits, credits_reset_at
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
    )
    .bind(&account_id)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Database error: {}", e) })),
        )
    })?;

    let account = account.ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Account not found" })),
        )
    })?;

    // Get active subscription if any
    let subscription = sqlx::query_as::<_, SubscriptionInfo>(
        r#"
        SELECT id, monitored_account_id, plan_type,
               billing_period::text as billing_period,
               payment_provider::text as payment_provider,
               status::text as status,
               current_period_start, current_period_end,
               amount_cents, currency, auto_renew, created_at
        FROM subscriptions
        WHERE monitored_account_id = $1
          AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(&account_id)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Database error: {}", e) })),
        )
    })?;

    let plan_config = get_plan_config(account.plan_type);

    Ok(Json(SubscriptionStatusResponse {
        account_id: account.account_id,
        plan_type: account.plan_type,
        plan_config,
        subscription,
        export_credits: account.export_credits,
        batch_payment_credits: account.batch_payment_credits,
        credits_reset_at: account.credits_reset_at,
    }))
}
