use crate::{
    constants::intents_tokens::{find_unified_asset_id, get_tokens_map},
    utils::cache::CacheTier,
};
use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

use super::supported_tokens::fetch_supported_tokens_data;
use crate::{
    AppState, constants::intents_chains::ChainIcons,
    handlers::token::metadata::fetch_tokens_metadata_enriched,
};

fn metadata_lookup_key(intents_id: &str) -> String {
    format!("intents.near:{intents_id}")
}

fn chain_id_from_defuse_id(defuse_id: &str) -> String {
    let parts: Vec<&str> = defuse_id.split(':').collect();
    if parts.len() >= 2 {
        format!("{}:{}", parts[0], parts[1])
    } else {
        parts.first().unwrap_or(&"").to_string()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NetworkOption {
    pub id: String, // This will be the intents_token_id
    pub name: String,
    pub symbol: String,
    pub chain_icons: Option<ChainIcons>,
    pub chain_id: String, // This will be like "eth:1"
    pub decimals: u8,
    pub min_deposit_amount: Option<String>,
    pub min_withdrawal_amount: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AssetOption {
    pub id: String,
    pub asset_name: String,
    pub name: String,
    pub icon: Option<String>,
    pub networks: Vec<NetworkOption>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DepositAssetsResponse {
    pub assets: Vec<AssetOption>,
}

pub async fn get_bridge_tokens(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DepositAssetsResponse>, (StatusCode, String)> {
    let cache_key = "deposit-assets".to_string();
    let state_clone = state.clone();

    let result = state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            // Step 1: Fetch supported tokens using existing helper
            let supported = fetch_supported_tokens_data(&state_clone).await?;

            // Step 2: Filter for nep141 and nep245 tokens
            let all_tokens = supported.get("tokens").and_then(|t| t.as_array()).ok_or((
                StatusCode::INTERNAL_SERVER_ERROR,
                "Invalid format".to_string(),
            ))?;

            let supported_tokens: Vec<&Value> = all_tokens
                .iter()
                .filter(|t| {
                    t.get("standard")
                        .and_then(|s| s.as_str())
                        .map(|s| s == "nep141" || s == "nep245")
                        .unwrap_or(false)
                })
                .collect();

            // Step 3: Deduplicate by intents_token_id
            let mut token_map: HashMap<String, &Value> = HashMap::new();
            for token in supported_tokens {
                if let Some(intents_id) = token.get("intents_token_id").and_then(|id| id.as_str()) {
                    token_map.entry(intents_id.to_string()).or_insert(token);
                }
            }

            let tokens: Vec<&Value> = token_map.values().copied().collect();
            // Keep lookup keys aligned with caller expectations across all consumers.
            let metadata_ids: Vec<String> = tokens
                .iter()
                .filter_map(|t| {
                    t.get("intents_token_id")
                        .and_then(|id| id.as_str())
                        .map(metadata_lookup_key)
                })
                .collect();

            // Step 4: Batch fetch token metadata using the unified metadata function
            let metadata_map = fetch_tokens_metadata_enriched(&state_clone, &metadata_ids).await;

            // Step 5: Group by unified_asset_id
            let mut asset_map: HashMap<String, AssetOption> = HashMap::new();

            for token in tokens {
                let Some(intents_id) = token.get("intents_token_id").and_then(|id| id.as_str())
                else {
                    continue;
                };

                let lookup_key = metadata_lookup_key(intents_id);
                let Some(meta) = metadata_map.get(&lookup_key) else {
                    continue;
                };

                // Skip if chainName is missing (no valid chain metadata)
                if meta.network.is_none() {
                    continue;
                }

                // Derive chain_id from defuse_asset_identifier
                let defuse_id = token
                    .get("defuse_asset_identifier")
                    .and_then(|d| d.as_str())
                    .unwrap_or("");
                let chain_id = chain_id_from_defuse_id(defuse_id);

                // Resolve unified_asset_id from tokens.json for proper grouping
                let group_key = find_unified_asset_id(intents_id)
                    .map(String::from)
                    .unwrap_or_else(|| meta.symbol.to_lowercase());

                // Use chain name from metadata directly.
                let resolved_network_name =
                    meta.network.as_ref().or(meta.chain_name.as_ref()).cloned();

                // Extract min deposit and withdrawal amounts
                let min_deposit_amount = token
                    .get("min_deposit_amount")
                    .and_then(|v| v.as_str())
                    .map(String::from);

                let min_withdrawal_amount = token
                    .get("min_withdrawal_amount")
                    .and_then(|v| v.as_str())
                    .map(String::from);

                // Prefer tokens.json for asset-level name/icon/symbol when available.
                let unified = get_tokens_map().get(&group_key);
                let asset = asset_map
                    .entry(group_key.clone())
                    .or_insert_with(|| AssetOption {
                        id: group_key.clone(),
                        asset_name: unified
                            .map(|u| u.symbol.clone())
                            .unwrap_or_else(|| meta.symbol.clone()),
                        name: unified
                            .map(|u| u.name.clone())
                            .unwrap_or_else(|| meta.name.clone()),
                        icon: unified
                            .map(|u| Some(u.icon.clone()))
                            .unwrap_or_else(|| meta.icon.clone()),
                        networks: Vec::new(),
                    });

                // Check if network with this intents_token_id already exists
                if !asset.networks.iter().any(|n| n.id == intents_id) {
                    asset.networks.push(NetworkOption {
                        symbol: meta.symbol.clone(),
                        name: resolved_network_name.unwrap_or_default(),
                        id: intents_id.to_string(),
                        chain_icons: meta.chain_icons.clone(),
                        chain_id,
                        decimals: meta.decimals,
                        min_deposit_amount,
                        min_withdrawal_amount,
                    });
                }
            }

            let mut assets: Vec<AssetOption> = asset_map.into_values().collect();

            // Sort assets by symbol alphabetically
            assets.sort_by(|a, b| a.id.cmp(&b.id));

            // Sort networks within each asset by name alphabetically
            for asset in &mut assets {
                asset.networks.sort_by(|a, b| a.name.cmp(&b.name));
            }

            Ok::<_, (StatusCode, String)>(DepositAssetsResponse { assets })
        })
        .await?;

    Ok(Json(result))
}
