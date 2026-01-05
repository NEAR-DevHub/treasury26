use std::{collections::HashMap, sync::Arc};

use axum::{
    Json,
    extract::{Query, State},
    response::IntoResponse,
};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::{
    AppState,
    constants::intents_chains::{ChainIcons, get_chain_metadata_by_name},
    handlers::proxy::external::fetch_proxy_api,
};

#[derive(Deserialize)]
pub struct TokenMetadataQuery {
    #[serde(rename = "tokenId")]
    pub token_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TokenMetadata {
    #[serde(rename = "tokenId")]
    pub token_id: String,
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "priceUpdatedAt")]
    pub price_updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "chainName")]
    pub chain_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "chainIcons")]
    pub chain_icons: Option<ChainIcons>,
}

/// This is the response from the Ref SDK API.
///
/// Sometimes it contains both camelCase and snake_case fields or only one of them.
/// We need to handle both cases. :)
#[derive(Deserialize, Debug, Clone)]
struct RefSdkToken {
    #[serde(rename = "defuseAssetId")]
    pub defuse_asset_id: Option<String>,
    #[serde(rename = "defuse_asset_id")]
    pub defuse_asset_id_snake_case: Option<String>,
    pub name: Option<String>,
    pub symbol: Option<String>,
    pub decimals: Option<u8>,
    pub icon: Option<String>,
    pub price: Option<f64>,
    #[serde(rename = "priceUpdatedAt")]
    pub price_updated_at: Option<String>,
    #[serde(rename = "price_updated_at")]
    pub price_updated_at_snake_case: Option<String>,
    #[serde(rename = "chainName")]
    pub chain_name: Option<String>,
    #[serde(rename = "chain_name")]
    pub chain_name_snake_case: Option<String>,
    pub error: Option<String>,
}

/// Fetches token metadata from Ref SDK API by defuse asset IDs
///
/// # Arguments
/// * `state` - Application state containing HTTP client and cache
/// * `defuse_asset_ids` - List of defuse asset IDs to fetch (supports batch)
///
/// # Returns
/// * `Ok(Vec<TokenMetadata>)` - List of token metadata with chain information
/// * `Err((StatusCode, String))` - Error with status code and message
pub async fn fetch_tokens_metadata(
    state: &Arc<AppState>,
    defuse_asset_ids: &[String],
) -> Result<Vec<TokenMetadata>, (StatusCode, String)> {
    if defuse_asset_ids.is_empty() {
        return Ok(Vec::new());
    }

    // Join asset IDs with commas for batch request
    let asset_ids_param = defuse_asset_ids.join(",");

    // Prepare query parameters for the Ref SDK API
    let mut query_params = HashMap::new();
    query_params.insert("defuseAssetId".to_string(), asset_ids_param);

    // Fetch token data from Ref SDK API
    let response = fetch_proxy_api(
        &state.http_client,
        &state.cache,
        &state.env_vars.ref_sdk_base_url,
        "token-by-defuse-asset-id",
        &query_params,
    )
    .await
    .map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to fetch token metadata: {}", e),
        )
    })?;

    // Parse as array of objects first
    let tokens: Vec<RefSdkToken> = serde_json::from_value(response).map_err(|e| {
        eprintln!("Failed to parse token response: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to parse token metadata response".to_string(),
        )
    })?;

    // Map RefSdkToken to TokenMetadata with chain metadata, filtering out errors/invalid entries
    let metadata_responses: Vec<TokenMetadata> = tokens
        .iter()
        .filter_map(|token| {
            // Skip error entries
            if token.error.is_some() {
                return None;
            }

            // Skip if missing required fields
            let token_id = token
                .defuse_asset_id
                .as_ref()
                .or(token.defuse_asset_id_snake_case.as_ref())?;
            let name = token.name.as_ref()?;
            let symbol = token.symbol.as_ref()?;
            let decimals = token.decimals?;
            let chain_name_str = token
                .chain_name
                .as_ref()
                .or(token.chain_name_snake_case.as_ref())?;

            let chain_metadata = get_chain_metadata_by_name(chain_name_str);
            let chain_name = chain_metadata.as_ref().map(|m| m.name.clone());
            let chain_icons = chain_metadata.map(|m| m.icon);

            Some(TokenMetadata {
                token_id: token_id.clone(),
                name: name.clone(),
                symbol: symbol.clone(),
                decimals,
                icon: token.icon.clone(),
                price: token.price,
                price_updated_at: token
                    .price_updated_at
                    .as_ref()
                    .or(token.price_updated_at_snake_case.as_ref())
                    .cloned(),
                network: Some(chain_name_str.clone()),
                chain_name,
                chain_icons,
            })
        })
        .collect();

    Ok(metadata_responses)
}

pub async fn get_token_metadata(
    State(state): State<Arc<AppState>>,
    Query(mut params): Query<TokenMetadataQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let cache_key = format!("token-metadata:{}", params.token_id);
    if let Some(cached_data) = state.cache.get(&cache_key).await {
        return Ok((StatusCode::OK, Json(cached_data)));
    }

    let is_near = params.token_id.to_lowercase() == "near" || params.token_id.is_empty();
    if is_near {
        params.token_id = "nep141:wrap.near".to_string();
    }

    // Fetch token metadata using the reusable function
    let tokens = fetch_tokens_metadata(&state, &[params.token_id.clone()]).await?;

    // Get the first token from the array
    let mut metadata = tokens
        .first()
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("Token not found: {}", params.token_id),
            )
        })?
        .clone();

    if is_near {
        metadata.name = "NEAR".to_string();
        metadata.symbol = "NEAR".to_string();
    }

    let result_value = serde_json::to_value(&metadata).map_err(|e| {
        eprintln!("Error serializing token metadata: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to serialize token metadata: {}", e),
        )
    })?;

    state.cache.insert(cache_key, result_value.clone()).await;

    Ok((StatusCode::OK, Json(result_value)))
}
