use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use moka::future::Cache;
use reqwest::Client;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};

use crate::AppState;

/// Fetches JSON data from an external API with caching
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `cache` - The cache to store responses in
/// * `base_url` - The base URL of the API
/// * `path` - The path to append to the base URL
/// * `params` - Query parameters to include in the request
///
/// # Returns
/// * `Ok(Value)` - The parsed JSON response
/// * `Err(String)` - An error message describing what went wrong
pub async fn fetch_proxy_api(
    client: &Client,
    cache: &Cache<String, Value>,
    base_url: &str,
    path: &str,
    params: &HashMap<String, String>,
) -> Result<Value, String> {
    // Construct the full URL for both fetching and cache key
    let mut url = format!("{}/{}", base_url, path);

    // Add query parameters if any
    let query_string = if !params.is_empty() {
        let qs = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");
        url = format!("{}?{}", url, qs);
        qs
    } else {
        String::new()
    };

    // Create cache key from base_url, path, and query params
    let cache_key = format!("proxy:{}:{}:{}", base_url, path, query_string);

    // Check cache first
    if let Some(cached_data) = cache.get(&cache_key).await {
        println!("Cache hit for: {}", url);
        return Ok(cached_data);
    }

    println!("Cache miss, proxying request to: {}", url);

    // Proxy the request to the external API
    match client
        .get(&url)
        .header("accept", "application/json")
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status();
            if status.is_success() {
                match response.json::<Value>().await {
                    Ok(data) => {
                        // Store in cache
                        cache.insert(cache_key, data.clone()).await;
                        Ok(data)
                    }
                    Err(e) => {
                        eprintln!("Failed to parse response from {}: {}", url, e);
                        Err("Failed to parse response".to_string())
                    }
                }
            } else {
                eprintln!("External API returned error {}: {}", status, url);
                Err(format!("External API error: {}", status))
            }
        }
        Err(e) => {
            eprintln!("Failed to fetch from {}: {}", url, e);
            Err("Failed to fetch from external API".to_string())
        }
    }
}

/// Generic proxy endpoint for external API calls
/// Forwards requests to the external API with the given path and query parameters
pub async fn proxy_external_api(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    match fetch_proxy_api(
        &state.http_client,
        &state.cache,
        &state.env_vars.ref_sdk_base_url,
        &path,
        &params,
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(error_msg) => {
            let status_code = if error_msg.starts_with("External API error") {
                StatusCode::BAD_GATEWAY
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (
                status_code,
                Json(serde_json::json!({
                    "error": error_msg
                })),
            )
        }
    }
}
