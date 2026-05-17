use axum::{Json, extract::State, http::StatusCode};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;
use crate::auth::OptionalAuthUser;
use crate::utils::cache::{CacheKey, CacheTier};
use crate::utils::jsonrpc::{JsonRpcRequest, JsonRpcResponse};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositAddressRequest {
    pub account_id: AccountId,
    pub chain: String,
    pub token_id: Option<String>,
    pub amount: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DepositAddressResult {
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_amount: Option<String>,
    pub memo: Option<String>,
}

/// For confidential treasuries, get a confidential quote to obtain the intents
/// deposit address, then fetch the bridge deposit address for that quote address.
async fn get_confidential_deposit_address(
    state: &Arc<AppState>,
    account_id: &near_account_id::AccountIdRef,
    chain: &str,
    token_id: &str,
    mut amount: u128,
) -> Result<DepositAddressResult, (StatusCode, String)> {
    let access_token = super::confidential::refresh_dao_jwt(state, account_id).await?;
    let account_id = account_id.as_str();

    let url = format!("{}/v0/quote", state.env_vars.confidential_api_url);

    let deadline = (chrono::Utc::now() + chrono::Duration::hours(24))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    // Try with the FE-provided amount, retrying with 10x increases if too low.
    // Max 5 retries (amount * 10^5) to avoid infinite loops.
    if amount == 0 {
        amount = 1;
    }
    let mut last_error = String::new();

    for attempt in 0..5 {
        let quote_body = serde_json::json!({
            "dry": false,
            "swapType": "EXACT_INPUT",
            "slippageTolerance": 100,
            "originAsset": token_id,
            "depositType": "INTENTS",
            "destinationAsset": token_id,
            "amount": amount.to_string(),
            "refundTo": account_id,
            "refundType": "CONFIDENTIAL_INTENTS",
            "recipient": account_id,
            "recipientType": "CONFIDENTIAL_INTENTS",
            "deadline": &deadline,
            "quoteWaitingTimeMs": 5000,
        });

        match super::quote::send_oneclick_request(state, &url, &quote_body, Some(&access_token))
            .await
        {
            Ok(response_body) => {
                let quote_deposit_address = response_body
                    .get("quote")
                    .and_then(|q| q.get("depositAddress"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        (
                            StatusCode::BAD_GATEWAY,
                            "Confidential quote did not return a depositAddress".to_string(),
                        )
                    })?
                    .to_string();

                let mut bridge_result =
                    fetch_bridge_deposit_address(state, &quote_deposit_address, chain).await?;
                bridge_result.min_amount = Some(amount.to_string());
                return Ok(bridge_result);
            }
            Err((status, msg)) => {
                last_error = msg.clone();
                let is_amount_error = msg.to_lowercase().contains("amount")
                    || msg.to_lowercase().contains("too low")
                    || msg.to_lowercase().contains("minimum");
                if !is_amount_error || attempt == 4 {
                    return Err((status, msg));
                }
                log::info!(
                    "Quote amount {} too low (attempt {}), retrying with 10x",
                    amount,
                    attempt + 1
                );
                amount *= 10;
            }
        }
    }

    Err((StatusCode::BAD_GATEWAY, last_error))
}

/// Fetch deposit address from the bridge RPC for a given account and chain.
async fn fetch_bridge_deposit_address(
    state: &Arc<AppState>,
    account_id: &str,
    chain: &str,
) -> Result<DepositAddressResult, (StatusCode, String)> {
    let cache_key = CacheKey::new("bridge:deposit-address")
        .with(account_id)
        .with(chain)
        .build();

    let account_id = account_id.to_string();
    let chain = chain.to_string();
    let state_clone = state.clone();

    state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            // Try SIMPLE mode first, fall back to MEMO if it fails
            match fetch_deposit_address(&state_clone, &account_id, &chain, "SIMPLE").await {
                Ok(result) => Ok(result),
                Err(_) => fetch_deposit_address(&state_clone, &account_id, &chain, "MEMO").await,
            }
        })
        .await
}

/// Fetch deposit address for a specific account and chain.
/// For confidential treasuries, this first obtains a confidential quote to get
/// an intents deposit address, then fetches the bridge address for that.
pub async fn get_deposit_address(
    State(state): State<Arc<AppState>>,
    auth: OptionalAuthUser,
    Json(request): Json<DepositAddressRequest>,
) -> Result<Json<DepositAddressResult>, (StatusCode, String)> {
    let account_id = request.account_id.clone();
    let chain = request.chain.clone();

    let confidential = auth
        .verify_member_if_confidential(&state.db_pool, &account_id)
        .await?;

    if confidential {
        let token_id = request.token_id.ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "tokenId is required for confidential treasuries".to_string(),
            )
        })?;
        let amount: u128 = request
            .amount
            .as_deref()
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);
        let result =
            get_confidential_deposit_address(&state, &account_id, &chain, &token_id, amount)
                .await?;
        return Ok(Json(result));
    }

    let result = fetch_bridge_deposit_address(&state, account_id.as_str(), &chain).await?;
    Ok(Json(result))
}

async fn fetch_deposit_address(
    state: &AppState,
    account_id: &str,
    chain: &str,
    deposit_mode: &str,
) -> Result<DepositAddressResult, String> {
    let rpc_request = JsonRpcRequest::new(
        "depositAddressFetch",
        "deposit_address",
        vec![serde_json::json!({
            "deposit_mode": deposit_mode,
            "account_id": account_id,
            "chain": chain,
        })],
    );

    let response = state
        .http_client
        .post(&state.env_vars.bridge_rpc_url)
        .header("content-type", "application/json")
        .json(&rpc_request)
        .send()
        .await
        .map_err(|e| {
            eprintln!("Error fetching deposit address from bridge: {}", e);
            format!("Failed to fetch deposit address: {}", e)
        })?;

    if !response.status().is_success() {
        return Err(format!("HTTP error! status: {}", response.status()));
    }

    let data = response
        .json::<JsonRpcResponse<DepositAddressResult>>()
        .await
        .map_err(|e| {
            eprintln!("Error parsing bridge response: {}", e);
            "Failed to parse bridge response".to_string()
        })?;

    if let Some(error) = data.error {
        return Err(error.message);
    }

    data.result
        .ok_or_else(|| "No deposit address found".to_string())
}
