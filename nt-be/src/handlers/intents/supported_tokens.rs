use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde_json::Value;
use std::sync::Arc;

use crate::AppState;
use crate::utils::jsonrpc::{JsonRpcRequest, JsonRpcResponse};

/// Get list of all supported bridge tokens from intents.near
/// Fetches directly from the bridge RPC endpoint
pub async fn get_supported_tokens(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    // Check cache first
    let cache_key = "bridge:supported-tokens".to_string();
    if let Some(cached_data) = state.cache.get(&cache_key).await {
        println!("🔁 Returning cached supported tokens");
        return Ok((StatusCode::OK, Json(cached_data)));
    }

    // Prepare JSON-RPC request
    let rpc_request = JsonRpcRequest::new(
        "supportedTokensFetchAll",
        "supported_tokens",
        vec![serde_json::json!({})],
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
            eprintln!("Error fetching supported tokens from bridge: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch supported tokens: {}", e),
            )
        })?;

    if !response.status().is_success() {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("HTTP error! status: {}", response.status()),
        ));
    }

    let data = response
        .json::<JsonRpcResponse<Value>>()
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
        "No supported tokens found".to_string(),
    ))?;

    // Cache for 3600 seconds (1 hour) - supported tokens don't change frequently
    state.cache.insert(cache_key, result.clone()).await;

    Ok((StatusCode::OK, Json(result)))
}
