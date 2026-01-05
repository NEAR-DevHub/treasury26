use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;
use crate::utils::cache::{CacheKey, CacheTier};
use crate::utils::jsonrpc::{JsonRpcRequest, JsonRpcResponse};

#[derive(Deserialize)]
pub struct DepositAddressRequest {
    pub account_id: String,
    pub chain: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DepositAddressResult {
    pub address: String,
}

/// Fetch deposit address for a specific account and chain
pub async fn get_deposit_address(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DepositAddressRequest>,
) -> Result<Json<DepositAddressResult>, (StatusCode, String)> {
    let account_id = request.account_id.clone();
    let chain = request.chain.clone();

    let cache_key = CacheKey::new("bridge:deposit-address")
        .with(&account_id)
        .with(&chain)
        .build();

    let state_clone = state.clone();
    let result = state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            // Prepare JSON-RPC request
            let rpc_request = JsonRpcRequest::new(
                "depositAddressFetch",
                "deposit_address",
                vec![serde_json::json!({
                    "account_id": account_id,
                    "chain": chain,
                })],
            );

            // Make request to bridge RPC
            let response = state_clone
                .http_client
                .post(&state_clone.env_vars.bridge_rpc_url)
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
        })
        .await?;

    Ok(Json(result))
}
