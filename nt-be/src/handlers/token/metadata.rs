use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use axum::{
    Json,
    extract::{Query, State},
};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::{
    AppState,
    constants::{
        NEAR_ICON, WRAP_NEAR_ICON,
        intents_chains::{ChainIcons, get_chain_metadata_by_name},
        intents_tokens::{
            find_token_by_defuse_asset_id, find_token_by_defuse_asset_id_and_address,
        },
    },
    utils::cache::{Cache, CacheKey, CacheTier},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenMetadataQuery {
    #[serde(alias = "token_id")]
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

impl TokenMetadata {
    /// Creates NEAR token metadata with consistent values across the codebase.
    ///
    /// # Arguments
    /// * `price` - Optional USD price for NEAR
    /// * `price_updated_at` - Optional timestamp when price was updated
    ///
    /// # Returns
    /// TokenMetadata with standardized NEAR token information
    pub fn create_near_metadata(price: Option<f64>, price_updated_at: Option<String>) -> Self {
        Self {
            token_id: "near".to_string(),
            name: "NEAR".to_string(),
            symbol: "NEAR".to_string(),
            decimals: 24,
            icon: Some(NEAR_ICON.to_string()),
            price,
            price_updated_at,
            network: Some("near".to_string()),
            chain_name: Some("Near Protocol".to_string()),
            chain_icons: get_chain_metadata_by_name("near").map(|m| m.icon),
        }
    }

    /// Creates wrap.near (Wrapped NEAR) token metadata with consistent values.
    ///
    /// # Arguments
    /// * `price` - Optional USD price for wrap.near (typically same as NEAR)
    /// * `price_updated_at` - Optional timestamp when price was updated
    ///
    /// # Returns
    /// TokenMetadata with standardized wrap.near token information
    pub fn create_wrap_near_metadata(price: Option<f64>, price_updated_at: Option<String>) -> Self {
        Self {
            token_id: "wrap.near".to_string(),
            name: "NEAR".to_string(),
            symbol: "NEAR".to_string(),
            decimals: 24,
            icon: Some(WRAP_NEAR_ICON.to_string()),
            price,
            price_updated_at,
            network: Some("near".to_string()),
            chain_name: Some("Near Protocol".to_string()),
            chain_icons: get_chain_metadata_by_name("near").map(|m| m.icon),
        }
    }

    /// Forces canonical branding for NEAR and wrap.near, regardless of source metadata.
    pub fn apply_near_symbol_name_override(&mut self) {
        if is_near_or_wrap_token_id(&self.token_id) {
            self.name = "NEAR".to_string();
            self.symbol = "NEAR".to_string();
        }
    }
}

const CHAINDEFUSER_TOKENS_URL: &str = "https://api-mng-console.chaindefuser.com/api/tokens";

#[derive(Debug, Deserialize, Serialize, Clone)]
struct ChaindefuserTokensResponse {
    items: Vec<ChaindefuserToken>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct ChaindefuserToken {
    defuse_asset_id: String,
    decimals: u8,
    blockchain: String,
    symbol: String,
    #[serde(default)]
    price: Option<f64>,
    #[serde(default)]
    price_updated_at: Option<String>,
    #[serde(default)]
    contract_address: Option<String>,
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

async fn fetch_chaindefuser_tokens(
    state: &Arc<AppState>,
) -> Result<ChaindefuserTokensResponse, (StatusCode, String)> {
    let cache_key = "chaindefuser:tokens".to_string();
    let state_clone = state.clone();
    state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            let response = state_clone
                .http_client
                .get(CHAINDEFUSER_TOKENS_URL)
                .header("accept", "application/json")
                .send()
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Failed to fetch Chaindefuser tokens: {e}"),
                    )
                })?;
            if !response.status().is_success() {
                return Err((
                    StatusCode::BAD_GATEWAY,
                    format!("Chaindefuser tokens API error: {}", response.status()),
                ));
            }
            response
                .json::<ChaindefuserTokensResponse>()
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Failed to parse Chaindefuser tokens response: {e}"),
                    )
                })
        })
        .await
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
            let metadata = if token_id_str == "near" || token_id_str == "wrap.near" {
                TokenMetadata::create_near_metadata(
                    price,
                    price.map(|_| chrono::Utc::now().to_rfc3339()),
                )
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

/// Fetch token metadata from counterparties table (cached in database)
///
/// This is the fast path for fetching metadata - it queries the local database
/// instead of making external API calls. Returns only metadata for tokens
/// that exist in the counterparties table.
///
/// Special handling: "near" → looks up "wrap.near" but returns token_id="near"
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `token_ids` - List of token IDs to fetch
///
/// # Returns
/// * `HashMap<String, TokenMetadata>` - Map of found tokens (may be incomplete)
pub async fn fetch_metadata_from_counterparties(
    pool: &PgPool,
    token_ids: &[String],
) -> HashMap<String, TokenMetadata> {
    if token_ids.is_empty() {
        return HashMap::new();
    }

    // Create mapping: original_token_id -> db_lookup_id
    // For "near", we need to look up "wrap.near" in the database
    let mut token_id_mapping: HashMap<String, String> = HashMap::new();
    let mut db_lookup_ids: Vec<String> = Vec::new();

    for token_id in token_ids {
        let lookup_id = if token_id == "near" {
            "wrap.near".to_string()
        } else {
            token_id.clone()
        };
        token_id_mapping.insert(lookup_id.clone(), token_id.clone());
        db_lookup_ids.push(lookup_id);
    }

    let rows = match sqlx::query!(
        r#"
        SELECT 
            account_id,
            token_symbol,
            token_name,
            token_decimals,
            token_icon
        FROM counterparties
        WHERE account_id = ANY($1)
          AND account_type = 'ft_token'
          AND token_symbol IS NOT NULL
        "#,
        &db_lookup_ids
    )
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            log::warn!("Failed to fetch metadata from counterparties: {}", e);
            return HashMap::new();
        }
    };

    rows.into_iter()
        .filter_map(|row| {
            let db_token_id = row.account_id;

            // Map back: wrap.near → near (if that's what was requested)
            let original_token_id = token_id_mapping
                .get(&db_token_id)
                .cloned()
                .unwrap_or_else(|| db_token_id.clone());

            let symbol = row.token_symbol?;
            let name = row.token_name.unwrap_or_else(|| symbol.clone());
            let decimals = row.token_decimals.map(|d| d as u8).unwrap_or(24);

            // Special case: Override metadata for native NEAR
            if original_token_id == "near" {
                return Some((
                    original_token_id.clone(),
                    TokenMetadata::create_near_metadata(None, None),
                ));
            }

            Some((
                original_token_id.clone(),
                TokenMetadata {
                    token_id: original_token_id, // Use the original requested ID (e.g., "near" not "wrap.near")
                    name,
                    symbol,
                    decimals,
                    icon: row.token_icon,
                    price: None, // Prices fetched separately
                    price_updated_at: None,
                    network: None,
                    chain_name: None,
                    chain_icons: None,
                },
            ))
        })
        .collect()
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !value.is_empty() && !values.iter().any(|v| v == &value) {
        values.push(value);
    }
}

