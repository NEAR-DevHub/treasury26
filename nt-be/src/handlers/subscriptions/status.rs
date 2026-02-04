use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use bigdecimal::ToPrimitive;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;

/// Query parameters for subscription status
#[derive(Deserialize)]
pub struct StatusQuery {
    pub account_id: String,
}

/// Subscription status for a treasury
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionStatus {
    /// Whether the treasury has an active subscription
    pub is_active: bool,
    /// Current subscription details (if any)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription: Option<SubscriptionDetails>,
    /// Payment history
    pub payments: Vec<PaymentSummary>,
}

/// Details of a subscription
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionDetails {
    pub id: i32,
    pub plan_id: String,
    pub plan_name: String,
    pub status: String,
    pub starts_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    /// Days remaining until expiration (negative if expired)
    pub days_remaining: Option<i64>,
}

/// Summary of a payment
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PaymentSummary {
    pub id: i32,
    pub usdc_amount: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    /// Whether an invoice has been generated
    pub has_invoice: bool,
}

/// GET /api/subscriptions/status
///
/// Returns subscription status for a treasury account
pub async fn get_subscription_status(
    State(state): State<Arc<AppState>>,
    Query(query): Query<StatusQuery>,
) -> Result<Json<SubscriptionStatus>, (StatusCode, String)> {
    let account_id = &query.account_id;

    // Get the most recent active or pending subscription
    let subscription = sqlx::query!(
        r#"
        SELECT
            ts.id, ts.plan_id, ts.status, ts.starts_at, ts.expires_at,
            sp.name as plan_name
        FROM treasury_subscriptions ts
        JOIN subscription_plans sp ON sp.id = ts.plan_id
        WHERE ts.account_id = $1
          AND ts.status IN ('active', 'pending')
        ORDER BY ts.created_at DESC
        LIMIT 1
        "#,
        account_id
    )
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        log::error!("Failed to fetch subscription: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to fetch subscription".to_string(),
        )
    })?;

    // Check if subscription is truly active (not expired)
    let now = Utc::now();
    let (is_active, subscription_details) = if let Some(sub) = subscription {
        let is_expired = sub
            .expires_at
            .map(|exp| exp < now)
            .unwrap_or(false);

        let days_remaining = sub.expires_at.map(|exp| {
            let duration = exp.signed_duration_since(now);
            duration.num_days()
        });

        let actual_status = if is_expired && sub.status == "active" {
            "expired".to_string()
        } else {
            sub.status
        };

        let is_active = actual_status == "active" && !is_expired;

        (
            is_active,
            Some(SubscriptionDetails {
                id: sub.id,
                plan_id: sub.plan_id,
                plan_name: sub.plan_name,
                status: actual_status,
                starts_at: sub.starts_at,
                expires_at: sub.expires_at,
                days_remaining,
            }),
        )
    } else {
        (false, None)
    };

    // Get payment history for this account
    let payments = sqlx::query!(
        r#"
        SELECT
            sp.id, sp.usdc_amount, sp.status, sp.created_at, sp.completed_at,
            EXISTS(SELECT 1 FROM subscription_invoices si WHERE si.payment_id = sp.id) as "has_invoice!"
        FROM subscription_payments sp
        JOIN treasury_subscriptions ts ON ts.id = sp.subscription_id
        WHERE ts.account_id = $1
        ORDER BY sp.created_at DESC
        LIMIT 10
        "#,
        account_id
    )
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| {
        log::error!("Failed to fetch payment history: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to fetch payment history".to_string(),
        )
    })?;

    let payments: Vec<PaymentSummary> = payments
        .into_iter()
        .map(|row| PaymentSummary {
            id: row.id,
            usdc_amount: row
                .usdc_amount
                .to_f64()
                .map(|f| format!("{:.2}", f))
                .unwrap_or_else(|| "0.00".to_string()),
            status: row.status,
            created_at: row.created_at,
            completed_at: row.completed_at,
            has_invoice: row.has_invoice,
        })
        .collect();

    Ok(Json(SubscriptionStatus {
        is_active,
        subscription: subscription_details,
        payments,
    }))
}
