use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;
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
) -> Result<impl IntoResponse, (StatusCode, String)> {
    // Check cache first
    let cache_key = format!(
        "bridge:deposit-address:{}:{}",
        request.account_id, request.chain
    );
    if let Some(cached_data) = state.cache.get(&cache_key).await {
        println!(
            "🔁 Returning cached deposit address for {} / {}",
            request.account_id, request.chain
        );
        return Ok((StatusCode::OK, Json(cached_data)));
    }

    // Prepare JSON-RPC request
    let rpc_request = JsonRpcRequest::new(
        "depositAddressFetch",
        "deposit_address",
        vec![serde_json::json!({
            "account_id": request.account_id,
            "chain": request.chain,
        })],
    );

    // Make request to bridge RPC
    let response = state
        .http_client
        .post(&state.env_vars.bridge_rpc_url)
        .header("content-type", "application/json")
        .json(&rpc_request)
        .send()
        .await
        .map_err(|e| {
            eprintln!("Error fetching deposit address from bridge: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch deposit address: {}", e),
            )
        })?;

    if !response.status().is_success() {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("HTTP error! status: {}", response.status()),
        ));
    }

    let data = response
        .json::<JsonRpcResponse<DepositAddressResult>>()
        .await
        .map_err(|e| {
            eprintln!("Error parsing bridge response: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to parse bridge response".to_string(),
            )
        })?;

    if let Some(error) = data.error {
        return Err((StatusCode::BAD_REQUEST, error.message));
    }

    let result = data.result.ok_or((
        StatusCode::NOT_FOUND,
        "No deposit address found".to_string(),
    ))?;

    // Convert to JSON value for caching
    let result_value = serde_json::to_value(&result).map_err(|e| {
        eprintln!("Error serializing deposit address: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to serialize deposit address: {}", e),
        )
    })?;

    // Cache for 3600 seconds (1 hour) - deposit addresses don't change
    state.cache.insert(cache_key, result_value.clone()).await;

    Ok((StatusCode::OK, Json(result_value)))
}
