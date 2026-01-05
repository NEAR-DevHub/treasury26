use std::{collections::HashMap, sync::Arc};

use axum::{
    Json,
    extract::{Query, State},
    response::IntoResponse,
};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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

#[derive(Debug, Clone)]
struct RefSdkToken {
    pub defuse_asset_id: Option<String>,
    pub name: Option<String>,
    pub symbol: Option<String>,
    pub decimals: Option<u8>,
    pub icon: Option<String>,
    pub price: Option<f64>,
    pub price_updated_at: Option<String>,
    pub chain_name: Option<String>,
    pub error: Option<String>,
}

/// Manual parser for RefSdkToken to handle duplicate keys in API response
/// The REF SDK API returns both snake_case and camelCase versions of some fields
fn parse_ref_sdk_token(value: &Value) -> Option<RefSdkToken> {
    let obj = value.as_object()?;

    // Check for error field first
    if let Some(error) = obj.get("error") {
        if !error.is_null() {
            return None;
        }
    }

    // Helper to get string value with fallback
    let get_string = |primary: &str, fallback: &str| -> Option<String> {
        obj.get(primary)
            .and_then(|v: &Value| v.as_str())
            .or_else(|| obj.get(fallback).and_then(|v: &Value| v.as_str()))
            .map(String::from)
    };

    Some(RefSdkToken {
        defuse_asset_id: get_string("defuseAssetId", "defuse_asset_id"),
        name: get_string("name", "asset_name"),
        symbol: obj
            .get("symbol")
            .and_then(|v: &Value| v.as_str())
            .map(String::from),
        decimals: obj
            .get("decimals")
            .and_then(|v: &Value| v.as_u64())
            .map(|d| d as u8),
        icon: obj
            .get("icon")
            .and_then(|v: &Value| v.as_str())
            .map(String::from),
        price: obj.get("price").and_then(|v: &Value| v.as_f64()),
        price_updated_at: get_string("priceUpdatedAt", "price_updated_at"),
        chain_name: get_string("chainName", "chain_name"),
        error: None,
    })
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

    // Parse manually to handle duplicate keys in API response
    let tokens: Vec<RefSdkToken> = if let Some(arr) = response.as_array() {
        // Direct array response - parse each item
        arr.iter().filter_map(parse_ref_sdk_token).collect()
    } else if let Some(data) = response.get("data") {
        // Response wrapped in { "data": [...] }
        if let Some(arr) = data.as_array() {
            arr.iter().filter_map(parse_ref_sdk_token).collect()
        } else {
            // Single object in data field
            parse_ref_sdk_token(data).into_iter().collect()
        }
    } else if let Some(tokens_field) = response.get("tokens") {
        // Response wrapped in { "tokens": [...] }
        if let Some(arr) = tokens_field.as_array() {
            arr.iter().filter_map(parse_ref_sdk_token).collect()
        } else {
            // Single object in tokens field
            parse_ref_sdk_token(tokens_field).into_iter().collect()
        }
    } else {
        // Try as single object
        parse_ref_sdk_token(&response).into_iter().collect()
    };

    if tokens.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            "No valid tokens found in API response".to_string(),
        ));
    }

    // Map RefSdkToken to TokenMetadata with chain metadata, filtering out errors and invalid entries
    let metadata_responses: Vec<TokenMetadata> = tokens
        .iter()
        .filter_map(|token| {
            // Skip error entries
            if token.error.is_some() {
                eprintln!("Skipping token with error: {:?}", token.error);
                return None;
            }

            // Skip if missing required fields
            let token_id = token.defuse_asset_id.as_ref()?;
            let name = token.name.as_ref()?;
            let symbol = token.symbol.as_ref()?;
            let decimals = token.decimals?;
            let chain_name_str = token.chain_name.as_ref()?;

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
                price_updated_at: token.price_updated_at.clone(),
                network: Some(chain_name_str.clone()),
                chain_name,
                chain_icons,
            })
        })
        .collect();

    if metadata_responses.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            "No valid tokens found in response".to_string(),
        ));
    }

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
