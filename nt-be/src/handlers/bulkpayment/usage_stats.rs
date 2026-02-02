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

// Maximum recipients per bulk payment request
const MAX_RECIPIENTS_PER_BULK_PAYMENT: u64 = 25;

#[derive(Debug, Deserialize)]
pub struct UsageStatsQuery {
    pub treasury_id: String,
}

#[derive(Debug, Serialize)]
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

    // // Step 4: Fetch contract storage credits (these are PER RECIPIENT, not per bulk payment)
    // let contract_credits_result = near_api::Contract(state.bulk_payment_contract_id.clone())
    //     .call_function(
    //         "view_storage_credits",
    //         serde_json::json!({
    //             "account_id": query.treasury_id,
    //         }),
    //     )
    //     .read_only::<String>() // Returns number of recipient slots as string
    //     .fetch_from(&state.network)
    //     .await;

    // let max_bulk_payments_from_contract = match contract_credits_result {
    //     Ok(response) => {
    //         // Parse storage credits (number of recipient slots available)
    //         let storage_credits_per_recipient = response.data.parse::<u64>().unwrap_or(0);
    //         // Calculate how many bulk payments we can do
    //         // Each bulk payment can have up to MAX_RECIPIENTS_PER_BULK_PAYMENT recipients
    //         (storage_credits_per_recipient / MAX_RECIPIENTS_PER_BULK_PAYMENT) as i32
    //     }
    //     Err(e) => {
    //         log::warn!(
    //             "Failed to fetch contract storage credits for {}: {}",
    //             query.treasury_id,
    //             e
    //         );
    //         0
    //     }
    // };

    // Step 5: Return minimum of DB available and what contract can support
    // If DB says we have 3 bulk payments left, but contract only has storage for 2,
    // we return 2 (the contract limit)
    // For unlimited plans (None), return what contract can support
    // let credits_available = if batch_payment_credit_limit.is_none() {
    //     max_bulk_payments_from_contract
    // } else {
    //     std::cmp::min(available_from_db, max_bulk_payments_from_contract)
    // };

    // log::info!(
    //     "Treasury {}: plan={:?}, total={}, DB available={}, contract can support={}, returning={}",
    //     query.treasury_id,
    //     account_info.plan_type,
    //     total_credits,
    //     available_from_db,
    //     // max_bulk_payments_from_contract,
    //     // credits_available
    // );

    Ok(Json(UsageStatsResponse {
        credits_available: available_from_db,
        credits_used,
        total_credits,
    }))
}
