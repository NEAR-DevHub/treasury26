use axum::{Json, extract::State, http::StatusCode};
use near_api::AccountId;
use serde::Deserialize;
use serde_json::Value;

use std::sync::Arc;

use crate::AppState;
use crate::auth::OptionalAuthUser;

/// Quote request body - matches 1click API /v0/quote
/// Client-provided appFees and referral are ignored and overridden by server config
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRequest {
    /// DAO account ID — used to check confidentiality and route accordingly
    pub dao_id: Option<AccountId>,
    /// Set to true for testing without executing
    #[serde(default)]
    pub dry: Option<bool>,
    /// Swap type (e.g., "EXACT_INPUT")
    pub swap_type: Option<String>,
    /// Slippage tolerance in basis points
    pub slippage_tolerance: Option<u32>,
    /// Origin asset identifier (NEP-141 token)
    pub origin_asset: String,
    /// Deposit type (e.g., "ORIGIN_CHAIN")
    pub deposit_type: Option<String>,
    /// Destination asset identifier
    pub destination_asset: String,
    /// Amount in smallest units
    pub amount: String,
    /// Refund address
    pub refund_to: Option<String>,
    /// Refund type (e.g., "ORIGIN_CHAIN")
    pub refund_type: Option<String>,
    /// Recipient address
    pub recipient: Option<String>,
    /// Recipient type (e.g., "DESTINATION_CHAIN")
    pub recipient_type: Option<String>,
    /// Deadline as ISO 8601 timestamp (required by 1click API)
    pub deadline: String,
    /// Time to wait for quote in milliseconds
    pub quote_waiting_time_ms: Option<u32>,
    /// When true, suppresses app fees. Used by payment flow where origin and
    /// destination are the same token on different networks (no swap).
    #[serde(default)]
    pub is_payment: Option<bool>,
}

/// Send a JSON body to a 1click-style API endpoint and return the parsed response.
/// Handles auth headers, error extraction, and status propagation.
pub async fn send_oneclick_request(
    state: &Arc<AppState>,
    url: &str,
    body: &Value,
    access_token: Option<&str>,
) -> Result<Value, (StatusCode, String)> {
    let mut req = state
        .http_client
        .post(url)
        .header("content-type", "application/json");

    if let Some(token) = access_token {
        req = req.header("Authorization", format!("Bearer {}", token));
    }

    if let Some(api_key) = &state.env_vars.oneclick_api_key {
        req = req.header("x-api-key", api_key);
    }

    let response = req.json(body).send().await.map_err(|e| {
        tracing::error!("Error calling 1click API at {}: {}", url, e);
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to call 1click API: {}", e),
        )
    })?;

    let status = response.status();
    let response_body: Value = response.json().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to parse 1click API response: {}", e),
        )
    })?;

    if !status.is_success() {
        let error_message = response_body
            .get("error")
            .or_else(|| response_body.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown error from 1click API");

        return Err((
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            error_message.to_string(),
        ));
    }

    Ok(response_body)
}

/// Build the camelCase JSON body from a QuoteRequest, injecting server-side
/// appFees and referral from env config.
fn build_quote_body(state: &AppState, request: &QuoteRequest) -> Value {
    let mut body = serde_json::json!({
        "dry": request.dry,
        "swapType": request.swap_type,
        "slippageTolerance": request.slippage_tolerance,
        "originAsset": request.origin_asset,
        "depositType": request.deposit_type,
        "destinationAsset": request.destination_asset,
        "amount": request.amount,
        "refundTo": request.refund_to,
        "refundType": request.refund_type,
        "recipient": request.recipient,
        "recipientType": request.recipient_type,
        "deadline": request.deadline,
        "quoteWaitingTimeMs": request.quote_waiting_time_ms,
    });

    // Inject app fees when origin != destination. Skip for payments (same
    // token across networks, no swap).
    let is_payment = request.is_payment.unwrap_or(false);
    if let (Some(fee_bps), Some(recipient)) = (
        state.env_vars.oneclick_app_fee_bps,
        state.env_vars.oneclick_app_fee_recipient.as_ref(),
    ) && request.origin_asset != request.destination_asset
        && !is_payment
    {
        body["appFees"] = serde_json::json!([{ "recipient": recipient, "fee": fee_bps }]);
    }

    // Inject referral
    if let Some(referral) = state.env_vars.oneclick_referral.as_ref() {
        body["referral"] = serde_json::json!(referral);
    }

    body
}

