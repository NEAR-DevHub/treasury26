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

const REF_SDK_BASE_URL: &str = "https://ref-sdk-test-cold-haze-1300-2.fly.dev/api";

#[derive(Deserialize)]
pub struct TokenMetadataQuery {
    #[serde(rename = "defuseAssetId")]
    pub defuse_asset_id: String,
}

#[derive(Deserialize)]
pub struct BlockchainQuery {
    pub network: String,
    #[serde(default = "default_theme")]
    pub theme: String,
}

fn default_theme() -> String {
    "light".to_string()
}

/// Fetch token metadata by defuse asset ID(s)
/// Supports comma-separated list of IDs
pub async fn get_token_metadata(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TokenMetadataQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let cache_key = format!("ref-sdk:token-metadata:{}", query.defuse_asset_id);

    // Check cache first
    if let Some(cached_data) = state.cache.get(&cache_key).await {
        println!(
            "🔁 Returning cached token metadata for {}",
            query.defuse_asset_id
        );
        return Ok((StatusCode::OK, Json(cached_data)));
    }

    let url = format!(
        "{}/token-by-defuse-asset-id?defuseAssetId={}",
        REF_SDK_BASE_URL, query.defuse_asset_id
    );

    let response = state
        .http_client
        .get(&url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            eprintln!("Error fetching token metadata: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch token metadata: {}", e),
            )
        })?;

    if !response.status().is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("REF SDK error: {}", response.status()),
        ));
    }

    let data: Value = response.json().await.map_err(|e| {
        eprintln!("Error parsing token metadata response: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to parse response".to_string(),
        )
    })?;

    // Cache for 1 hour (token metadata doesn't change often)
    state.cache.insert(cache_key, data.clone()).await;

    Ok((StatusCode::OK, Json(data)))
}

/// Fetch blockchain/network metadata including icons
/// Supports comma-separated list of network names
pub async fn get_blockchain_metadata(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BlockchainQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let cache_key = format!("ref-sdk:blockchain:{}:{}", query.network, query.theme);

    // Check cache first
    if let Some(cached_data) = state.cache.get(&cache_key).await {
        println!(
            "🔁 Returning cached blockchain metadata for {} ({})",
            query.network, query.theme
        );
        return Ok((StatusCode::OK, Json(cached_data)));
    }

    let url = format!(
        "{}/blockchain-by-network?network={}&theme={}",
        REF_SDK_BASE_URL, query.network, query.theme
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

    Ok((StatusCode::OK, Json(data)))
}