fn is_near_or_wrap_token_id(token_id: &str) -> bool {
    let raw = token_id.trim();
    let stripped = raw.strip_prefix("intents.near:").unwrap_or(raw);
    let normalized = stripped.strip_prefix("nep141:").unwrap_or(stripped);
    normalized.eq_ignore_ascii_case("near") || normalized.eq_ignore_ascii_case("wrap.near")
}

#[derive(Clone, Default)]
struct MetadataLookupCandidates {
    /// Full normalized candidate list derived from the caller input.
    /// Used by generic checks (e.g. NearBlocks fallback candidate selection).
    all: Vec<String>,
    /// Defuse-style identifiers (`nep141:*` / `nep245:*`).
    /// Used for tokens.json and chaindefuser defuse-id matching.
    defuse: Vec<String>,
    /// Contract/account identifiers without defuse prefixes where applicable.
    /// Used for counterparties lookups and contract-address matching paths.
    contract: Vec<String>,
}

fn build_metadata_lookup_candidates(token_id: &str) -> MetadataLookupCandidates {
    let mut all = Vec::new();
    let raw = token_id.trim();
    if raw.is_empty() {
        return MetadataLookupCandidates::default();
    }
    push_unique(&mut all, raw.to_string());
    let stripped = raw.strip_prefix("intents.near:").unwrap_or(raw);
    push_unique(&mut all, stripped.to_string());

    if stripped.eq_ignore_ascii_case("near") {
        push_unique(&mut all, "near".to_string());
        push_unique(&mut all, "wrap.near".to_string());
        push_unique(&mut all, "nep141:wrap.near".to_string());
    } else if stripped.eq_ignore_ascii_case("wrap.near") {
        push_unique(&mut all, "wrap.near".to_string());
        push_unique(&mut all, "nep141:wrap.near".to_string());
    } else if stripped.starts_with("nep141:") || stripped.starts_with("nep245:") {
        push_unique(&mut all, stripped.to_string());
    } else {
        push_unique(&mut all, format!("nep141:{stripped}"));
    }

    let mut defuse = Vec::new();
    let mut contract = Vec::new();
    for candidate in &all {
        if candidate.starts_with("nep141:") || candidate.starts_with("nep245:") {
            push_unique(&mut defuse, candidate.clone());
        }
        if let Some(rest) = candidate.strip_prefix("nep141:") {
            push_unique(&mut contract, rest.to_string());
        } else if !candidate.starts_with("nep245:") && !candidate.starts_with("intents.near:") {
            push_unique(&mut contract, candidate.clone());
        }
    }

    MetadataLookupCandidates {
        all,
        defuse,
        contract,
    }
}

