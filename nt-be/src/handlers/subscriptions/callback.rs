use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Redirect,
};
use chrono::{Duration, Utc};
use serde::Deserialize;
use std::sync::Arc;

use crate::AppState;

/// Query parameters from PingPay callback
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CallbackQuery {
    /// Callback type: "success" or "cancel"
    #[serde(rename = "type")]
    pub callback_type: Option<String>,

    /// PingPay payment ID
    pub payment_id: Option<String>,

    /// PingPay session ID
    pub session_id: Option<String>,

    /// Transaction status: SUCCESS, FAILED, REFUNDED
    pub tx_status: Option<String>,

    /// Deposit address/transaction reference
    pub deposit_address: Option<String>,

    /// Our internal subscription ID (passed via success/cancel URL)
    pub subscription_id: Option<i32>,

    /// Our internal payment ID (passed via success/cancel URL)
    #[serde(alias = "payment_id")]
    pub internal_payment_id: Option<i32>,
}

/// Payment info needed for callback processing
struct PaymentInfo {
    id: i32,
    subscription_id: i32,
    plan_id: String,
}

/// GET /api/subscriptions/callback
///
/// Handles PingPay redirect after payment completion
/// Redirects to frontend success or error page
pub async fn handle_callback(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CallbackQuery>,
) -> Result<Redirect, (StatusCode, String)> {
    log::info!("Received subscription callback: {:?}", query);

    // Determine redirect base URL
    let base_success_url = &state.env_vars.subscription_success_url;
    let base_cancel_url = &state.env_vars.subscription_cancel_url;

    // Handle cancel callback
    if query.callback_type.as_deref() == Some("cancel") {
        // Mark payment as expired if we have the internal payment ID
        if let Some(payment_id) = query.internal_payment_id {
            let _ = sqlx::query!(
                r#"
                UPDATE subscription_payments
                SET status = 'expired'
                WHERE id = $1 AND status = 'pending'
                "#,
                payment_id
            )
            .execute(&state.db_pool)
            .await;
        }

        // Redirect to cancel page
        let redirect_url = format!("{}?cancelled=true", base_cancel_url);
        return Ok(Redirect::temporary(&redirect_url));
    }

    // Handle success callback - verify we have required params
    let tx_status = query.tx_status.as_deref().unwrap_or("UNKNOWN");
    let pingpay_payment_id = query.payment_id.clone();
    let pingpay_session_id = query.session_id.clone();
    let deposit_address = query.deposit_address.clone();

    // Find the payment record by session ID or internal payment ID
    let payment = find_payment(&state, &pingpay_session_id, query.internal_payment_id).await?;

    let payment = match payment {
        Some(p) => p,
        None => {
            log::error!("Payment record not found for callback");
            let redirect_url = format!("{}?error=payment_not_found", base_cancel_url);
            return Ok(Redirect::temporary(&redirect_url));
        }
    };

    // Check transaction status
    match tx_status {
        "SUCCESS" => {
            // Get plan duration to calculate expiry
            let plan = sqlx::query!(
                r#"
                SELECT duration_months FROM subscription_plans WHERE id = $1
                "#,
                payment.plan_id
            )
            .fetch_optional(&state.db_pool)
            .await
            .map_err(|e| {
                log::error!("Failed to fetch plan: {}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, "Database error".to_string())
            })?;

            let duration_months = plan.map(|p| p.duration_months).unwrap_or(12);

            // Calculate subscription period
            let now = Utc::now();
            let expires_at = now + Duration::days(duration_months as i64 * 30);

            // Update payment record
            sqlx::query!(
                r#"
                UPDATE subscription_payments
                SET
                    pingpay_payment_id = $1,
                    deposit_address = $2,
                    tx_status = $3,
                    status = 'completed',
                    completed_at = NOW()
                WHERE id = $4
                "#,
                pingpay_payment_id,
                deposit_address,
                tx_status,
                payment.id
            )
            .execute(&state.db_pool)
            .await
            .map_err(|e| {
                log::error!("Failed to update payment: {}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, "Database error".to_string())
            })?;

            // Activate subscription
            sqlx::query!(
                r#"
                UPDATE treasury_subscriptions
                SET
                    status = 'active',
                    starts_at = $1,
                    expires_at = $2,
                    updated_at = NOW()
                WHERE id = $3
                "#,
                now,
                expires_at,
                payment.subscription_id
            )
            .execute(&state.db_pool)
            .await
            .map_err(|e| {
                log::error!("Failed to activate subscription: {}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, "Database error".to_string())
            })?;

            log::info!(
                "Subscription {} activated for payment {} - expires at {}",
                payment.subscription_id,
                payment.id,
                expires_at
            );

            // Redirect to success page
            let redirect_url = format!(
                "{}?subscription_id={}&payment_id={}",
                base_success_url, payment.subscription_id, payment.id
            );
            Ok(Redirect::temporary(&redirect_url))
        }

        "FAILED" | "REFUNDED" => {
            // Update payment record with failure status
            sqlx::query!(
                r#"
                UPDATE subscription_payments
                SET
                    pingpay_payment_id = $1,
                    deposit_address = $2,
                    tx_status = $3,
                    status = 'failed'
                WHERE id = $4
                "#,
                pingpay_payment_id,
                deposit_address,
                tx_status,
                payment.id
            )
            .execute(&state.db_pool)
            .await
            .map_err(|e| {
                log::error!("Failed to update payment: {}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, "Database error".to_string())
            })?;

            log::warn!(
                "Payment {} failed with status: {}",
                payment.id,
                tx_status
            );

            // Redirect to cancel page with error
            let redirect_url = format!(
                "{}?error=payment_{}&payment_id={}",
                base_cancel_url,
                tx_status.to_lowercase(),
                payment.id
            );
            Ok(Redirect::temporary(&redirect_url))
        }

        _ => {
            log::warn!(
                "Unknown transaction status: {} for payment {}",
                tx_status,
                payment.id
            );

            // Redirect to cancel page with unknown status
            let redirect_url = format!(
                "{}?error=unknown_status&status={}",
                base_cancel_url, tx_status
            );
            Ok(Redirect::temporary(&redirect_url))
        }
    }
}

/// Find payment by PingPay session ID or internal payment ID
async fn find_payment(
    state: &AppState,
    session_id: &Option<String>,
    internal_payment_id: Option<i32>,
) -> Result<Option<PaymentInfo>, (StatusCode, String)> {
    // Try finding by session ID first
    if let Some(session_id) = session_id {
        let result = sqlx::query!(
            r#"
            SELECT sp.id, sp.subscription_id, ts.plan_id
            FROM subscription_payments sp
            JOIN treasury_subscriptions ts ON ts.id = sp.subscription_id
            WHERE sp.pingpay_session_id = $1
            "#,
            session_id
        )
        .fetch_optional(&state.db_pool)
        .await
        .map_err(|e| {
            log::error!("Failed to find payment by session: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Database error".to_string())
        })?;

        if let Some(row) = result {
            return Ok(Some(PaymentInfo {
                id: row.id,
                subscription_id: row.subscription_id,
                plan_id: row.plan_id,
            }));
        }
    }

    // Fall back to internal payment ID
    if let Some(payment_id) = internal_payment_id {
        let result = sqlx::query!(
            r#"
            SELECT sp.id, sp.subscription_id, ts.plan_id
            FROM subscription_payments sp
            JOIN treasury_subscriptions ts ON ts.id = sp.subscription_id
            WHERE sp.id = $1
            "#,
            payment_id
        )
        .fetch_optional(&state.db_pool)
        .await
        .map_err(|e| {
            log::error!("Failed to find payment by ID: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Database error".to_string())
        })?;

        if let Some(row) = result {
            return Ok(Some(PaymentInfo {
                id: row.id,
                subscription_id: row.subscription_id,
                plan_id: row.plan_id,
            }));
        }
    }

    Ok(None)
}
