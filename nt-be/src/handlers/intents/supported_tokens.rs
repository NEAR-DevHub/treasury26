use axum::{Json, extract::State, http::StatusCode};
use serde_json::Value;
use std::sync::Arc;

use crate::AppState;
use crate::utils::cache::CacheTier;
use crate::utils::jsonrpc::{JsonRpcRequest, JsonRpcResponse};

/// Fetch supported tokens
pub async fn fetch_supported_tokens_data(
    state: &Arc<AppState>,
) -> Result<Value, (StatusCode, String)> {
    // Check cache first
    let cache_key = "bridge:supported-tokens".to_string();
    let state_clone = state.clone();

    state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            // Prepare JSON-RPC request
            let rpc_request = JsonRpcRequest::new(
                "supportedTokensFetchAll",
                "supported_tokens",
                vec![serde_json::json!({})],
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

            Ok::<_, (StatusCode, String)>(result)
        })
        .await
}

/// Handler: Get list of all supported bridge tokens from intents.near
pub async fn get_supported_tokens(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let result = fetch_supported_tokens_data(&state).await?;
    Ok(Json(result))
}