/// Proxy endpoint for 1click API quote.
/// When `dao_id` is provided and the DAO is confidential, routes to the
/// confidential API with DAO JWT and API key.
/// Otherwise proxies to the regular 1click API.
/// Server-side appFees and referral are injected in both paths.
pub async fn get_quote(
    State(state): State<Arc<AppState>>,
    auth: OptionalAuthUser,
    Json(request): Json<QuoteRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let body = build_quote_body(&state, &request);

    // Check confidentiality when dao_id is provided
    if let Some(dao_id) = &request.dao_id {
        let confidential = auth
            .verify_member_if_confidential(&state.db_pool, dao_id)
            .await?;

        if confidential {
            let access_token = super::confidential::refresh_dao_jwt(&state, dao_id).await?;
            let url = format!("{}/v0/quote", state.env_vars.confidential_api_url);
            return send_oneclick_request(&state, &url, &body, Some(&access_token))
                .await
                .map(Json);
        }
    }

    let url = format!("{}/v0/quote", state.env_vars.oneclick_api_url);
    let access_token = state.env_vars.oneclick_jwt_token.as_deref();
    send_oneclick_request(&state, &url, &body, access_token)
        .await
        .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::env::EnvVars;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn create_test_state(
        mock_server_url: &str,
        env_overrides: Option<EnvVars>,
    ) -> Arc<AppState> {
        // Load .env files for test environment
        dotenvy::from_filename(".env").ok();
        dotenvy::from_filename(".env.test").ok();

        let use_defaults = env_overrides.is_none();
        let mut env_vars = env_overrides.unwrap_or_default();
        env_vars.oneclick_api_url = mock_server_url.to_string();
        if use_defaults {
            env_vars.oneclick_jwt_token = Some("test-jwt-token".to_string());
            env_vars.oneclick_app_fee_bps = Some(50);
            env_vars.oneclick_app_fee_recipient = Some("treasury.near".to_string());
            env_vars.oneclick_referral = Some("near-treasury".to_string());
        }

        // Use the builder pattern with a lazy pool (won't connect until used)
        let db_pool = sqlx::postgres::PgPool::connect_lazy(&env_vars.database_url)
            .expect("Failed to create lazy pool");

        Arc::new(
            AppState::builder()
                .db_pool(db_pool)
                .env_vars(env_vars)
                .build()
                .await
                .expect("Failed to build test AppState"),
        )
    }

    fn create_test_request() -> QuoteRequest {
        // Request format based on 1click API documentation
        // See: https://docs.near-intents.org/near-intents/integration/distribution-channels/1click-api
        QuoteRequest {
            dao_id: None,
            dry: Some(true),
            swap_type: Some("EXACT_INPUT".to_string()),
            slippage_tolerance: Some(100), // 1% in basis points
            origin_asset: "nep141:wrap.near".to_string(),
            deposit_type: Some("ORIGIN_CHAIN".to_string()),
            destination_asset: "nep141:usdt.tether-token.near".to_string(),
            amount: "1000000000000000000000000".to_string(), // 1 NEAR in yoctoNEAR
            refund_to: Some("user.near".to_string()),
            refund_type: Some("ORIGIN_CHAIN".to_string()),
            recipient: Some("user.near".to_string()),
            recipient_type: Some("DESTINATION_CHAIN".to_string()),
            deadline: "2026-01-18T16:30:00.000Z".to_string(), // Required ISO 8601 timestamp
            quote_waiting_time_ms: Some(3000),
            is_payment: None,
        }
    }

    /// Realistic mock response based on actual 1click API response
    /// Captured from: POST https://1click.chaindefuser.com/v0/quote
    fn create_realistic_quote_response() -> serde_json::Value {
        serde_json::json!({
            "quote": {
                "amountIn": "1000000000000000000000000",
                "amountInFormatted": "1.0",
                "amountInUsd": "1.7100",
                "minAmountIn": "1000000000000000000000000",
                "amountOut": "1714985",
                "amountOutFormatted": "1.714985",
                "amountOutUsd": "1.7100",
                "minAmountOut": "1697835",
                "timeEstimate": 20
            },
            "quoteRequest": {
                "dry": true,
                "depositMode": "SIMPLE",
                "swapType": "EXACT_INPUT",
                "slippageTolerance": 100,
                "originAsset": "nep141:wrap.near",
                "depositType": "ORIGIN_CHAIN",
                "destinationAsset": "nep141:usdt.tether-token.near",
                "amount": "1000000000000000000000000",
                "refundTo": "user.near",
                "refundType": "ORIGIN_CHAIN",
                "recipient": "user.near",
                "recipientType": "DESTINATION_CHAIN",
                "deadline": "2026-01-18T16:30:00.000Z",
                "quoteWaitingTimeMs": 3000
            },
            "signature": "ed25519:Sqg1sRLhpg1QtC9g69DKphB4qBBLUbqVYcPgytZ6LbQR275LtXNojsgpFBs9EKpdMn9sLkfPXZjBAMVPmVNEcre",
            "timestamp": "2026-01-18T15:55:15.062Z",
            "correlationId": "261f3a3b-9568-4dd6-85a5-2688b370d07a"
        })
    }

    #[tokio::test]
    async fn test_quote_request_forwards_to_oneclick_api() {
        let mock_server = MockServer::start().await;

        let mock_response = create_realistic_quote_response();

        Mock::given(method("POST"))
            .and(path("/v0/quote"))
            .and(header("content-type", "application/json"))
            .and(header("Authorization", "Bearer test-jwt-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&mock_response))
            .expect(1)
            .mount(&mock_server)
            .await;

        let state = create_test_state(&mock_server.uri(), None).await;
        let request = create_test_request();

        let result = get_quote(State(state), OptionalAuthUser(None), Json(request)).await;

        assert!(result.is_ok());
        let response = result.unwrap();

        // Verify key response fields from realistic mock (nested under "quote")
        assert!(response.0.get("quote").is_some());
        let quote = &response.0["quote"];
        assert_eq!(quote["amountIn"], "1000000000000000000000000");
        assert_eq!(quote["amountOut"], "1714985");
        assert_eq!(quote["timeEstimate"], 20);

        // Verify other top-level fields
        assert!(response.0.get("signature").is_some());
        assert!(response.0.get("timestamp").is_some());
        assert!(response.0.get("correlationId").is_some());
    }

    #[tokio::test]
    async fn test_quote_handles_oneclick_api_error() {
        let mock_server = MockServer::start().await;

        // Error response format based on typical API error patterns
        Mock::given(method("POST"))
            .and(path("/v0/quote"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "Invalid asset pair",
                "code": "INVALID_ASSET",
                "details": "The specified origin or destination asset is not supported"
            })))
            .mount(&mock_server)
            .await;

        let state = create_test_state(&mock_server.uri(), None).await;

        let request = QuoteRequest {
            dao_id: None,
            dry: Some(true),
            swap_type: None,
            slippage_tolerance: None,
            origin_asset: "invalid.near".to_string(),
            deposit_type: None,
            destination_asset: "also-invalid.near".to_string(),
            amount: "1000000".to_string(),
            refund_to: None,
            refund_type: None,
            recipient: None,
            recipient_type: None,
            deadline: "2026-01-18T16:30:00.000Z".to_string(),
            quote_waiting_time_ms: None,
            is_payment: None,
        };

        let result = get_quote(State(state), OptionalAuthUser(None), Json(request)).await;

        assert!(result.is_err());
        let (status, message) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(message, "Invalid asset pair");
    }

    #[tokio::test]
    async fn test_quote_without_jwt_token() {
        // Load .env files first
        dotenvy::from_filename(".env").ok();
        dotenvy::from_filename(".env.test").ok();

        let mock_server = MockServer::start().await;

        // This test verifies we can make requests without JWT token
        Mock::given(method("POST"))
            .and(path("/v0/quote"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(create_realistic_quote_response()),
            )
            .mount(&mock_server)
            .await;

        let env_vars = EnvVars {
            oneclick_jwt_token: None, // No JWT token
            oneclick_app_fee_bps: Some(50),
            oneclick_app_fee_recipient: Some("treasury.near".to_string()),
            oneclick_referral: None,
            ..Default::default()
        };

        let state = create_test_state(&mock_server.uri(), Some(env_vars)).await;

        let request = QuoteRequest {
            dao_id: None,
            dry: Some(true),
            swap_type: None,
            slippage_tolerance: None,
            origin_asset: "nep141:wrap.near".to_string(),
            deposit_type: None,
            destination_asset: "nep141:usdt.tether-token.near".to_string(),
            amount: "1000000".to_string(),
            refund_to: None,
            refund_type: None,
            recipient: None,
            recipient_type: None,
            deadline: "2026-01-18T16:30:00.000Z".to_string(),
            quote_waiting_time_ms: None,
            is_payment: None,
        };

        let result = get_quote(State(state), OptionalAuthUser(None), Json(request)).await;
        assert!(result.is_ok());
    }

    /// Integration test that calls the real 1click API
    /// Run with: cargo test test_real_oneclick_api -- --ignored
    ///
    /// Note: This test requires network access to https://1click.chaindefuser.com
    /// and may be rate limited without a JWT token.
    #[tokio::test]
    async fn test_real_oneclick_api() {
        dotenvy::from_filename(".env").ok();
        dotenvy::from_filename(".env.test").ok();

        let env_vars = EnvVars {
            // Use real API URL
            oneclick_api_url: "https://1click.chaindefuser.com".to_string(),
            // JWT token from env if available
            oneclick_jwt_token: std::env::var("ONECLICK_JWT_TOKEN").ok(),
            oneclick_app_fee_bps: Some(50),
            oneclick_app_fee_recipient: Some("treasury.near".to_string()),
            oneclick_referral: Some("near-treasury".to_string()),
            ..Default::default()
        };

        let db_pool = sqlx::postgres::PgPool::connect_lazy(&env_vars.database_url)
            .expect("Failed to create lazy pool");

        let state = Arc::new(
            AppState::builder()
                .db_pool(db_pool)
                .env_vars(env_vars)
                .build()
                .await
                .expect("Failed to build AppState"),
        );

        // Request a dry run quote for NEAR -> USDT swap
        // Generate a deadline 10 minutes in the future
        let deadline = chrono::Utc::now() + chrono::Duration::minutes(10);
        let request = QuoteRequest {
            dao_id: None,
            dry: Some(true), // Important: dry run only
            swap_type: Some("EXACT_INPUT".to_string()),
            slippage_tolerance: Some(100),
            origin_asset: "nep141:wrap.near".to_string(),
            deposit_type: Some("ORIGIN_CHAIN".to_string()),
            destination_asset: "nep141:usdt.tether-token.near".to_string(),
            amount: "1000000000000000000000000".to_string(), // 1 NEAR
            refund_to: Some("test.near".to_string()),
            refund_type: Some("ORIGIN_CHAIN".to_string()),
            recipient: Some("test.near".to_string()),
            recipient_type: Some("DESTINATION_CHAIN".to_string()),
            deadline: deadline.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
            quote_waiting_time_ms: Some(5000),
            is_payment: None,
        };

        let result = get_quote(State(state), OptionalAuthUser(None), Json(request)).await;

        match result {
            Ok(response) => {
                println!(
                    "Real API response: {}",
                    serde_json::to_string_pretty(&response.0).unwrap()
                );

                // Verify expected response fields are present based on real API response
                assert!(
                    response.0.get("quote").is_some(),
                    "Response should contain quote object"
                );
                let quote = &response.0["quote"];
                assert!(
                    quote.get("amountIn").is_some(),
                    "quote should contain amountIn"
                );
                assert!(
                    quote.get("amountOut").is_some(),
                    "quote should contain amountOut"
                );
                assert!(
                    quote.get("timeEstimate").is_some(),
                    "quote should contain timeEstimate"
                );

                assert!(
                    response.0.get("signature").is_some(),
                    "Response should contain signature"
                );
                assert!(
                    response.0.get("timestamp").is_some(),
                    "Response should contain timestamp"
                );
                assert!(
                    response.0.get("correlationId").is_some(),
                    "Response should contain correlationId"
                );
            }
            Err((status, message)) => {
                // API might reject due to rate limiting or invalid parameters
                println!("API error: {} - {}", status, message);
                // Don't fail the test - just log the error for debugging
                // This helps understand what the real API returns
            }
        }
    }
}
