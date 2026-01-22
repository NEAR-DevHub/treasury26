use crate::AppState;
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
pub struct UsageStatsQuery {
    pub treasury_id: String,
}

#[derive(Debug, Serialize)]
pub struct UsageStatsResponse {
    pub total_requests: i64,
    pub total_recipients: i64,
}

pub async fn get_usage_stats(
    State(state): State<Arc<AppState>>,
    Query(query): Query<UsageStatsQuery>,
) -> Result<Json<UsageStatsResponse>, StatusCode> {
    // Get total stats for this treasury
    let stats = sqlx::query_as::<_, (i64, i64)>(
        r#"
        SELECT 
            COUNT(*) as total_requests,
            COALESCE(SUM(recipient_count), 0) as total_recipients
        FROM bulk_payment_requests
        WHERE treasury_id = $1
        "#,
    )
    .bind(&query.treasury_id)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| {
        log::error!("Failed to fetch bulk payment stats: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    Ok(Json(UsageStatsResponse {
        total_requests: stats.0,
        total_recipients: stats.1,
    }))
}
