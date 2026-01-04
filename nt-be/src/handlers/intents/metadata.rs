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

/// Core logic for fetching token metadata (reusable)
/// Supports comma-separated list of IDs
pub async fn fetch_token_metadata_data(
    state: &Arc<AppState>,
    defuse_asset_id: &str,
) -> Result<Value, (StatusCode, String)> {
    let cache_key = format!("ref-sdk:token-metadata:{}", defuse_asset_id);

    // Check cache first
    if let Some(cached_data) = state.cache.get(&cache_key).await {
        return Ok(cached_data);
    }

    let url = format!(
        "{}/token-by-defuse-asset-id?defuseAssetId={}",
        state.env_vars.ref_sdk_base_url, defuse_asset_id
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

    Ok(data)
}

/// Core logic for fetching blockchain metadata (reusable)
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

/// Handler: Fetch token metadata by defuse asset ID(s)
pub async fn get_token_metadata(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TokenMetadataQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let data = fetch_token_metadata_data(&state, &query.defuse_asset_id).await?;
    Ok((StatusCode::OK, Json(data)))
}

/// Handler: Fetch blockchain/network metadata including icons
pub async fn get_blockchain_metadata(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BlockchainQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let data = fetch_blockchain_metadata_data(&state, &query.network, &query.theme).await?;
    Ok((StatusCode::OK, Json(data)))
}
