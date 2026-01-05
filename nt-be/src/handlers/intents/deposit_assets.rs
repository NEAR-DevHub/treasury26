use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

use super::supported_tokens::fetch_supported_tokens_data;
use crate::{
    AppState,
    handlers::token::metadata::{TokenMetadata, fetch_tokens_metadata},
};

#[derive(Deserialize)]
pub struct DepositAssetsQuery {
    #[serde(default = "default_theme")]
    pub theme: String,
}

fn default_theme() -> String {
    "light".to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkOption {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub chain_id: String,
    pub decimals: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetOption {
    pub id: String,
    pub asset_name: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub networks: Vec<NetworkOption>,
}

#[derive(Serialize)]
pub struct DepositAssetsResponse {
    pub assets: Vec<AssetOption>,
}

pub async fn get_deposit_assets(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DepositAssetsQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let cache_key = format!("deposit-assets:{}", query.theme);

    if let Some(cached_data) = state.cache.get(&cache_key).await {
        return Ok((StatusCode::OK, Json(cached_data)));
    }

    // Step 1: Fetch supported tokens using existing helper
    let supported = fetch_supported_tokens_data(&state).await?;

    // Step 2: Filter for nep141 tokens only
    let all_tokens = supported.get("tokens").and_then(|t| t.as_array()).ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "Invalid format".to_string(),
    ))?;

    let nep141_tokens: Vec<&Value> = all_tokens
        .iter()
        .filter(|t| {
            t.get("standard")
                .and_then(|s| s.as_str())
                .map(|s| s == "nep141")
                .unwrap_or(false)
        })
        .collect();

    // Step 3: Deduplicate by intents_token_id
    let mut token_map: HashMap<String, &Value> = HashMap::new();
    for token in nep141_tokens {
        if let Some(intents_id) = token.get("intents_token_id").and_then(|id| id.as_str()) {
            token_map.entry(intents_id.to_string()).or_insert(token);
        }
    }

    let tokens: Vec<&Value> = token_map.values().copied().collect();
    let defuse_ids: Vec<String> = tokens
        .iter()
        .filter_map(|t| {
            t.get("intents_token_id")
                .and_then(|id| id.as_str())
                .map(String::from)
        })
        .collect();

    // Step 4: Batch fetch token metadata using the enriched metadata function
    let tokens_metadata = fetch_tokens_metadata(&state, &defuse_ids).await?;

    // Build metadata map for fast lookup
    let metadata_map: HashMap<String, &TokenMetadata> = tokens_metadata
        .iter()
        .map(|meta| (meta.token_id.clone(), meta))
        .collect();

    // Step 5: Group by canonical symbol
    let mut asset_map: HashMap<String, AssetOption> = HashMap::new();

    for token in tokens {
        let intents_id = match token.get("intents_token_id").and_then(|id| id.as_str()) {
            Some(id) => id,
            None => continue,
        };

        let meta = match metadata_map.get(intents_id) {
            Some(m) => m,
            None => continue,
        };

        // Skip if chainName is missing (no valid chain metadata)
        if meta.chain_name.is_none() {
            continue;
        }

        let canonical_symbol = meta.symbol.to_uppercase();

        if !asset_map.contains_key(&canonical_symbol) {
            asset_map.insert(
                canonical_symbol.clone(),
                AssetOption {
                    id: canonical_symbol.to_lowercase(),
                    asset_name: meta.symbol.clone(),
                    name: meta.name.clone(),
                    symbol: meta.symbol.clone(),
                    icon: meta.icon.clone(),
                    networks: Vec::new(),
                },
            );
        }

        // Derive chain_id from defuse_asset_identifier
        let defuse_id = token
            .get("defuse_asset_identifier")
            .and_then(|d| d.as_str())
            .unwrap_or("");
        let parts: Vec<&str> = defuse_id.split(':').collect();
        let chain_id = if parts.len() >= 2 {
            format!("{}:{}", parts[0], parts[1])
        } else {
            parts.first().unwrap_or(&"").to_string()
        };

        // Get chain name from metadata
        let net_name = meta.chain_name.as_ref().unwrap_or(&String::new()).clone();

        // Select the appropriate icon based on theme
        let net_icon = meta.chain_icons.as_ref().map(|icons| {
            if query.theme == "dark" {
                icons.dark.clone()
            } else {
                icons.light.clone()
            }
        });

        let decimals = meta.decimals;

        if let Some(asset) = asset_map.get_mut(&canonical_symbol) {
            // Check if network with this chain_id already exists
            let network_exists = asset.networks.iter().any(|n| n.id == chain_id);
            if !network_exists {
                asset.networks.push(NetworkOption {
                    id: chain_id.clone(),
                    name: net_name,
                    icon: net_icon,
                    chain_id,
                    decimals,
                });
            }
        }
    }

    let mut assets: Vec<AssetOption> = asset_map.into_values().collect();

    // Sort assets by symbol alphabetically
    assets.sort_by(|a, b| a.symbol.cmp(&b.symbol));

    // Sort networks within each asset by name alphabetically
    for asset in &mut assets {
        asset.networks.sort_by(|a, b| a.name.cmp(&b.name));
    }

    let response = DepositAssetsResponse { assets };

    // Cache the response
    let response_value = serde_json::to_value(&response).map_err(|e| {
        eprintln!("Error serializing deposit assets: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Serialization error".to_string(),
        )
    })?;

    state.cache.insert(cache_key, response_value.clone()).await;

    Ok((StatusCode::OK, Json(response_value)))
}
