use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use reqwest::Client;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};

use crate::AppState;
use crate::utils::cache::{CacheKey, CacheTier};

/// Fetches JSON data from an external API
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `base_url` - The base URL of the API
/// * `path` - The path to append to the base URL
/// * `params` - Query parameters to include in the request
///
/// # Returns
/// * `Ok(Value)` - The parsed JSON response
/// * `Err(String)` - An error message describing what went wrong
pub async fn fetch_proxy_api(
    client: &Client,
    base_url: &str,
    path: &str,
    params: &HashMap<String, String>,
) -> Result<Value, String> {
    // Construct the full URL
    let mut url = format!("{}/{}", base_url, path);

    // Add query parameters if any
    if !params.is_empty() {
        let mut sorted_params: Vec<_> = params.iter().collect();
        sorted_params.sort_by_key(|(k, _)| *k);
        let qs = sorted_params
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");
        url = format!("{}?{}", url, qs);
    }

    println!("Proxying request to: {}", url);

    // Proxy the request to the external API
    let response = client
        .get(&url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            eprintln!("Failed to fetch from {}: {}", url, e);
            "Failed to fetch from external API".to_string()
        })?;

    let status = response.status();
    if status.is_success() {
        response.json::<Value>().await.map_err(|e| {
            eprintln!("Failed to parse response from {}: {}", url, e);
            "Failed to parse response".to_string()
        })
    } else {
        eprintln!("External API returned error {}: {}", status, url);
        Err(format!("External API error: {}", status))
    }
}

/// Generic proxy endpoint for external API calls
/// Forwards requests to the external API with the given path and query parameters
pub async fn proxy_external_api(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let mut sorted_params: Vec<_> = params.iter().collect();
    sorted_params.sort_by_key(|(k, _)| *k);
    let query_string = sorted_params
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("&");

    let cache_key = CacheKey::new("proxy")
        .with(&state.env_vars.ref_sdk_base_url)
        .with(&path)
        .with(&query_string)
        .build();

    let state_clone = state.clone();
    match state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            fetch_proxy_api(
                &state_clone.http_client,
                &state_clone.env_vars.ref_sdk_base_url,
                &path,
                &params,
            )
            .await
        })
        .await
    {
        Ok(data) => Ok(Json(data)),
        Err((status, error_msg)) => {
            let status_code = if error_msg.starts_with("External API error") {
                StatusCode::BAD_GATEWAY
            } else {
                status
            };
            Err((
                status_code,
                Json(serde_json::json!({
                    "error": error_msg
                })),
            ))
        }
    }
}