pub fn metadata_lookup_candidates(token_id: &str) -> Vec<String> {
    build_metadata_lookup_candidates(token_id).all
}

fn tokens_json_metadata_for_defuse(
    defuse_id: &str,
    address_candidates: &[String],
    output_token_id: &str,
) -> Option<TokenMetadata> {
    let token = find_token_by_defuse_asset_id_and_address(defuse_id, address_candidates)
        .or_else(|| find_token_by_defuse_asset_id(defuse_id))?;
    let deployment_chain_name = {
        let mut matched: Option<String> = None;
        for deployment in &token.deployments {
            if let crate::constants::intents_tokens::TokenDeployment::Fungible {
                address,
                chain_name,
                ..
            } = deployment
                && address_candidates
                    .iter()
                    .any(|candidate| candidate.eq_ignore_ascii_case(address))
            {
                matched = Some(chain_name.clone());
                break;
            }
        }
        if matched.is_none() && token.deployments.len() == 1 {
            match &token.deployments[0] {
                crate::constants::intents_tokens::TokenDeployment::Fungible {
                    chain_name, ..
                }
                | crate::constants::intents_tokens::TokenDeployment::Native {
                    chain_name, ..
                } => matched = Some(chain_name.clone()),
            }
        }
        matched
    };
    let selected_chain = deployment_chain_name.unwrap_or_else(|| token.origin_chain_name.clone());
    let chain_metadata = get_chain_metadata_by_name(&selected_chain);
    Some(TokenMetadata {
        token_id: output_token_id.to_string(),
        name: token.name.clone(),
        symbol: token.symbol.clone(),
        decimals: token.decimals,
        icon: Some(token.icon.clone()),
        price: None,
        price_updated_at: None,
        network: Some(selected_chain),
        chain_name: chain_metadata.as_ref().map(|m| m.name.clone()),
        chain_icons: chain_metadata.map(|m| m.icon),
    })
}

