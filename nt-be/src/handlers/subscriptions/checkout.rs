use axum::{extract::State, http::StatusCode, Json};
use bigdecimal::{BigDecimal, ToPrimitive};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;

use super::pingpay::{Asset, CreateCheckoutSessionRequest, PingPayClient};

/// Request to create a checkout session
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutRequest {
    /// Treasury account ID
    pub account_id: String,
    /// Plan ID (e.g., "3m", "6m", "12m")
    pub plan_id: String,
}

/// Response with checkout session URL
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutResponse {
    /// PingPay checkout URL to redirect user
    pub session_url: String,
    /// Session ID for tracking
    pub session_id: String,
    /// Internal subscription ID
    pub subscription_id: i32,
    /// Internal payment ID
    pub payment_id: i32,
}

/// Convert USDC amount to smallest units (6 decimals)
fn usdc_to_smallest_units(amount: &BigDecimal) -> String {
    // USDC has 6 decimals, so multiply by 1_000_000
    let multiplier = BigDecimal::from(1_000_000i64);
    let smallest_units = amount * multiplier;

    // Convert to integer string (no decimals)
    smallest_units
        .to_i64()
        .map(|i| i.to_string())
        .unwrap_or_else(|| "0".to_string())
}

/// POST /api/subscriptions/checkout
///
/// Creates a checkout session for a subscription payment
pub async fn create_checkout(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CheckoutRequest>,
) -> Result<Json<CheckoutResponse>, (StatusCode, String)> {
    let account_id = &request.account_id;
    let plan_id = &request.plan_id;

    // Validate plan exists and get price
    let plan = sqlx::query!(
        r#"
        SELECT id, name, duration_months, price_usdc
        FROM subscription_plans
        WHERE id = $1 AND active = true
        "#,
        plan_id
    )
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        log::error!("Failed to fetch plan: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to fetch subscription plan".to_string(),
        )
    })?
    .ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid plan_id: {}", plan_id),
        )
    })?;

    // Check for existing pending subscription
    let existing = sqlx::query!(
        r#"
        SELECT id FROM treasury_subscriptions
        WHERE account_id = $1 AND status = 'pending'
        "#,
        account_id
    )
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        log::error!("Failed to check existing subscription: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Database error".to_string(),
        )
    })?;

    if existing.is_some() {
        return Err((
            StatusCode::CONFLICT,
            "A pending subscription already exists. Complete or cancel it first.".to_string(),
        ));
    }

    // Create subscription record (pending)
    let subscription = sqlx::query!(
        r#"
        INSERT INTO treasury_subscriptions (account_id, plan_id, status)
        VALUES ($1, $2, 'pending')
        RETURNING id
        "#,
        account_id,
        plan_id
    )
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| {
        log::error!("Failed to create subscription: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create subscription".to_string(),
        )
    })?;

    // Create payment record (pending)
    let payment = sqlx::query!(
        r#"
        INSERT INTO subscription_payments (subscription_id, usdc_amount, status)
        VALUES ($1, $2, 'pending')
        RETURNING id
        "#,
        subscription.id,
        plan.price_usdc
    )
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| {
        log::error!("Failed to create payment: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create payment record".to_string(),
        )
    })?;

    // Build callback URL with subscription/payment IDs
    let success_url = format!(
        "{}/api/subscriptions/callback?type=success&subscription_id={}&payment_id={}",
        state.env_vars.subscription_success_url.trim_end_matches('/'),
        subscription.id,
        payment.id
    );
    let cancel_url = format!(
        "{}/api/subscriptions/callback?type=cancel&subscription_id={}&payment_id={}",
        state.env_vars.subscription_cancel_url.trim_end_matches('/'),
        subscription.id,
        payment.id
    );

    // Create PingPay checkout session
    let pingpay_client = PingPayClient::new(
        state.http_client.clone(),
        format!("{}/api", state.env_vars.pingpay_api_url),
        state.env_vars.pingpay_api_key.clone(),
    );

    let amount_smallest_units = usdc_to_smallest_units(&plan.price_usdc);

    let pingpay_request = CreateCheckoutSessionRequest {
        amount: amount_smallest_units,
        asset: Asset::default(), // NEAR/USDC
        success_url,
        cancel_url,
        metadata: Some(serde_json::json!({
            "treasury_id": account_id,
            "plan_id": plan_id,
            "subscription_id": subscription.id.to_string(),
            "payment_id": payment.id.to_string(),
        })),
    };

    let pingpay_response = pingpay_client
        .create_checkout_session(pingpay_request)
        .await
        .map_err(|e| {
            log::error!("PingPay API error: {}", e);
            (
                StatusCode::BAD_GATEWAY,
                format!("Payment provider error: {}", e),
            )
        })?;

    // Update payment record with PingPay session ID
    sqlx::query!(
        r#"
        UPDATE subscription_payments
        SET pingpay_session_id = $1
        WHERE id = $2
        "#,
        pingpay_response.session.session_id,
        payment.id
    )
    .execute(&state.db_pool)
    .await
    .map_err(|e| {
        log::error!("Failed to update payment with session ID: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to update payment record".to_string(),
        )
    })?;

    log::info!(
        "Created checkout session for treasury {} plan {} - session_id: {}, subscription_id: {}, payment_id: {}",
        account_id,
        plan_id,
        pingpay_response.session.session_id,
        subscription.id,
        payment.id
    );

    Ok(Json(CheckoutResponse {
        session_url: pingpay_response.session_url,
        session_id: pingpay_response.session.session_id,
        subscription_id: subscription.id,
        payment_id: payment.id,
    }))
}
