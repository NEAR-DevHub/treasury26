use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use crate::AppState;
use crate::constants::intents_tokens;
use crate::utils::jsonrpc::{JsonRpcRequest, JsonRpcResponse};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SupportedToken {
    pub asset_name: String,
    pub decimals: u8,
    pub defuse_asset_identifier: String,
    pub intents_token_id: String,
    pub min_deposit_amount: String,
    pub min_withdrawal_amount: String,
    pub near_token_id: String,
    pub standard: String,
    pub withdrawal_fee: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SupportedTokensResult {
    pub tokens: Vec<SupportedToken>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ExternalTokenMetadata {
    pub defuse_asset_id: String,
    pub decimals: u8,
    pub blockchain: String,
    pub symbol: String,
    pub contract_address: Option<String>,
    pub price: Option<f64>,
    pub price_updated_at: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
struct ExternalTokensResponse {
    items: Vec<ExternalTokenMetadata>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EnrichedTokenMetadata {
    pub defuse_asset_id: String,
    pub contract_address: String,
    pub decimals: u8,
    pub symbol: String,
    pub name: String,
    pub asset_name: String,
    #[serde(rename = "chainName")]
    pub chain_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub near_token_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intents_token_id: Option<String>,
}

/// Internal function to fetch supported tokens data
/// This can be reused by other handlers
pub async fn fetch_supported_tokens_data(
    state: &AppState,
) -> Result<SupportedTokensResult, String> {
    // Check cache first
    let cache_key = "bridge:supported-tokens".to_string();
    if let Some(cached_data) = state.cache.get(&cache_key).await {
        println!("🔁 Returning cached supported tokens");
        return serde_json::from_value(cached_data).map_err(|e| {
            eprintln!("Error deserializing cached supported tokens: {}", e);
            format!("Failed to deserialize cached data: {}", e)
        });
    }

    // Prepare JSON-RPC request
    let rpc_request = JsonRpcRequest::new(
        "supportedTokensFetchAll",
        "supported_tokens",
        vec![serde_json::json!({})],
    );

    // Make request to bridge RPC
    let response = state
        .http_client
        .post(&state.env_vars.bridge_rpc_url)
        .header("content-type", "application/json")
        .json(&rpc_request)
        .send()
        .await
        .map_err(|e| {
            eprintln!("Error fetching supported tokens from bridge: {}", e);
            format!("Failed to fetch supported tokens: {}", e)
        })?;

    if !response.status().is_success() {
        return Err(format!("HTTP error! status: {}", response.status()));
    }

    let data = response
        .json::<JsonRpcResponse<SupportedTokensResult>>()
        .await
        .map_err(|e| {
            eprintln!("Error parsing bridge response: {}", e);
            "Failed to parse bridge response".to_string()
        })?;

    if let Some(error) = data.error {
        return Err(error.message);
    }

    let mut result = data
        .result
        .ok_or("No result in bridge response".to_string())?;

    result.tokens = result
        .tokens
        .into_iter()
        .filter(|t| t.standard == "nep141")
        // Deduplicate by intents_token_id to avoid double-counting balances
        // Some tokens (like NEAR/wNEAR) may have duplicate entries with the same intents_token_id
        .map(|t| (t.defuse_asset_identifier.clone(), t))
        .collect::<HashMap<String, SupportedToken>>()
        .into_values()
        .collect();

    // Convert to JSON value for caching
    let result_value = serde_json::to_value(&result).map_err(|e| {
        eprintln!("Error serializing supported tokens: {}", e);
        format!("Failed to serialize supported tokens: {}", e)
    })?;

    // Cache for 300 seconds (5 minutes) - supported tokens don't change frequently
    state.cache.insert(cache_key, result_value).await;

    Ok(result)
}

/// Fetch external token metadata with prices
async fn fetch_external_tokens_metadata(
    state: &AppState,
) -> Result<Vec<ExternalTokenMetadata>, String> {
    // Check cache first
    let cache_key = "intents-chaindefuser-tokens".to_string();
    if let Some(cached_data) = state.cache.get(&cache_key).await {
        println!("🔁 Returning cached external tokens metadata");
        return serde_json::from_value::<ExternalTokensResponse>(cached_data)
            .map(|r| r.items)
            .map_err(|e| {
                eprintln!("Error deserializing cached external tokens: {}", e);
                format!("Failed to deserialize cached data: {}", e)
            });
    }

    // Fetch from external API
    let response = state
        .http_client
        .get("https://api-mng-console.chaindefuser.com/api/tokens")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| {
            eprintln!("Warning: External API failed: {}", e);
            format!("Failed to fetch external tokens: {}", e)
        })?;

    if !response.status().is_success() {
        return Err(format!(
            "External API HTTP error! status: {}",
            response.status()
        ));
    }

    let response_text = response.text().await.map_err(|e| {
        eprintln!("Error reading external API response: {}", e);
        "Failed to read external API response".to_string()
    })?;

    let data = serde_json::from_str::<ExternalTokensResponse>(&response_text).map_err(|e| {
        eprintln!("Error parsing external API response: {}", e);
        eprintln!("Response body: {}", response_text);
        "Failed to parse external API response".to_string()
    })?;

    // Cache for 300 seconds (5 minutes)
    if let Ok(result_value) = serde_json::to_value(&data) {
        state.cache.insert(cache_key, result_value).await;
    }

    Ok(data.items)
}

/// Fetch all supported tokens from the bridge with enriched metadata
pub async fn fetch_enriched_tokens(state: &AppState) -> Result<Vec<EnrichedTokenMetadata>, String> {
    // Fetch both bridge tokens and external metadata in parallel
    let (bridge_tokens_result, external_tokens_result) = tokio::join!(
        fetch_supported_tokens_data(state),
        fetch_external_tokens_metadata(state)
    );

    let bridge_tokens = bridge_tokens_result?;

    // Create a hashmap for quick lookup of external metadata by defuse_asset_id
    let external_map: HashMap<String, ExternalTokenMetadata> = external_tokens_result
        .unwrap_or_default()
        .into_iter()
        .map(|t| (t.defuse_asset_id.clone(), t))
        .collect();

    // Enrich bridge tokens with external metadata
    let enriched_tokens: Vec<EnrichedTokenMetadata> = bridge_tokens
        .tokens
        .into_iter()
        .map(|token| {
            let external_meta = external_map.get(&token.intents_token_id);

            // Try to find icon from local token list
            let local_token =
                intents_tokens::find_token_by_defuse_asset_id(&token.intents_token_id);
            let icon = local_token.as_ref().map(|t| t.icon.to_string());
            let local_chain = local_token.as_ref().map(|t| t.origin_chain_name.clone());
            EnrichedTokenMetadata {
                defuse_asset_id: token.defuse_asset_identifier.clone(),
                contract_address: external_meta
                    .and_then(|e| e.contract_address.clone())
                    .unwrap_or_else(|| "native".to_string()),
                decimals: token.decimals,
                symbol: external_meta
                    .map(|e| e.symbol.clone())
                    .unwrap_or_else(|| token.asset_name.clone()),
                name: local_token
                    .as_ref()
                    .map(|t| t.name.clone())
                    .unwrap_or_else(|| token.asset_name.clone()),
                asset_name: token.asset_name.clone(),
                chain_name: external_meta
                    .map(|e| e.blockchain.clone())
                    .or(local_chain)
                    .unwrap_or_else(|| "near".to_string()),
                price: external_meta.and_then(|e| e.price),
                price_updated_at: external_meta.and_then(|e| e.price_updated_at.clone()),
                icon,
                near_token_id: Some(token.near_token_id),
                intents_token_id: Some(token.intents_token_id),
            }
        })
        .collect();

    Ok(enriched_tokens)
}

/// Fetch all supported tokens from the bridge with enriched metadata (Axum handler)
pub async fn get_supported_tokens(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let enriched_tokens = fetch_enriched_tokens(&state)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let result_value = serde_json::json!({
        "tokens": enriched_tokens
    });

    Ok((StatusCode::OK, Json(result_value)))
}
