use std::{str::FromStr, sync::Arc};

use axum::{
    Json,
    extract::{Query, State},
    response::IntoResponse,
};
use near_api::{AccountId, NetworkConfig, Tokens};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::{AppState, handlers::intents::supported_tokens::fetch_enriched_tokens};

#[derive(Deserialize)]
pub struct TokenMetadataQuery {
    #[serde(rename = "tokenId")]
    pub token_id: String,
    pub network: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TokenMetadataResponse {
    pub token_id: String,
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain_name: Option<String>,
}

async fn fetch_near_token_metadata(
    token_id: AccountId,
    network: &NetworkConfig,
) -> Result<TokenMetadataResponse, String> {
    let metadata = Tokens::ft_metadata(token_id.clone())
        .fetch_from(network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching token metadata for {}: {}", token_id, e);
            format!("Failed to fetch token metadata: {}", e)
        })?
        .data;

    Ok(TokenMetadataResponse {
        token_id: token_id.to_string(),
        name: metadata.name,
        symbol: metadata.symbol,
        decimals: metadata.decimals,
        icon: metadata.icon,
        price: None,
        price_updated_at: None,
        chain_name: Some("near".to_string()),
    })
}

pub async fn get_token_metadata(
    State(state): State<Arc<AppState>>,
    Query(mut params): Query<TokenMetadataQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let cache_key = format!("token-metadata:{}:{}", params.token_id, params.network);
    if let Some(cached_data) = state.cache.get(&cache_key).await {
        return Ok((StatusCode::OK, Json(cached_data)));
    }
    let is_near = params.token_id.to_lowercase() == "near" || params.token_id.is_empty();
    if is_near {
        params.token_id = "nep141:wrap.near".to_string();
    }

    // Fetch supported tokens from the bridge (enriched version)
    let supported_tokens = fetch_enriched_tokens(&state).await.map_err(|e| {
        eprintln!("Error fetching supported tokens: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to fetch supported tokens: {}", e),
        )
    })?;

    let token = supported_tokens
        .into_iter()
        .find(|t| {
            t.near_token_id.as_ref() == Some(&params.token_id)
                || t.intents_token_id.as_ref() == Some(&params.token_id)
                || t.asset_name.to_lowercase() == params.token_id.to_lowercase()
                || t.contract_address == params.token_id
        })
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("Token {} not found in supported tokens", params.token_id),
            )
        })?;

    let mut metadata = TokenMetadataResponse {
        token_id: params.token_id.clone(),
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        icon: token.icon,
        price: token.price,
        price_updated_at: token.price_updated_at,
        chain_name: Some(token.chain_name),
    };

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
