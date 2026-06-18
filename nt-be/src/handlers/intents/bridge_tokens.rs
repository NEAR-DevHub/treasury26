use crate::{
    constants::intents_tokens::{find_unified_asset_id, get_tokens_map},
    utils::cache::CacheTier,
};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

use super::supported_tokens::fetch_supported_tokens_data;
use crate::{
    AppState,
    constants::NEAR_DECIMALS,
    constants::intents_chains::{ChainIcons, get_chain_metadata_by_name},
    handlers::token::metadata::fetch_tokens_metadata_enriched,
};

const NEAR_MAINNET_NETWORK_ID: &str = "near:mainnet";
const BLOCKED_NETWORK_IDS: [&str; 1] = ["nep141:nbtc.bridge.near"];

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_public_near_deposit_source: Option<bool>,
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

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTokensQuery {
    #[serde(default)]
    pub include_near_network: bool,
}

pub async fn get_bridge_tokens(
    Query(query): Query<BridgeTokensQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<DepositAssetsResponse>, (StatusCode, String)> {
    let include_near_network = query.include_near_network;
    let cache_key = format!("deposit-assets:include-near:{}", include_near_network);
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
            let metadata_map =
                fetch_tokens_metadata_enriched(&state_clone, &metadata_ids, false).await;

            // Step 5: Group by unified_asset_id
            let mut asset_map: HashMap<String, AssetOption> = HashMap::new();

            for token in tokens {
                let Some(intents_id) = token.get("intents_token_id").and_then(|id| id.as_str())
                else {
                    continue;
                };

                if BLOCKED_NETWORK_IDS.contains(&intents_id) {
                    continue;
                }

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
                        supports_public_near_deposit_source: None,
                    });
                }
            }

            let mut assets: Vec<AssetOption> = asset_map.into_values().collect();

            if include_near_network {
                let near_chain_icons = get_chain_metadata_by_name("near")
                    .map(|metadata| metadata.icon)
                    .or_else(|| {
                        Some(ChainIcons {
                            icon: "https://near.com/static/icons/network/near.svg".to_string(),
                        })
                    });
                // Normalize each asset to at most one canonical NEAR network entry:
                // - if a "near" network already exists, preserve its token id/decimals
                // - otherwise, synthesize a NEAR entry for assets that have networks
                //   (using near:mainnet id as fallback token id)
                // - skip assets that have no networks at all
                for asset in &mut assets {
                    let existing_near_network = asset
                        .networks
                        .iter()
                        .find(|network| network.name.eq_ignore_ascii_case("near"));

                    let (canonical_near_token_id, selection_source) =
                        if let Some(network) = existing_near_network {
                            (Some(network.id.clone()), "has_near_network")
                        } else if !asset.networks.is_empty() {
                            (Some(NEAR_MAINNET_NETWORK_ID.to_string()), "no_near_network")
                        } else {
                            (None, "no_networks_skip")
                        };
                    let canonical_near_decimals =
                        existing_near_network.map_or(NEAR_DECIMALS, |network| network.decimals);
                    let Some(canonical_near_token_id) = canonical_near_token_id else {
                        continue;
                    };

                    asset.networks.retain(|network| {
                        !network.name.eq_ignore_ascii_case("near")
                            && network.id != NEAR_MAINNET_NETWORK_ID
                            && network.chain_id != NEAR_MAINNET_NETWORK_ID
                    });

                    asset.networks.push(NetworkOption {
                        id: canonical_near_token_id,
                        name: "near".to_string(),
                        symbol: asset.asset_name.clone(),
                        chain_icons: near_chain_icons.clone(),
                        chain_id: NEAR_MAINNET_NETWORK_ID.to_string(),
                        decimals: canonical_near_decimals,
                        min_deposit_amount: None,
                        min_withdrawal_amount: None,
                        supports_public_near_deposit_source: Some(
                            selection_source == "has_near_network",
                        ),
                    });
                }
            }

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
