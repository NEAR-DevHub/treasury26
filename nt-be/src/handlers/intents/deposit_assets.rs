use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::metadata::{fetch_blockchain_metadata_data, fetch_token_metadata_data};
use super::supported_tokens::fetch_supported_tokens_data;
use crate::AppState;

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

/// Helper to handle API responses that may be wrapped in arrays
#[inline]
fn unwrap_array_value(value: &Value) -> &Value {
    if value.is_array() {
        value.get(0).unwrap_or(value)
    } else {
        value
    }
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

    // Step 4: Batch fetch token metadata using helper
    let defuse_ids_param = defuse_ids.join(",");
    let metadata_response = fetch_token_metadata_data(&state, &defuse_ids_param).await?;

    // Build metadata map
    let mut metadata_map: HashMap<String, Value> = HashMap::new();

    // Handle both array and object responses
    if let Some(arr) = metadata_response.as_array() {
        // Response is an array of metadata objects
        for item in arr {
            let metadata_obj = unwrap_array_value(item);
            // Try different possible key names for the token ID
            if let Some(token_id) = metadata_obj
                .get("defuseAssetId")
                .or_else(|| metadata_obj.get("defuse_asset_id"))
                .or_else(|| metadata_obj.get("defuseAssetID"))
                .and_then(|id| id.as_str())
            {
                metadata_map.insert(token_id.to_string(), item.clone());
            }
        }
    } else if let Some(obj) = metadata_response.as_object() {
        // Response is an object with token IDs as keys
        for (key, value) in obj {
            metadata_map.insert(key.to_string(), value.clone());
        }
    }

    // Step 5: Enrich tokens with metadata
    let enriched_tokens: Vec<Value> = tokens
        .iter()
        .filter_map(|token| {
            let token_id = token.get("intents_token_id")?.as_str()?;
            let metadata_value = metadata_map.get(token_id)?;
            let metadata = unwrap_array_value(metadata_value);

            // Check if chainName exists
            if metadata.get("chainName")?.as_str().is_some() {
                let mut enriched = (*token).clone();
                if let Some(enriched_obj) = enriched.as_object_mut()
                    && let Some(metadata_obj) = metadata.as_object()
                {
                    for (k, v) in metadata_obj {
                        enriched_obj.insert(k.clone(), v.clone());
                    }
                }
                Some(enriched)
            } else {
                None
            }
        })
        .collect();

    // Create enriched token map for O(1) lookup
    let enriched_token_map: HashMap<String, &Value> = enriched_tokens
        .iter()
        .filter_map(|t| {
            let id = t.get("intents_token_id")?.as_str()?;
            Some((id.to_string(), t))
        })
        .collect();

    // Step 6: Fetch network icons using helper
    let unique_chain_names: HashSet<String> = enriched_tokens
        .iter()
        .filter_map(|token| token.get("chainName")?.as_str().map(String::from))
        .collect();

    let network_names_param = unique_chain_names.into_iter().collect::<Vec<_>>().join(",");

    let mut network_icon_map: HashMap<String, (String, Option<String>)> = HashMap::new();

    if !network_names_param.is_empty()
        && let Ok(network_data) =
            fetch_blockchain_metadata_data(&state, &network_names_param, &query.theme).await
        && let Some(networks) = network_data.as_array()
    {
        for network_value in networks {
            let network = unwrap_array_value(network_value);

            if let Some(network_key) = network.get("network").and_then(|n| n.as_str()) {
                let name = network
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or(network_key)
                    .to_string();
                let icon = network
                    .get("icon")
                    .and_then(|i| i.as_str())
                    .map(String::from);
                network_icon_map.insert(network_key.to_string(), (name, icon));
            }
        }
    }

    // Step 7: Group by canonical symbol
    let mut asset_map: HashMap<String, AssetOption> = HashMap::new();

    for token in tokens {
        let intents_id = match token.get("intents_token_id").and_then(|id| id.as_str()) {
            Some(id) => id,
            None => continue,
        };

        let metadata_value = match metadata_map.get(intents_id) {
            Some(m) => m,
            None => continue,
        };

        let meta = unwrap_array_value(metadata_value);

        let symbol = meta
            .get("symbol")
            .and_then(|s| s.as_str())
            .or_else(|| token.get("asset_name").and_then(|a| a.as_str()))
            .unwrap_or("UNKNOWN");

        let canonical_symbol = symbol.to_uppercase();

        if !asset_map.contains_key(&canonical_symbol) {
            let name = meta
                .get("name")
                .and_then(|n| n.as_str())
                .or_else(|| token.get("name").and_then(|n| n.as_str()))
                .unwrap_or(symbol)
                .to_string();

            let icon = meta.get("icon").and_then(|i| i.as_str()).map(String::from);

            asset_map.insert(
                canonical_symbol.clone(),
                AssetOption {
                    id: canonical_symbol.to_lowercase(),
                    asset_name: symbol.to_string(),
                    name,
                    symbol: symbol.to_string(),
                    icon,
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

        // Get chainName from enriched token
        let enriched = enriched_token_map.get(intents_id);
        let chain_name = enriched
            .and_then(|t| t.get("chainName"))
            .and_then(|c| c.as_str())
            .unwrap_or("");

        let (net_name, net_icon) = network_icon_map
            .get(chain_name)
            .cloned()
            .unwrap_or_else(|| (chain_name.to_string(), None));

        let decimals = meta.get("decimals").and_then(|d| d.as_u64()).unwrap_or(18) as u8;

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