fn chaindefuser_item_to_metadata(item: &ChaindefuserToken, output_token_id: &str) -> TokenMetadata {
    let static_token = find_token_by_defuse_asset_id(&item.defuse_asset_id);
    let chain_metadata = get_chain_metadata_by_name(&item.blockchain);
    TokenMetadata {
        token_id: output_token_id.to_string(),
        name: static_token
            .map(|t| t.name.clone())
            .unwrap_or_else(|| item.symbol.clone()),
        symbol: item.symbol.clone(),
        decimals: item.decimals,
        icon: static_token.map(|t| t.icon.clone()),
        price: item.price,
        price_updated_at: item.price_updated_at.clone(),
        network: Some(item.blockchain.clone()),
        chain_name: chain_metadata
            .as_ref()
            .map(|m| m.name.clone())
            .or(Some(item.blockchain.clone())),
        chain_icons: chain_metadata.map(|m| m.icon),
    }
}

fn merge_missing_fields(into: &mut TokenMetadata, from: &TokenMetadata) {
    if into.icon.is_none() {
        into.icon = from.icon.clone();
    }
    if into.price.is_none() {
        into.price = from.price;
        into.price_updated_at = from.price_updated_at.clone();
    }
    if into.network.is_none() {
        into.network = from.network.clone();
    }
    if into.chain_name.is_none() {
        into.chain_name = from.chain_name.clone();
    }
    if into.chain_icons.is_none() {
        into.chain_icons = from.chain_icons.clone();
    }
}

fn nearblocks_lookup_candidate(candidates: &[String]) -> Option<String> {
    candidates.iter().find_map(|candidate| {
        let without_intents = candidate.strip_prefix("intents.near:").unwrap_or(candidate);
        let normalized = without_intents
            .strip_prefix("nep141:")
            .unwrap_or(without_intents);

        if normalized.starts_with("nep245:") {
            return None;
        }
        if normalized.eq_ignore_ascii_case("near")
            || normalized.eq_ignore_ascii_case("wrap.near")
            || normalized.ends_with(".near")
        {
            return Some(normalized.to_string());
        }
        None
    })
}

pub async fn fetch_tokens_metadata(
    state: &Arc<AppState>,
    token_ids: &[String],
) -> Result<Vec<TokenMetadata>, (StatusCode, String)> {
    let map = fetch_tokens_with_fallback(state, token_ids, true).await;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for token_id in token_ids {
        if seen.insert(token_id)
            && let Some(meta) = map.get(token_id)
        {
            out.push(meta.clone());
        }
    }
    Ok(out)
}

