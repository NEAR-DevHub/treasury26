use axum::{extract::State, http::StatusCode, Json};
use bigdecimal::ToPrimitive;
use serde::Serialize;
use std::sync::Arc;

use crate::AppState;

/// Subscription plan returned to clients
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionPlan {
    pub id: String,
    pub name: String,
    pub duration_months: i32,
    /// Price in USDC as a string (e.g., "150.00")
    pub price_usdc: String,
}

/// Response containing available subscription plans
#[derive(Serialize, Debug)]
pub struct PlansResponse {
    pub plans: Vec<SubscriptionPlan>,
}

/// GET /api/subscriptions/plans
///
/// Returns all active subscription plans with pricing
pub async fn get_plans(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PlansResponse>, (StatusCode, String)> {
    let plans = sqlx::query!(
        r#"
        SELECT id, name, duration_months, price_usdc
        FROM subscription_plans
        WHERE active = true
        ORDER BY duration_months ASC
        "#
    )
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| {
        log::error!("Failed to fetch subscription plans: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to fetch subscription plans".to_string(),
        )
    })?;

    let plans: Vec<SubscriptionPlan> = plans
        .into_iter()
        .map(|row| SubscriptionPlan {
            id: row.id,
            name: row.name,
            duration_months: row.duration_months,
            price_usdc: row
                .price_usdc
                .to_f64()
                .map(|f| format!("{:.2}", f))
                .unwrap_or_else(|| "0.00".to_string()),
        })
        .collect();

    Ok(Json(PlansResponse { plans }))
}
