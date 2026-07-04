use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use bigdecimal::BigDecimal;
use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::Arc;

use crate::AppState;

/// One row of the `kr_analytics_treasury_monthly` view.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TreasuryMonthlyRow {
    pub account_id: String,
    pub month_start: NaiveDate,
    pub month_end: NaiveDate,
    pub year: i32,
    pub month: i32,
    pub month_label: String,
    pub trezu_started_on: NaiveDate,
    pub age_months: i32,
    pub treasury_type: String,
    pub origin: String,
    pub plan_type: Option<String>,
    pub members: i64,
    pub aum_usd: Option<BigDecimal>,
    pub aum_snapshot_at: Option<DateTime<Utc>>,
    pub inflow_usd: BigDecimal,
    pub outflow_usd: BigDecimal,
    pub netflow_usd: BigDecimal,
    pub swap_volume_usd: BigDecimal,
    pub volume_usd: BigDecimal,
    pub utilization_ratio: Option<BigDecimal>,
    pub payments: i64,
    pub votes: i64,
    pub swaps: i64,
    pub batch_payments: i64,
    pub address_book_size: i64,
    pub exports: i64,
    pub gas_covered_transactions: i64,
    pub derived_swap_fee_revenue_usd: BigDecimal,
    pub last_activity_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct TreasuryMonthlyAnalyticsResponse {
    pub count: usize,
    pub rows: Vec<TreasuryMonthlyRow>,
}

/// Validates the static analytics API key from the `Authorization` header
/// (with or without a `Bearer ` prefix). Fails closed when the key is unset.
fn require_analytics_key(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<(), (StatusCode, Json<Value>)> {
    let unauthorized = || {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized" })),
        )
    };

    let expected = state
        .env_vars
        .analytics_api_key
        .as_deref()
        .ok_or_else(unauthorized)?;

    let received = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.strip_prefix("Bearer ").unwrap_or(v))
        .ok_or_else(unauthorized)?;

    if crate::utils::admin_auth::constant_time_eq(expected, received) {
        Ok(())
    } else {
        Err(unauthorized())
    }
}

/// GET /internal/api/analytics/treasury-monthly
///
/// Returns every row of the `kr_analytics_treasury_monthly` view, guarded by
/// the `ANALYTICS_API_KEY` static key.
pub async fn get_treasury_monthly(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<TreasuryMonthlyAnalyticsResponse>, (StatusCode, Json<Value>)> {
    require_analytics_key(&headers, &state)?;

    let rows = sqlx::query_as::<_, TreasuryMonthlyRow>(
        r#"
        SELECT *
        FROM kr_analytics_treasury_monthly
        ORDER BY month_start, account_id
        "#,
    )
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| {
        tracing::error!("Failed to load treasury monthly analytics: {e}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Failed to load treasury analytics." })),
        )
    })?;

    Ok(Json(TreasuryMonthlyAnalyticsResponse {
        count: rows.len(),
        rows,
    }))
}
