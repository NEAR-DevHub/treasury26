use std::{collections::HashMap, sync::Arc};

use axum::{
    Json,
    extract::{Query, State},
};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::{
    AppState,
    constants::intents_chains::{ChainIcons, get_chain_metadata_by_name},
    handlers::proposals::scraper::fetch_ft_metadata,
    handlers::proxy::external::fetch_proxy_api,
    utils::cache::{Cache, CacheKey, CacheTier},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenMetadataQuery {
    pub token_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TokenMetadata {
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
    pub network: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain_icons: Option<ChainIcons>,
}

/// This is the response from the Ref SDK API.
///
/// Sometimes it contains both camelCase and snake_case fields or only one of them.
/// We need to handle both cases. :)
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct RefSdkToken {
    pub defuse_asset_id: Option<String>,
    #[serde(rename = "defuse_asset_id")]
    pub defuse_asset_id_snake_case: Option<String>,
    pub name: Option<String>,
    pub symbol: Option<String>,
    pub decimals: Option<u8>,
    pub icon: Option<String>,
    pub price: Option<f64>,
    pub price_updated_at: Option<String>,
    #[serde(rename = "price_updated_at")]
    pub price_updated_at_snake_case: Option<String>,
    pub chain_name: Option<String>,
    pub chain_name_snake_case: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NearBlocksTokenResponse {
    tokens: Vec<NearBlocksToken>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct NearBlocksToken {
    contract: String,
    name: String,
    symbol: String,
    decimals: u8,
    icon: Option<String>,
    reference: Option<String>,
    price: Option<String>,
    total_supply: Option<String>,
    onchain_market_cap: Option<String>,
    change_24: Option<String>,
    market_cap: Option<String>,
    volume_24h: Option<String>,
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
    let mut sorted_ids = defuse_asset_ids.to_vec();
    sorted_ids.sort();
    let asset_ids_param = sorted_ids.join(",");

    // Prepare query parameters for the Ref SDK API
    let mut query_params = HashMap::new();
    query_params.insert("defuseAssetId".to_string(), asset_ids_param.clone());

    let cache_key = CacheKey::new("ref-tokens-metadata")
        .with(&asset_ids_param)
        .build();

    let state_clone = state.clone();
    let response = state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            // Fetch token data from Ref SDK API
            fetch_proxy_api(
                &state_clone.http_client,
                &state_clone.env_vars.ref_sdk_base_url,
                "token-by-defuse-asset-id",
                &query_params,
            )
            .await
        })
        .await?;

    // Parse as array of objects first
    let tokens: Vec<RefSdkToken> = serde_json::from_value(response).map_err(|e| {
        eprintln!("Failed to parse token response: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to parse token metadata response".to_string(),
        )
    })?;

    // Map RefSdkToken to TokenMetadata with chain metadata, using fallback for errors
    let mut metadata_responses: Vec<TokenMetadata> = Vec::new();

    for (idx, token) in tokens.iter().enumerate() {
        // Handle error entries with fallback
        if token.error.is_some() {
            eprintln!("Token has error, trying fallback: {:?}", token.error);

            // Get the original token ID from input to use for fallback
            if let Some(original_id) = defuse_asset_ids.get(idx) {
                // Extract the contract ID from defuse asset ID (format: "nep141:contract.near")
                let contract_id = original_id.split(':').nth(1).unwrap_or(original_id);

                if let Ok(account_id) = contract_id.parse::<near_api::AccountId>() {
                    match fetch_ft_metadata(&state.cache, &state.network, &account_id).await {
                        Ok(ft_metadata) => {
                            metadata_responses.push(TokenMetadata {
                                token_id: original_id.clone(),
                                name: ft_metadata.name,
                                symbol: ft_metadata.symbol,
                                decimals: ft_metadata.decimals,
                                icon: ft_metadata.icon,
                                price: None,
                                price_updated_at: None,
                                network: Some("near".to_string()),
                                chain_name: Some("Near Protocol".to_string()),
                                chain_icons: get_chain_metadata_by_name("near").map(|m| m.icon),
                            });
                            continue;
                        }
                        Err(e) => {
                            eprintln!(
                                "Fallback fetch_ft_metadata failed for {}: {:?}",
                                contract_id, e
                            );
                            continue;
                        }
                    }
                }
            }
            continue;
        }

        // Skip if missing required fields
        let Some(token_id) = token
            .defuse_asset_id
            .as_ref()
            .or(token.defuse_asset_id_snake_case.as_ref())
        else {
            continue;
        };
        let Some(name) = token.name.as_ref() else {
            continue;
        };
        let Some(symbol) = token.symbol.as_ref() else {
            continue;
        };
        let Some(decimals) = token.decimals else {
            continue;
        };
        let Some(chain_name_str) = token
            .chain_name
            .as_ref()
            .or(token.chain_name_snake_case.as_ref())
        else {
            continue;
        };

        let chain_metadata = get_chain_metadata_by_name(chain_name_str);
        let chain_name = chain_metadata.as_ref().map(|m| m.name.clone());
        let chain_icons = chain_metadata.map(|m| m.icon);

        metadata_responses.push(TokenMetadata {
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
        });
    }

    Ok(metadata_responses)
}

/// Fetches FT metadata from NearBlocks API
///
/// # Arguments
/// * `cache` - Application cache
/// * `http_client` - HTTP client for making requests
/// * `nearblocks_api_key` - API key for NearBlocks
/// * `token_id` - Token contract ID (e.g., "wrap.near", "usdt.tether-token.near")
///
/// # Returns
/// * `Ok(TokenMetadata)` - Token metadata with price information
/// * `Err((StatusCode, String))` - Error with status code and message
async fn fetch_nearblocks_ft_metadata(
    cache: &Cache,
    http_client: &reqwest::Client,
    nearblocks_api_key: &str,
    token_id: &str,
) -> Result<TokenMetadata, (StatusCode, String)> {
    let cache_key = CacheKey::new("nearblocks-ft-metadata")
        .with(token_id.to_string())
        .build();

    // Clone needed values for the async block
    let http_client = http_client.clone();
    let nearblocks_api_key = nearblocks_api_key.to_string();
    let token_id_str = token_id.to_string();

    let result = cache
        .cached_json(CacheTier::LongTerm, cache_key, async move {
            // For "near" token, search for wrap.near to get price
            let search_query = if token_id_str == "near" {
                "wrap.near"
            } else {
                &token_id_str
            };

            let url = format!("https://api.nearblocks.io/v1/fts/?search={}", search_query);

            let response = http_client
                .get(&url)
                .header("accept", "application/json")
                .header("Authorization", format!("Bearer {}", nearblocks_api_key))
                .send()
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Failed to fetch from NearBlocks: {}", e),
                    )
                })?;

            if !response.status().is_success() {
                return Err((
                    StatusCode::from_u16(response.status().as_u16())
                        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                    format!("NearBlocks API error: {}", response.status()),
                ));
            }

            let data: NearBlocksTokenResponse = response.json().await.map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to parse NearBlocks response: {}", e),
                )
            })?;

            let token = data.tokens.into_iter().next().ok_or((
                StatusCode::NOT_FOUND,
                "No token found in NearBlocks response".to_string(),
            ))?;

            let price = token.price.as_ref().and_then(|p| p.parse::<f64>().ok());

            // If searching for "near", return NEAR metadata with wrap.near's price
            let metadata = if token_id_str == "near" {
                TokenMetadata {
                    token_id: "near".to_string(),
                    name: "NEAR".to_string(),
                    symbol: "NEAR".to_string(),
                    decimals: 24,
                    icon: token.icon,
                    price,
                    price_updated_at: price.map(|_| chrono::Utc::now().to_rfc3339()),
                    network: Some("near".to_string()),
                    chain_name: Some("Near Protocol".to_string()),
                    chain_icons: get_chain_metadata_by_name("near").map(|m| m.icon),
                }
            } else {
                TokenMetadata {
                    token_id: token_id_str.clone(),
                    name: token.name,
                    symbol: token.symbol,
                    decimals: token.decimals,
                    icon: token.icon,
                    price,
                    price_updated_at: price.map(|_| chrono::Utc::now().to_rfc3339()),
                    network: Some("near".to_string()),
                    chain_name: Some("Near Protocol".to_string()),
                    chain_icons: get_chain_metadata_by_name("near").map(|m| m.icon),
                }
            };

            Ok(metadata)
        })
        .await;

    match result {
        Ok((_status, json)) => {
            // Deserialize from Json<Value> to TokenMetadata
            serde_json::from_value(json.0).map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to deserialize token metadata: {}", e),
                )
            })
        }
        Err((_cache_err, err_string)) => Err((StatusCode::INTERNAL_SERVER_ERROR, err_string)),
    }
}