/// Fetches token metadata with strict source priority:
/// counterparties -> near/wrap.near canonical -> tokens.json -> Chaindefuser /api/tokens.
///
/// When `include_chain_metadata` is false, NearBlocks may be used as a final
/// asset-metadata fallback (no reliable cross-chain network derivation).
pub async fn fetch_tokens_with_fallback(
    state: &Arc<AppState>,
    token_ids: &[String],
    include_chain_metadata: bool,
) -> HashMap<String, TokenMetadata> {
    if token_ids.is_empty() {
        return HashMap::new();
    }

    let unique_tokens: Vec<String> = token_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    let mut lookup_candidates: HashMap<String, MetadataLookupCandidates> = HashMap::new();
    let mut counterparties_lookup_ids: Vec<String> = Vec::new();
    for token_id in &unique_tokens {
        let candidates = build_metadata_lookup_candidates(token_id);
        for c in &candidates.all {
            push_unique(&mut counterparties_lookup_ids, c.clone());
        }
        lookup_candidates.insert(token_id.clone(), candidates);
    }

    let counterparties_map =
        fetch_metadata_from_counterparties(&state.db_pool, &counterparties_lookup_ids).await;

    let mut chaindefuser_by_defuse: HashMap<String, ChaindefuserToken> = HashMap::new();
    let mut chaindefuser_by_contract: HashMap<String, ChaindefuserToken> = HashMap::new();
    if include_chain_metadata {
        let chaindefuser_response = match fetch_chaindefuser_tokens(state).await {
            Ok(response) => Some(response),
            Err((status, err)) => {
                log::warn!(
                    "chaindefuser token metadata fetch failed: status={}, error={}",
                    status,
                    err
                );
                None
            }
        };
        if let Some(response) = chaindefuser_response {
            for item in response.items {
                chaindefuser_by_defuse.insert(item.defuse_asset_id.to_lowercase(), item.clone());
                if let Some(contract_address) = item.contract_address.clone() {
                    chaindefuser_by_contract.insert(contract_address.to_lowercase(), item);
                }
            }
        }
    }

    let mut result: HashMap<String, TokenMetadata> = HashMap::new();
    let mut unresolved_tokens: Vec<String> = Vec::new();

    for token_id in unique_tokens {
        let candidates = lookup_candidates
            .get(&token_id)
            .cloned()
            .unwrap_or_default();
        let contract_candidates = candidates.contract.clone();
        let all_candidates = candidates.all.clone();
        let mut metadata: Option<TokenMetadata> = None;

        // 1) counterparties
        if metadata.is_none() {
            for candidate in &all_candidates {
                if let Some(cp_meta) = counterparties_map.get(candidate) {
                    let mut resolved = cp_meta.clone();
                    resolved.token_id = token_id.clone();
                    metadata = Some(resolved);
                    break;
                }
            }
        }

        // 2) canonical near/wrap.near
        if metadata.is_none() {
            let stripped = token_id.strip_prefix("intents.near:").unwrap_or(&token_id);
            if stripped.eq_ignore_ascii_case("near") {
                let mut meta = TokenMetadata::create_near_metadata(None, None);
                meta.token_id = token_id.clone();
                metadata = Some(meta);
            } else if stripped.eq_ignore_ascii_case("wrap.near") || stripped == "nep141:wrap.near" {
                let mut meta = TokenMetadata::create_wrap_near_metadata(None, None);
                meta.token_id = token_id.clone();
                metadata = Some(meta);
            }
        }

        // 3) tokens.json
        if metadata.is_none() {
            for defuse_id in &candidates.defuse {
                if let Some(meta) =
                    tokens_json_metadata_for_defuse(defuse_id, &contract_candidates, &token_id)
                {
                    metadata = Some(meta);
                    break;
                }
            }
        }

        // 4) chaindefuser /api/tokens (only when chain metadata is requested)
        if include_chain_metadata {
            let mut chaindefuser_match: Option<ChaindefuserToken> = None;
            for defuse_id in &candidates.defuse {
                if let Some(item) = chaindefuser_by_defuse.get(&defuse_id.to_lowercase()) {
                    chaindefuser_match = Some(item.clone());
                    break;
                }
            }
            if chaindefuser_match.is_none() {
                for contract_candidate in &contract_candidates {
                    if let Some(item) =
                        chaindefuser_by_contract.get(&contract_candidate.to_lowercase())
                    {
                        chaindefuser_match = Some(item.clone());
                        break;
                    }
                }
            }
            if let Some(item) = chaindefuser_match {
                let api_meta = chaindefuser_item_to_metadata(&item, &token_id);
                if let Some(existing) = metadata.as_mut() {
                    merge_missing_fields(existing, &api_meta);
                } else {
                    metadata = Some(api_meta);
                }
            }
        }

        // 5) NearBlocks (asset metadata only; skip when chain metadata is required)
        if metadata.is_none()
            && !include_chain_metadata
            && let Some(nearblocks_api_key) = state.env_vars.nearblocks_api_key.as_ref()
            && let Some(nearblocks_candidate) = nearblocks_lookup_candidate(&candidates.all)
        {
            match fetch_nearblocks_ft_metadata(
                &state.cache,
                &state.http_client,
                nearblocks_api_key,
                &nearblocks_candidate,
            )
            .await
            {
                Ok(mut near_meta) => {
                    near_meta.token_id = token_id.clone();
                    metadata = Some(near_meta);
                }
                Err((status, err)) => {
                    log::warn!(
                        "nearblocks token metadata fetch failed: token_id={}, candidate={}, status={}, error={}",
                        token_id,
                        nearblocks_candidate,
                        status,
                        err
                    );
                }
            }
        }

        if let Some(mut meta) = metadata {
            meta.apply_near_symbol_name_override();
            result.insert(token_id, meta);
        } else {
            unresolved_tokens.push(token_id);
        }
    }

    if !unresolved_tokens.is_empty() {
        let sample = unresolved_tokens
            .iter()
            .take(10)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        log::warn!(
            "token metadata unresolved: count={}, sample=[{}]",
            unresolved_tokens.len(),
            sample
        );
    }

    result
}

