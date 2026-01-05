use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

use crate::AppState;

#[derive(Deserialize)]
pub struct BlockchainQuery {
    pub network: String,
    #[serde(default = "default_theme")]
    pub theme: String,
}

fn default_theme() -> String {
    "light".to_string()
}

/// Fetch blockchain metadata
/// Supports comma-separated list of network names
pub async fn fetch_blockchain_metadata_data(
    state: &Arc<AppState>,
    network: &str,
    theme: &str,
) -> Result<Value, (StatusCode, String)> {
    let cache_key = format!("ref-sdk:blockchain:{}:{}", network, theme);

    // Check cache first
    if let Some(cached_data) = state.cache.get(&cache_key).await {
        return Ok(cached_data);
    }

    let url = format!(
        "{}/blockchain-by-network?network={}&theme={}",
        state.env_vars.ref_sdk_base_url, network, theme
    );

    let response = state
        .http_client
        .get(&url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            eprintln!("Error fetching blockchain metadata: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch blockchain metadata: {}", e),
            )
        })?;

    if !response.status().is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("REF SDK error: {}", response.status()),
        ));
    }

    let data: Value = response.json().await.map_err(|e| {
        eprintln!("Error parsing blockchain metadata response: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to parse response".to_string(),
        )
    })?;

    // Cache for 24 hours (blockchain metadata rarely changes)
    state.cache.insert(cache_key, data.clone()).await;

    Ok(data)
}

/// Handler: Fetch blockchain/network metadata including icons
pub async fn get_blockchain_metadata(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BlockchainQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let data = fetch_blockchain_metadata_data(&state, &query.network, &query.theme).await?;
    Ok((StatusCode::OK, Json(data)))
}
