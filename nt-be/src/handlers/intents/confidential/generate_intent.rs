use axum::{Json, extract::State, http::StatusCode};
use near_api::AccountId;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

use crate::handlers::intents::confidential::types::{ConfidentialQuoteMetadata, as_near_account};
use crate::{AppState, auth::AuthUser};

/// Request body for generating an intent to sign.
/// After getting a quote, this endpoint returns the intent payload
/// that needs to be signed (by wallet or v1.signer MPC).
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GenerateIntentRequest {
    /// "swap_transfer"
    pub r#type: String,
    /// The signing standard: "nep413" for NEAR
    pub standard: String,
    /// Intents user ID (e.g., "near:mydao.sputnik-dao.near")
    pub signer_id: String,
    /// Full quote response blob — depositAddress is extracted from
    /// `quote.depositAddress`. Also stored so the UI can display
    /// amounts, tokens, recipient, etc. for confidential proposals.
    pub quote_metadata: Value,
    /// Optional user-provided memo/description for the payment.
    /// Stored in the DB since the on-chain description is opaque for privacy.
    pub notes: Option<String>,
}

/// Proxy endpoint for 1Click API generate-intent.
/// Returns the intent payload that needs to be signed.
///
/// POST /api/confidential-intents/generate-intent
///
/// The response contains a standard-specific payload (e.g. NEP-413 for NEAR)
/// that the wallet or v1.signer must sign before submitting via submit-intent.
pub async fn generate_intent(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Json(request): Json<GenerateIntentRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    // signerId is the intents identifier `near:dao.sputnik-dao.near`; resolve it to
    // the bare NEAR account used for auth, JWT and on-chain calls.
    let dao_id: AccountId = as_near_account(&request.signer_id)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                format!("signer_id '{}' is not a NEAR account", request.signer_id),
            )
        })?
        .parse()
        .map_err(|e: near_account_id::ParseAccountError| {
            (
                StatusCode::BAD_REQUEST,
                format!("Invalid signer_id '{}': {}", request.signer_id, e),
            )
        })?;
    auth_user.verify_can_add_proposal(&state, &dao_id).await?;

    let quote_meta =
        ConfidentialQuoteMetadata::from_value(&request.quote_metadata).ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "quote_metadata must be valid JSON with quote.depositAddress".to_string(),
            )
        })?;
    let deposit_address = quote_meta
        .deposit_address()
        .map(|s| s.to_string())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "quote_metadata.quote.depositAddress is required".to_string(),
            )
        })?;

    tracing::info!(
        "generate_intent called: type={}, signerId={}",
        request.r#type,
        request.signer_id
    );
    let url = format!("{}/v0/generate-intent", state.env_vars.confidential_api_url);

    let body = serde_json::json!({
        "type": request.r#type,
        "standard": request.standard,
        "depositAddress": deposit_address,
        "signerId": request.signer_id,
    });

    // The signer_id is the DAO — use its stored JWT for authentication
    let access_token = super::refresh_dao_jwt(&state, &dao_id).await?;

    let mut req = state
        .http_client
        .post(&url)
        .header("content-type", "application/json")
        .header("Authorization", format!("Bearer {}", access_token));
    if let Some(api_key) = &state.env_vars.oneclick_api_key {
        req = req.header("x-api-key", api_key);
    }
    let response = req.json(&body).send().await.map_err(|e| {
        tracing::error!("Error calling 1Click generate-intent API: {}", e);
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to generate intent: {}", e),
        )
    })?;

    let status = response.status();
    let mut response_body: Value = response.json().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to parse generate-intent response: {}", e),
        )
    })?;

    if !status.is_success() {
        let error_message = response_body
            .get("error")
            .or_else(|| response_body.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown error from 1Click API");

        return Err((
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            error_message.to_string(),
        ));
    }

    // Store the intent payload for auto-submission after DAO proposal approval.
    let dao_id = dao_id.as_str();
    if let Some(payload) = response_body.get("intent").and_then(|i| i.get("payload")) {
        let correlation_id = response_body.get("correlationId").and_then(|v| v.as_str());

        // Compute the NEP-413 hash — this is the same value used in payload_v2.Eddsa
        // on-chain, serving as the unique key to match intents to proposals.
        let payload_hash = crate::handlers::relay::confidential::compute_nep413_hash(payload)
            .ok_or_else(|| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to compute NEP-413 payload hash".to_string(),
                )
            })?;

        if let Err(e) = crate::handlers::relay::confidential::store_pending_intent(
            &state.db_pool,
            crate::handlers::relay::confidential::PendingIntentInput {
                dao_id,
                payload_hash: &payload_hash,
                intent_payload: payload,
                correlation_id,
                quote_metadata: Some(&request.quote_metadata),
                deposit_address: &deposit_address,
                notes: request.notes.as_deref(),
            },
        )
        .await
        {
            tracing::warn!("Failed to store pending intent for {}: {}", dao_id, e);
        }

        // Include the payload hash in the response so the frontend can use it
        // directly in the v1.signer proposal (single source of truth).
        if let Value::Object(ref mut map) = response_body {
            map.insert("payloadHash".to_string(), Value::String(payload_hash));
        }
    }

    Ok(Json(response_body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handlers::intents::quote::{QuoteRequest, get_quote};
    use crate::utils::env::EnvVars;
    use axum::extract::State;

    /// Helper to create AppState pointing at the real 1Click API
    async fn create_real_api_state() -> Arc<AppState> {
        dotenvy::from_filename(".env").ok();
        dotenvy::from_filename(".env.test").ok();

        let mut env_vars = EnvVars::default();
        env_vars.oneclick_api_url = "https://1click.chaindefuser.com".to_string();
        env_vars.oneclick_jwt_token = std::env::var("ONECLICK_JWT_TOKEN").ok();
        env_vars.oneclick_app_fee_bps = Some(35);
        env_vars.oneclick_app_fee_recipient = Some("trezu.sputnik-dao.near".to_string());
        env_vars.oneclick_referral = Some("trezu".to_string());

        let db_pool = sqlx::postgres::PgPool::connect_lazy(&env_vars.database_url)
            .expect("Failed to create lazy pool");

        Arc::new(
            AppState::builder()
                .db_pool(db_pool)
                .env_vars(env_vars)
                .build()
                .await
                .expect("Failed to build AppState"),
        )
    }

    /// Integration test: get a real quote then call generate-intent.
    ///
    /// Run with: cargo test test_real_generate_intent -- --ignored --nocapture
    ///
    /// This test:
    /// 1. Gets a live (non-dry) shield quote for wNEAR → CONFIDENTIAL_INTENTS
    /// 2. Calls generate-intent with the depositAddress from the quote
    /// 3. Prints the full response (the NEP-413 payload to sign)
    #[tokio::test]
    #[ignore]
    async fn test_real_generate_intent() {
        let state = create_real_api_state().await;
        let dao_id = "webassemblymusic-treasury.sputnik-dao.near";
        let deadline = chrono::Utc::now() + chrono::Duration::minutes(10);

        // Step 1: Get a live quote for shielding wNEAR
        println!("=== Step 1: Getting live shield quote ===");
        let quote_request = QuoteRequest {
            is_payment: None,
            dao_id: None,
            dry: Some(false), // Live quote — returns depositAddress
            swap_type: Some("EXACT_INPUT".to_string()),
            slippage_tolerance: Some(100),
            origin_asset: "nep141:wrap.near".to_string(),
            deposit_type: Some("INTENTS".to_string()),
            destination_asset: "nep141:wrap.near".to_string(),
            amount: "100000000000000000000000".to_string(), // 0.1 wNEAR
            refund_to: Some(format!("near:{}", dao_id)),
            refund_type: Some("CONFIDENTIAL_INTENTS".to_string()),
            recipient: Some(format!("near:{}", dao_id)),
            recipient_type: Some("CONFIDENTIAL_INTENTS".to_string()),
            deadline: deadline.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
            quote_waiting_time_ms: Some(5000),
        };

        let quote_result = get_quote(
            State(state.clone()),
            crate::auth::OptionalAuthUser(None),
            Json(quote_request),
        )
        .await;

        let quote_response = match quote_result {
            Ok(response) => {
                println!(
                    "Quote response:\n{}",
                    serde_json::to_string_pretty(&response.0).unwrap()
                );
                response.0
            }
            Err((status, message)) => {
                panic!("Quote failed: {} - {}", status, message);
            }
        };

        // Extract depositAddress from quote
        let deposit_address = quote_response
            .get("quote")
            .and_then(|q| q.get("depositAddress"))
            .and_then(|v| v.as_str())
            .expect("Quote response should contain depositAddress");

        println!("\nDeposit address: {}", deposit_address);

        // Step 2: Call generate-intent
        println!("\n=== Step 2: Generating intent ===");
        let generate_request = GenerateIntentRequest {
            r#type: "swap_transfer".to_string(),
            standard: "nep413".to_string(),
            signer_id: format!("near:{}", dao_id),
            quote_metadata: quote_response.clone(),
            notes: None,
        };

        let auth_user = crate::auth::AuthUser {
            account_id: "test.near".parse().unwrap(),
        };
        let generate_result =
            generate_intent(State(state.clone()), auth_user, Json(generate_request)).await;

        match generate_result {
            Ok(response) => {
                println!(
                    "Generate intent response:\n{}",
                    serde_json::to_string_pretty(&response.0).unwrap()
                );
            }
            Err((status, message)) => {
                panic!("Generate intent failed: {} - {}", status, message);
            }
        }
    }
}
