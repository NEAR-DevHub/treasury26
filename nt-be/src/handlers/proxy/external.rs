use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};

use crate::AppState;

const REF_SDK_BASE_URL: &str = "https://ref-sdk-test-cold-haze-1300-2.fly.dev/api";

/// Generic proxy endpoint for external API calls
/// Forwards requests to the external API with the given path and query parameters
pub async fn proxy_external_api(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    // Construct the full URL
    let mut url = format!("{}/{}", REF_SDK_BASE_URL, path);

    // Add query parameters if any
    if !params.is_empty() {
        let query_string = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");
        url = format!("{}?{}", url, query_string);
    }

    println!("Proxying request to: {}", url);

    // Proxy the request to the external API
    match state
        .http_client
        .get(&url)
        .header("accept", "application/json")
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status();
            if status.is_success() {
                match response.json::<Value>().await {
                    Ok(data) => (StatusCode::OK, Json(data)),
                    Err(e) => {
                        eprintln!("Failed to parse response from {}: {}", url, e);
                        (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(serde_json::json!({
                                "error": "Failed to parse response"
                            })),
                        )
                    }
                }
            } else {
                eprintln!("External API returned error {}: {}", status, url);
                (
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
                    Json(serde_json::json!({
                        "error": "External API error"
                    })),
                )
            }
        }
        Err(e) => {
            eprintln!("Failed to fetch from {}: {}", url, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "Failed to fetch from external API"
                })),
            )
        }
    }
}
