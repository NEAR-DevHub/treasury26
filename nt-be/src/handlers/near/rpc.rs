use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde_json::Value;
use std::sync::Arc;

use crate::AppState;

/// Generic NEAR RPC proxy endpoint
/// Forwards any RPC request to the NEAR blockchain using the configured network
pub async fn proxy_rpc(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    // Get the first RPC endpoint from the network config
    let endpoint = match state.network.rpc_endpoints.first() {
        Some(ep) => ep,
        None => {
            eprintln!("No RPC endpoints configured");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "jsonrpc": "2.0",
                    "error": {
                        "code": -32603,
                        "message": "No RPC endpoints configured"
                    },
                    "id": null
                })),
            );
        }
    };

    let rpc_url = endpoint.url.to_string();
    println!("Proxying RPC request to: {}", rpc_url);

    // Build the request with bearer token if available
    let mut request = state
        .http_client
        .post(&rpc_url)
        .header("Content-Type", "application/json");

    // Add bearer token header if configured
    if let Some(bearer) = &endpoint.bearer_header {
        request = request.header("Authorization", format!("Bearer {}", bearer));
    }

    // Send the request
    match request.json(&payload).send().await {
        Ok(response) => match response.json::<Value>().await {
            Ok(data) => (StatusCode::OK, Json(data)),
            Err(e) => {
                eprintln!("Failed to parse RPC response: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "jsonrpc": "2.0",
                        "error": {
                            "code": -32603,
                            "message": "Failed to parse RPC response"
                        },
                        "id": null
                    })),
                )
            }
        },
        Err(e) => {
            eprintln!("Failed to proxy RPC request: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "jsonrpc": "2.0",
                    "error": {
                        "code": -32603,
                        "message": format!("Failed to proxy RPC request: {}", e)
                    },
                    "id": null
                })),
            )
        }
    }
}
