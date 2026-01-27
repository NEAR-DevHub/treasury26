use crate::AppState;
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

// Maximum recipients per bulk payment request
const MAX_RECIPIENTS_PER_BULK_PAYMENT: u64 = 25;

// Total free credits granted to new treasuries
const TOTAL_FREE_CREDITS: i32 = 5;

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
/// Returns credits based on DB tracking, but ensures contract has enough storage
pub async fn get_usage_stats(
    State(state): State<Arc<AppState>>,
    Query(query): Query<UsageStatsQuery>,
) -> Result<Json<UsageStatsResponse>, StatusCode> {
    // Step 1: Get remaining credits from monitored_accounts table
    let db_credits_remaining = sqlx::query_as::<_, (i32,)>(
        r#"
        SELECT batch_payment_credits
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
    )
    .bind(&query.treasury_id)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        log::error!(
            "Failed to fetch bulk payment credits for {}: {}",
            query.treasury_id,
            e
        );
        StatusCode::INTERNAL_SERVER_ERROR
    })?
    .map(|r| r.0)
    .unwrap_or(0);

    // Step 2: Calculate credits used and available from DB
    let credits_used = std::cmp::max(0, TOTAL_FREE_CREDITS - db_credits_remaining);
    let available_from_db = db_credits_remaining;

    // Step 3: Fetch contract storage credits (these are PER RECIPIENT, not per bulk payment)
    let contract_credits_result = near_api::Contract(state.bulk_payment_contract_id.clone())
        .call_function(
            "view_storage_credits",
            serde_json::json!({
                "account_id": query.treasury_id,
            }),
        )
        .read_only::<String>() // Returns number of recipient slots as string
        .fetch_from(&state.network)
        .await;

    let max_bulk_payments_from_contract = match contract_credits_result {
        Ok(response) => {
            // Parse storage credits (number of recipient slots available)
            let storage_credits_per_recipient = response.data.parse::<u64>().unwrap_or(0);
            // Calculate how many bulk payments we can do
            // Each bulk payment can have up to MAX_RECIPIENTS_PER_BULK_PAYMENT recipients
            (storage_credits_per_recipient / MAX_RECIPIENTS_PER_BULK_PAYMENT) as i32
        }
        Err(e) => {
            log::warn!(
                "Failed to fetch contract storage credits for {}: {}",
                query.treasury_id,
                e
            );
            0
        }
    };

    // Step 4: Return minimum of DB available and what contract can support
    // If DB says we have 3 bulk payments left, but contract only has storage for 2,
    // we return 2 (the contract limit)
    let credits_available = std::cmp::min(available_from_db, max_bulk_payments_from_contract);

    log::info!(
        "Treasury {}: DB available={}, contract can support={}, returning={}",
        query.treasury_id,
        available_from_db,
        max_bulk_payments_from_contract,
        credits_available
    );

    Ok(Json(UsageStatsResponse {
        credits_available,
        credits_used,
        total_credits: TOTAL_FREE_CREDITS,
    }))
}
