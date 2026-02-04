//! Subscription plan endpoints

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::Datelike;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::types::BigDecimal;
use sqlx::types::chrono::{DateTime, Utc};
use std::collections::HashMap;
use std::sync::Arc;

use crate::AppState;
use crate::config::{PlanConfig, PlanType, get_all_plans, get_plan_config};
use crate::handlers::token::{TokenMetadata, fetch_tokens_metadata};

/// Response for GET /api/subscription/plans
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct SubscriptionStatusResponse {
    pub account_id: String,
    pub plan_type: PlanType,
    pub plan_config: PlanConfig,
    pub export_credits: i32,
    pub batch_payment_credits: i32,
    pub gas_covered_transactions: i32,
    pub credits_reset_at: DateTime<Utc>,
    pub monthly_used_volume_cents: u64,
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

/// Outbound amount per token for a given period
#[derive(Debug, sqlx::FromRow)]
struct TokenOutboundAmount {
    token_id: String,
    total_amount: BigDecimal,
}

/// Calculate outbound volume in USD cents for an account for a specific month
/// Only counts outgoing transactions (negative amounts)
///
/// # Arguments
/// * `state` - Application state
/// * `account_id` - Account to calculate volume for
/// * `year` - Year (e.g., 2024)
/// * `month` - Month (1-12)
pub async fn calculate_monthly_outbound_volume(
    state: &Arc<AppState>,
    account_id: &str,
    year: i32,
    month: u32,
) -> Result<u64, (StatusCode, String)> {
    // Calculate start and end of the month
    let start_date = format!("{}-{:02}-01", year, month);
    let end_date = if month == 12 {
        format!("{}-01-01", year + 1)
    } else {
        format!("{}-{:02}-01", year, month + 1)
    };

    // Query outgoing amounts grouped by token for the specified month
    let outbound_amounts = sqlx::query_as::<_, TokenOutboundAmount>(
        r#"
        SELECT token_id, ABS(SUM(amount)) as total_amount
        FROM balance_changes
        WHERE account_id = $1
          AND amount < 0
          AND counterparty NOT IN ('SNAPSHOT', 'STAKING_SNAPSHOT', 'NOT_REGISTERED')
          AND block_time >= $2::timestamptz
          AND block_time < $3::timestamptz
        GROUP BY token_id
        "#,
    )
    .bind(account_id)
    .bind(&start_date)
    .bind(&end_date)
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| {
        log::error!("Failed to fetch outbound amounts: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to fetch outbound amounts: {}", e),
        )
    })?;

    if outbound_amounts.is_empty() {
        return Ok(0);
    }

    // Convert token_id to defuse asset ID format for metadata lookup
    fn token_id_for_metadata(token_id: &str) -> String {
        if token_id == "near" {
            "nep141:wrap.near".to_string()
        } else if token_id.starts_with("intents.near:") {
            token_id.strip_prefix("intents.near:").unwrap().to_string()
        } else if token_id.starts_with("nep141:") || token_id.starts_with("nep245:") {
            token_id.to_string()
        } else {
            format!("nep141:{}", token_id)
        }
    }

    // Collect unique token IDs for metadata lookup
    let token_ids: Vec<String> = outbound_amounts
        .iter()
        .map(|t| token_id_for_metadata(&t.token_id))
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    // Fetch token metadata (includes prices)
    let tokens_metadata = fetch_tokens_metadata(state, &token_ids)
        .await
        .map_err(|e| {
            log::error!("Failed to fetch token metadata for volume calc: {:?}", e);
            e
        })?;

    // Build metadata map
    let metadata_map: HashMap<String, TokenMetadata> = tokens_metadata
        .into_iter()
        .map(|m| (m.token_id.clone(), m))
        .collect();

    // Calculate USD value for each token
    let mut total_usd_cents: f64 = 0.0;

    for outbound in &outbound_amounts {
        let lookup_id = token_id_for_metadata(&outbound.token_id);

        // Get metadata for price and decimals
        let (price, decimals) = if outbound.token_id == "near" {
            // NEAR fallback
            let near_meta = metadata_map.get("nep141:wrap.near");
            (near_meta.and_then(|m| m.price).unwrap_or(0.0), 24u8)
        } else if let Some(meta) = metadata_map.get(&lookup_id) {
            (meta.price.unwrap_or(0.0), meta.decimals)
        } else {
            log::warn!(
                "No metadata found for token {}, skipping in volume calc",
                outbound.token_id
            );
            continue;
        };

        if price == 0.0 {
            continue;
        }

        // Convert amount to USD: amount / 10^decimals * price * 100 (for cents)
        let amount_f64: f64 = outbound.total_amount.to_string().parse().unwrap_or(0.0);
        let divisor = 10_f64.powi(decimals as i32);
        let usd_value = (amount_f64 / divisor) * price * 100.0;

        total_usd_cents += usd_value;
    }

    Ok(total_usd_cents.round() as u64)
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

    // Calculate current month's outbound volume
    let now = Utc::now();
    let monthly_used_volume_cents =
        calculate_monthly_outbound_volume(&state, &account_id, now.year(), now.month())
            .await
            .map_err(|(status, msg)| (status, Json(json!({ "error": msg }))))?;

    Ok(Json(SubscriptionStatusResponse {
        account_id: account.account_id,
        plan_type: account.plan_type,
        plan_config,
        gas_covered_transactions: account.gas_covered_transactions,
        export_credits: account.export_credits,
        batch_payment_credits: account.batch_payment_credits,
        credits_reset_at: account.credits_reset_at,
        monthly_used_volume_cents,
    }))
}