/// Fetches token metadata with automatic fallback strategy
///
/// This function handles both defuse asset IDs (prefixed with "nep141:", "intents.near:")
/// and regular NEAR FT contract IDs. It uses multiple sources:
/// 1. Defuse API for tokens with prefixes
/// 2. NearBlocks API for regular FT contracts (includes price data)
/// 3. Generic fallback if both fail
///
/// # Arguments
/// * `state` - Application state
/// * `token_ids` - List of token IDs (can be mixed defuse IDs and FT contract IDs)
///
/// # Returns
/// * `HashMap<String, TokenMetadata>` - Map of token ID to metadata
pub async fn fetch_tokens_with_fallback(
    state: &Arc<AppState>,
    token_ids: &[String],
) -> HashMap<String, TokenMetadata> {
    if token_ids.is_empty() {
        return HashMap::new();
    }

    // Remove duplicates using HashSet
    let unique_tokens: std::collections::HashSet<String> = token_ids.iter().cloned().collect();

    // Separate tokens into two categories:
    // 1. Tokens with prefixes (intents.near:, nep141:) - fetch from Defuse API
    // 2. Regular token contract IDs - fetch from NearBlocks API
    let mut api_tokens = Vec::new();
    let mut direct_tokens = Vec::new();

    for token_id in &unique_tokens {
        if token_id == "near"
            || token_id.starts_with("intents.near:")
            || token_id.starts_with("nep141:")
        {
            api_tokens.push(token_id.clone());
        } else {
            direct_tokens.push(token_id.clone());
        }
    }

    let mut result = HashMap::new();

    // Fetch tokens with prefixes from Defuse API
    if !api_tokens.is_empty() {
        let transform_to_defuse = |token_id: &str| -> String {
            if token_id == "near" {
                "nep141:wrap.near".to_string()
            } else if let Some(stripped) = token_id.strip_prefix("intents.near:") {
                stripped.to_string()
            } else {
                format!("nep141:{}", token_id)
            }
        };

        let defuse_ids: Vec<String> = api_tokens
            .iter()
            .map(|id| transform_to_defuse(id))
            .collect();

        match fetch_tokens_metadata(state, &defuse_ids).await {
            Ok(metadata_from_api) => {
                let metadata_map: HashMap<String, TokenMetadata> = metadata_from_api
                    .into_iter()
                    .map(|meta| (meta.token_id.clone(), meta))
                    .collect();

                for token_id in &api_tokens {
                    let lookup_key = transform_to_defuse(token_id);
                    if let Some(meta) = metadata_map.get(&lookup_key) {
                        // Special case: If this is "near", we fetched wrap.near's metadata
                        if token_id == "near" {
                            result.insert(
                                token_id.clone(),
                                TokenMetadata {
                                    token_id: "near".to_string(),
                                    name: "NEAR".to_string(),
                                    symbol: "NEAR".to_string(),
                                    decimals: 24,
                                    icon: meta.icon.clone(),
                                    price: meta.price,
                                    price_updated_at: meta.price_updated_at.clone(),
                                    network: meta.network.clone(),
                                    chain_name: meta.chain_name.clone(),
                                    chain_icons: meta.chain_icons.clone(),
                                },
                            );
                        } else {
                            result.insert(token_id.clone(), meta.clone());
                        }
                    }
                }
            }
            Err(e) => {
                log::error!("Failed to fetch metadata from Defuse API: {:?}", e);
            }
        }
    }

    // Fetch regular FT contracts from NearBlocks API
    if !direct_tokens.is_empty() {
        if let Some(nearblocks_api_key) = state.env_vars.nearblocks_api_key.as_ref() {
            for token_id in &direct_tokens {
                match fetch_nearblocks_ft_metadata(
                    &state.cache,
                    &state.http_client,
                    nearblocks_api_key,
                    token_id,
                )
                .await
                {
                    Ok(metadata) => {
                        result.insert(token_id.clone(), metadata);
                    }
                    Err(e) => {
                        log::warn!(
                            "Failed to fetch metadata from NearBlocks for {}: {:?}, using fallback",
                            token_id,
                            e
                        );
                        // Use generic fallback
                        let symbol = token_id
                            .split('.')
                            .next()
                            .unwrap_or(token_id)
                            .to_uppercase();
                        result.insert(
                            token_id.clone(),
                            TokenMetadata {
                                token_id: token_id.to_string(),
                                name: symbol.clone(),
                                symbol,
                                decimals: 18,
                                icon: None,
                                price: None,
                                price_updated_at: None,
                                network: Some("near".to_string()),
                                chain_name: Some("Near Protocol".to_string()),
                                chain_icons: get_chain_metadata_by_name("near").map(|m| m.icon),
                            },
                        );
                    }
                }
            }
        } else {
            // No NearBlocks API key, use generic fallback for all direct tokens
            for token_id in &direct_tokens {
                let symbol = token_id
                    .split('.')
                    .next()
                    .unwrap_or(token_id)
                    .to_uppercase();
                result.insert(
                    token_id.clone(),
                    TokenMetadata {
                        token_id: token_id.to_string(),
                        name: symbol.clone(),
                        symbol,
                        decimals: 18,
                        icon: None,
                        price: None,
                        price_updated_at: None,
                        network: Some("near".to_string()),
                        chain_name: Some("Near Protocol".to_string()),
                        chain_icons: get_chain_metadata_by_name("near").map(|m| m.icon),
                    },
                );
            }
        }
    }

    // Final fallback: For any token that still doesn't have metadata, add generic fallback
    for token_id in &unique_tokens {
        if !result.contains_key(token_id) {
            let symbol = token_id
                .split('.')
                .next()
                .unwrap_or(token_id)
                .to_uppercase();
            result.insert(
                token_id.clone(),
                TokenMetadata {
                    token_id: token_id.to_string(),
                    name: symbol.clone(),
                    symbol,
                    decimals: 18,
                    icon: None,
                    price: None,
                    price_updated_at: None,
                    network: Some("near".to_string()),
                    chain_name: Some("Near Protocol".to_string()),
                    chain_icons: get_chain_metadata_by_name("near").map(|m| m.icon),
                },
            );
        }
    }

    result
}

