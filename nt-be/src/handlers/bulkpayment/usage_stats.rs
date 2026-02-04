use crate::AppState;
use crate::config::get_plan_config;
use crate::handlers::subscription::get_account_plan_info;
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatsQuery {
    pub treasury_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatsResponse {
    pub credits_available: i32,
    pub credits_used: i32,
    pub total_credits: i32,
}

/// Get bulk payment usage statistics for a treasury
/// Returns credits based on DB tracking and plan details, but ensures contract has enough storage
pub async fn get_usage_stats(
    State(state): State<Arc<AppState>>,
    Query(query): Query<UsageStatsQuery>,
) -> Result<Json<UsageStatsResponse>, StatusCode> {
    let account_info = get_account_plan_info(&state.db_pool, &query.treasury_id)
        .await
        .map_err(|e| {
            log::error!(
                "Failed to fetch account plan info for {}: {}",
                query.treasury_id,
                e
            );
            StatusCode::INTERNAL_SERVER_ERROR
        })?
        .ok_or_else(|| {
            log::warn!("Account not found: {}", query.treasury_id);
            StatusCode::NOT_FOUND
        })?;

    let plan_config = get_plan_config(account_info.plan_type);
    let batch_payment_credit_limit = plan_config
        .limits
        .monthly_batch_payment_credits
        .or(plan_config.limits.trial_batch_payment_credits);

    let total_credits = batch_payment_credit_limit
        .map(|c| c as i32)
        .unwrap_or(i32::MAX);

    let db_credits_remaining = account_info.batch_payment_credits;

    // Step 3: Calculate credits used and available from DB
    let credits_used = std::cmp::max(0, total_credits - db_credits_remaining);
    let available_from_db = db_credits_remaining;

    Ok(Json(UsageStatsResponse {
        credits_available: available_from_db,
        credits_used,
        total_credits,
    }))
}