pub async fn fetch_tokens_metadata_enriched(
    state: &Arc<AppState>,
    token_ids: &[String],
) -> HashMap<String, TokenMetadata> {
    // Extension users expect full enrichment including chain metadata.
    let mut result = fetch_tokens_with_fallback(state, token_ids, true).await;
    if result.is_empty() {
        return result;
    }

    let requested_ids: Vec<String> = result.keys().cloned().collect();
    let db_prices = state
        .price_service
        .get_cached_tokens_latest_price(&requested_ids)
        .await
        .unwrap_or_default();

    for (token_id, price) in db_prices {
        if price > 0.0
            && let Some(entry) = result.get_mut(&token_id)
            && entry.price.is_none()
        {
            entry.price = Some(price);
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
            let is_near =
                params.token_id.eq_ignore_ascii_case("near") || params.token_id.is_empty();
            if is_near {
                params.token_id = "near".to_string();
            }

            // Fetch token metadata using the reusable function
            let tokens =
                fetch_tokens_metadata_enriched(&state_clone, &[params.token_id.clone()]).await;

            let wrap_metadata = tokens.get(&params.token_id).ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    format!("Token not found: {}", params.token_id),
                )
            })?;

            let metadata = if is_near {
                // Use helper to create NEAR metadata with wrap.near's price and icon
                TokenMetadata::create_near_metadata(
                    wrap_metadata.price,
                    wrap_metadata.price_updated_at.clone(),
                )
            } else {
                wrap_metadata.clone()
            };

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
///
/// Returns a list of token contract addresses that exactly match the symbol (case-insensitive)
/// sorted by onchain_market_cap (descending).
///
/// **Important:** This function filters to EXACT symbol matches only, excluding tokens with
/// the same symbol on different networks/chains. For example, searching for "USDC" returns only:
/// - eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near (USDC on Ethereum)
/// - base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near (USDC on Base)
/// - arbitrum-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near (USDC on Arbitrum)
///
/// All of these are returned because they all have the exact symbol "USDC". This allows the
/// caller to decide whether to use all versions or filter further. The results are sorted by
/// onchain_market_cap (descending), so the most liquid version appears first.
///
/// **Special case for "NEAR" and "WNEAR":** When searching for "NEAR" or "WNEAR", the function
/// returns hardcoded values `["wrap.near", "near"]` without making an API call, since native NEAR
/// is not an FT token and these are the canonical NEAR token addresses. Both symbols refer to the
/// same underlying tokens.
pub async fn search_token_by_symbol(
    state: &Arc<AppState>,
    symbol: &str,
) -> Result<Vec<String>, (StatusCode, String)> {
    let symbol_upper = symbol.to_uppercase();

    // Special case for NEAR
    if symbol_upper == "NEAR" || symbol_upper == "WNEAR" {
        return Ok(vec!["wrap.near".to_string(), "near".to_string()]);
    }

    // Step 1: Check counterparties table first (fast path, no API call)
    let db_results = match sqlx::query!(
        r#"
        SELECT account_id
        FROM counterparties
        WHERE UPPER(token_symbol) = UPPER($1)
          AND account_type = 'ft_token'
        ORDER BY discovered_at DESC
        "#,
        symbol
    )
    .fetch_all(&state.db_pool)
    .await
    {
        Ok(rows) => rows.into_iter().map(|r| r.account_id).collect::<Vec<_>>(),
        Err(e) => {
            log::warn!(
                "Failed to search counterparties table for {}: {}",
                symbol,
                e
            );
            vec![]
        }
    };

    // If found in database, return immediately (skip NearBlocks API)
    if !db_results.is_empty() {
        log::debug!(
            "Found {} tokens in counterparties for symbol '{}': {:?}",
            db_results.len(),
            symbol,
            db_results
        );
        return Ok(db_results);
    }

    // Step 2: Fallback to NearBlocks API only if not in database
    log::debug!(
        "Symbol '{}' not in counterparties, falling back to NearBlocks API",
        symbol
    );

    let cache_key = format!("search-token-{}", symbol.to_lowercase());

    state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            let url = format!("https://api.nearblocks.io/v1/fts/?search={}", symbol);

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

            // Filter to only exact symbol matches (case-insensitive)
            tokens.retain(|t| t.symbol.to_uppercase() == symbol_upper);

            // Sort filtered tokens by market cap (descending)
            tokens.sort_by(|a, b| {
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
            });

            // Return all contract addresses that exactly match the symbol
            let contract_addresses: Vec<String> =
                tokens.iter().map(|t| t.contract.clone()).collect();

            Ok::<_, (StatusCode, String)>(contract_addresses)
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::{
        build_metadata_lookup_candidates, metadata_lookup_candidates, nearblocks_lookup_candidate,
        tokens_json_metadata_for_defuse,
    };

    #[test]
    fn metadata_lookup_candidates_handles_raw_id() {
        let candidates = metadata_lookup_candidates("usdt.tether-token.near");
        assert!(candidates.contains(&"usdt.tether-token.near".to_string()));
        assert!(candidates.contains(&"nep141:usdt.tether-token.near".to_string()));
    }

    #[test]
    fn metadata_lookup_candidates_handles_prefixed_id() {
        let id = "nep245:v2_1.omni.hot.tg:56_abc";
        let candidates = build_metadata_lookup_candidates(id);
        assert!(candidates.all.contains(&id.to_string()));
        assert_eq!(
            candidates.defuse,
            vec![id.to_string()],
            "prefixed ids should remain stable"
        );
    }

    #[test]
    fn metadata_lookup_candidates_handles_intents_id() {
        let id = "intents.near:nep141:wrap.near";
        let candidates = metadata_lookup_candidates(id);
        assert!(candidates.contains(&id.to_string()));
        assert!(candidates.contains(&"nep141:wrap.near".to_string()));
    }

    #[test]
    fn metadata_lookup_candidates_handles_near_aliases() {
        let candidates = metadata_lookup_candidates("near");
        assert!(candidates.contains(&"near".to_string()));
        assert!(candidates.contains(&"wrap.near".to_string()));
        assert!(candidates.contains(&"nep141:wrap.near".to_string()));
    }

    #[test]
    fn nearblocks_candidate_accepts_only_near_like_ids() {
        assert_eq!(
            nearblocks_lookup_candidate(&metadata_lookup_candidates("token.near")),
            Some("token.near".to_string())
        );
        assert_eq!(
            nearblocks_lookup_candidate(&metadata_lookup_candidates("nep141:token.near")),
            Some("token.near".to_string())
        );
        assert_eq!(
            nearblocks_lookup_candidate(&metadata_lookup_candidates(
                "intents.near:nep141:token.near"
            )),
            Some("token.near".to_string())
        );
        assert_eq!(
            nearblocks_lookup_candidate(&metadata_lookup_candidates("nep245:v2_1.omni.hot.tg:1_x")),
            None
        );
    }

    #[test]
    fn contract_candidates_strip_only_nep141_prefix() {
        let contracts = build_metadata_lookup_candidates("nep141:wrap.near").contract;
        assert!(contracts.contains(&"wrap.near".to_string()));
        assert!(!contracts.iter().any(|c| c.starts_with("nep245:")));
    }

    #[test]
    fn tokens_json_duplicate_defuse_id_resolves_by_address() {
        let defuse_id = "nep141:aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near";
        let near_contract =
            vec!["aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near".to_string()];
        let resolved = tokens_json_metadata_for_defuse(defuse_id, &near_contract, defuse_id)
            .expect("expected token resolution from tokens.json");
        assert_eq!(resolved.network.as_deref(), Some("near"));
    }
}