pub async fn get_token_metadata(
    State(state): State<Arc<AppState>>,
    Query(mut params): Query<TokenMetadataQuery>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    let cache_key = format!("token-metadata:{}", params.token_id);
    let state_clone = state.clone();

    state
        .cache
        .cached_json(CacheTier::LongTerm, cache_key, async move {
            let is_near = params.token_id.to_lowercase() == "near" || params.token_id.is_empty();
            if is_near {
                params.token_id = "nep141:wrap.near".to_string();
            }

            // Fetch token metadata using the reusable function
            let tokens = fetch_tokens_metadata(&state_clone, &[params.token_id.clone()]).await?;

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

            Ok::<_, (StatusCode, String)>(metadata)
        })
        .await
}

/// NearBlocks FT search response
#[derive(Deserialize, Debug)]
struct NearBlocksSearchResponse {
    tokens: Vec<NearBlocksToken>,
}

/// Search for FT token contract addresses by symbol using NearBlocks API
/// Returns a list of token contract addresses sorted by:
/// 1. Exact symbol match first
/// 2. Then by onchain_market_cap (descending)
pub async fn search_token_by_symbol(
    state: &Arc<AppState>,
    symbol: &str,
) -> Result<Vec<String>, (StatusCode, String)> {
    let cache_key = format!("search-token-{}", symbol.to_lowercase());

    state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            let url = format!(
                "https://api.nearblocks.io/v1/fts/?search={}",
                if symbol.to_lowercase() == "near" {
                    "wrap.near"
                } else {
                    symbol
                }
            );

            let response = state
                .http_client
                .get(&url)
                .header(
                    "Authorization",
                    format!(
                        "Bearer {}",
                        std::env::var("NEARBLOCKS_API_KEY").unwrap_or_default()
                    ),
                )
                .send()
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Failed to search token: {}", e),
                    )
                })?;

            let search_response: NearBlocksSearchResponse = response.json().await.map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to parse search response: {}", e),
                )
            })?;

            // Sort tokens: exact match first, then by market cap
            let mut tokens = search_response.tokens;
            let symbol_upper = symbol.to_uppercase();

            tokens.sort_by(|a, b| {
                // First, prioritize exact symbol matches
                let a_exact = a.symbol.to_uppercase() == symbol_upper;
                let b_exact = b.symbol.to_uppercase() == symbol_upper;

                match (a_exact, b_exact) {
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    _ => {
                        // If both or neither are exact matches, sort by market cap
                        let a_cap = a
                            .onchain_market_cap
                            .as_ref()
                            .and_then(|s| s.parse::<f64>().ok())
                            .unwrap_or(0.0);
                        let b_cap = b
                            .onchain_market_cap
                            .as_ref()
                            .and_then(|s| s.parse::<f64>().ok())
                            .unwrap_or(0.0);
                        b_cap
                            .partial_cmp(&a_cap)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    }
                }
            });

            // Return all contract addresses
            let contract_addresses: Vec<String> =
                tokens.iter().map(|t| t.contract.clone()).collect();

            Ok::<_, (StatusCode, String)>(contract_addresses)
        })
        .await
}
