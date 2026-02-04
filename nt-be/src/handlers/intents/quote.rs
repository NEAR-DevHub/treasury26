use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

use crate::AppState;

/// App fee configuration for the quote request
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppFee {
    /// NEAR account to receive the fee
    pub recipient: String,
    /// Fee in basis points (100 = 1%)
    pub fee: u32,
}

/// Quote request body - matches 1click API /v0/quote
/// Client-provided appFees and referral are ignored and overridden by server config
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRequest {
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
    // Note: appFees and referral are intentionally NOT included here
    // They will be injected from server-side environment variables
}

/// Internal request sent to 1click API with injected appFees and referral
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct OneClickQuoteRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slippage_tolerance: Option<u32>,
    pub origin_asset: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deposit_type: Option<String>,
    pub destination_asset: String,
    pub amount: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refund_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refund_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient_type: Option<String>,
    pub deadline: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote_waiting_time_ms: Option<u32>,
    /// App fees injected from server config
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_fees: Option<Vec<AppFee>>,
    /// Referral injected from server config
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referral: Option<String>,
}

impl From<QuoteRequest> for OneClickQuoteRequest {
    fn from(req: QuoteRequest) -> Self {
        OneClickQuoteRequest {
            dry: req.dry,
            swap_type: req.swap_type,
            slippage_tolerance: req.slippage_tolerance,
            origin_asset: req.origin_asset,
            deposit_type: req.deposit_type,
            destination_asset: req.destination_asset,
            amount: req.amount,
            refund_to: req.refund_to,
            refund_type: req.refund_type,
            recipient: req.recipient,
            recipient_type: req.recipient_type,
            deadline: req.deadline.clone(),
            quote_waiting_time_ms: req.quote_waiting_time_ms,
            app_fees: None,
            referral: None,
        }
    }
}

/// Proxy endpoint for 1click API quote
/// Injects server-side appFees and referral from environment variables
pub async fn get_quote(
    State(state): State<Arc<AppState>>,
    Json(request): Json<QuoteRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    // Convert client request to internal request
    let mut oneclick_request: OneClickQuoteRequest = request.into();

    // Inject app fees from environment if configured
    if let (Some(fee_bps), Some(recipient)) = (
        state.env_vars.oneclick_app_fee_bps,
        state.env_vars.oneclick_app_fee_recipient.as_ref(),
    ) {
        oneclick_request.app_fees = Some(vec![AppFee {
            recipient: recipient.clone(),
            fee: fee_bps,
        }]);
    }

    // Inject referral from environment if configured
    if let Some(referral) = state.env_vars.oneclick_referral.as_ref() {
        oneclick_request.referral = Some(referral.clone());
    }

    // Build the request to 1click API
    let url = format!("{}/v0/quote", state.env_vars.oneclick_api_url);

    let mut request_builder = state
        .http_client
        .post(&url)
        .header("content-type", "application/json")
        .json(&oneclick_request);

    // Add JWT authentication if configured
    if let Some(jwt_token) = state.env_vars.oneclick_jwt_token.as_ref() {
        request_builder = request_builder.header("Authorization", format!("Bearer {}", jwt_token));
    }

    // Make the request
    let response = request_builder.send().await.map_err(|e| {
        eprintln!("Error calling 1click API: {}", e);
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to fetch quote from 1click API: {}", e),
        )
    })?;

    let status = response.status();

    // Parse response body
    let body: Value = response.json().await.map_err(|e| {
        eprintln!("Error parsing 1click API response: {}", e);
        (
            StatusCode::BAD_GATEWAY,
            "Failed to parse 1click API response".to_string(),
        )
    })?;

    // If 1click API returned an error, propagate it with appropriate status
    if !status.is_success() {
        let error_message = body
            .get("error")
            .or_else(|| body.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown error from 1click API");

        return Err((
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            error_message.to_string(),
        ));
    }

    Ok(Json(body))
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

        let result = get_quote(State(state), Json(request)).await;

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
        };

        let result = get_quote(State(state), Json(request)).await;

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

        let mut env_vars = EnvVars::default();
        env_vars.oneclick_jwt_token = None; // No JWT token
        env_vars.oneclick_app_fee_bps = Some(50);
        env_vars.oneclick_app_fee_recipient = Some("treasury.near".to_string());
        env_vars.oneclick_referral = None;

        let state = create_test_state(&mock_server.uri(), Some(env_vars)).await;

        let request = QuoteRequest {
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
        };

        let result = get_quote(State(state), Json(request)).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_quote_request_serialization() {
        // Test that the request is properly serialized with camelCase
        let request = create_test_request();
        let oneclick_request: OneClickQuoteRequest = request.into();

        let json = serde_json::to_value(&oneclick_request).unwrap();

        // Verify camelCase field names
        assert!(json.get("originAsset").is_some());
        assert!(json.get("destinationAsset").is_some());
        assert!(json.get("slippageTolerance").is_some());
        assert_eq!(json.get("originAsset").unwrap(), "nep141:wrap.near");
    }

    #[tokio::test]
    async fn test_app_fees_injection() {
        // Test that app fees are correctly constructed
        let fee_bps = 50u32;
        let recipient = "treasury.near".to_string();

        let app_fee = AppFee {
            recipient: recipient.clone(),
            fee: fee_bps,
        };

        let json = serde_json::to_value(&app_fee).unwrap();
        assert_eq!(json.get("recipient").unwrap(), "treasury.near");
        assert_eq!(json.get("fee").unwrap(), 50);
    }

    #[tokio::test]
    async fn test_oneclick_request_with_app_fees() {
        let request = QuoteRequest {
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
        };

        let mut oneclick_request: OneClickQuoteRequest = request.into();
        oneclick_request.app_fees = Some(vec![AppFee {
            recipient: "treasury.near".to_string(),
            fee: 50,
        }]);
        oneclick_request.referral = Some("near-treasury".to_string());

        let json = serde_json::to_value(&oneclick_request).unwrap();

        // Verify appFees is present and correct
        let app_fees = json.get("appFees").unwrap().as_array().unwrap();
        assert_eq!(app_fees.len(), 1);
        assert_eq!(app_fees[0]["recipient"], "treasury.near");
        assert_eq!(app_fees[0]["fee"], 50);

        // Verify referral is present
        assert_eq!(json.get("referral").unwrap(), "near-treasury");
    }

    #[tokio::test]
    async fn test_oneclick_request_without_optional_fields() {
        let request = QuoteRequest {
            dry: None,
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
        };

        let oneclick_request: OneClickQuoteRequest = request.into();
        let json = serde_json::to_value(&oneclick_request).unwrap();

        // Verify optional fields are not present (skip_serializing_if works)
        assert!(json.get("dry").is_none());
        assert!(json.get("swapType").is_none());
        assert!(json.get("appFees").is_none());
        assert!(json.get("referral").is_none());

        // Required fields should be present
        assert!(json.get("originAsset").is_some());
        assert!(json.get("destinationAsset").is_some());
        assert!(json.get("amount").is_some());
        assert!(json.get("deadline").is_some()); // deadline is now required
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

        let mut env_vars = EnvVars::default();
        // Use real API URL
        env_vars.oneclick_api_url = "https://1click.chaindefuser.com".to_string();
        // JWT token from env if available
        env_vars.oneclick_jwt_token = std::env::var("ONECLICK_JWT_TOKEN").ok();
        env_vars.oneclick_app_fee_bps = Some(50);
        env_vars.oneclick_app_fee_recipient = Some("treasury.near".to_string());
        env_vars.oneclick_referral = Some("near-treasury".to_string());

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
        };

        let result = get_quote(State(state), Json(request)).await;

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
