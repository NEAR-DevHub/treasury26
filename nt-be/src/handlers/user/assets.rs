use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use near_api::Contract;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::{
    AppState,
    constants::{INTENTS_CONTRACT_ID, NEAR_ICON, REF_FINANCE_CONTRACT_ID, WRAP_NEAR_ICON},
    handlers::intents::supported_tokens::fetch_enriched_tokens,
};

#[derive(Deserialize)]
pub struct UserAssetsQuery {
    #[serde(rename = "accountId")]
    pub account_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TokenMetadata {
    pub decimals: u8,
    pub symbol: String,
    pub name: String,
    pub icon: String,
}

impl TokenMetadata {
    pub fn near() -> Self {
        Self {
            decimals: 24,
            symbol: "NEAR".to_string(),
            name: "NEAR".to_string(),
            icon: NEAR_ICON.to_string(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum TokenResidency {
    Near,
    Ft,
    Intents,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SimplifiedToken {
    pub id: String,
    #[serde(rename = "contractId")]
    pub contract_id: Option<String>,
    pub residency: TokenResidency,
    pub network: String,
    pub symbol: String,

    pub balance: String,
    pub decimals: u8,
    pub price: String,
    pub name: String,
    pub icon: String,
}

#[derive(Deserialize, Debug)]
struct FastNearToken {
    contract_id: String,
    balance: String,
}

#[derive(Deserialize, Debug)]
struct FastNearResponse {
    tokens: Option<Vec<FastNearToken>>,
    state: Option<FastNearState>,
}

#[derive(Deserialize, Debug)]
struct FastNearState {
    balance: String,
}

/// Fetches whitelisted token IDs from the Ref Finance contract via RPC
async fn fetch_whitelisted_tokens_from_rpc(
    state: &Arc<AppState>,
) -> Result<HashSet<String>, (StatusCode, String)> {
    let whitelisted_tokens = Contract(REF_FINANCE_CONTRACT_ID.into())
        .call_function("get_whitelisted_tokens", ())
        .read_only::<HashSet<String>>()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching whitelisted tokens from RPC: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch whitelisted tokens".to_string(),
            )
        })?;

    Ok(whitelisted_tokens.data)
}

async fn fetch_ref_finance_tokens_from_api(
    state: &Arc<AppState>,
) -> Result<HashMap<String, TokenMetadata>, (StatusCode, String)> {
    let ref_response = state
        .http_client
        .get("https://api.ref.finance/list-token")
        .send()
        .await
        .map_err(|e| {
            eprintln!("Error fetching ref finance tokens: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch ref finance tokens".to_string(),
            )
        })?;

    let all_ref_tokens: HashMap<String, TokenMetadata> =
        ref_response.json().await.map_err(|e| {
            eprintln!("Error parsing ref finance tokens: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to parse ref finance tokens".to_string(),
            )
        })?;

    Ok(all_ref_tokens)
}

/// Fetches all Ref Finance tokens and filters them by whitelist
async fn fetch_ref_finance_tokens(
    state: &Arc<AppState>,
) -> Result<HashMap<String, TokenMetadata>, (StatusCode, String)> {
    let cache_key = "ref-finance-tokens";

    // Check cache first
    if let Some(cached_tokens) = state.cache.get(cache_key).await {
        println!("🔁 Returning cached ref finance tokens");
        let tokens: HashMap<String, TokenMetadata> = serde_json::from_value(cached_tokens)
            .map_err(|e| {
                eprintln!("Error deserializing cached tokens: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to deserialize cached tokens".to_string(),
                )
            })?;
        return Ok(tokens);
    }

    // Fetch whitelist and all tokens
    let (whitelist_set, all_ref_tokens) = tokio::try_join!(
        fetch_whitelisted_tokens_from_rpc(state),
        fetch_ref_finance_tokens_from_api(state)
    )
    .map_err(|e| {
        eprintln!("Error in concurrent requests: {:?}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to fetch data".to_string(),
        )
    })?;

    // Filter tokens by whitelist
    let mut filtered_tokens: HashMap<String, TokenMetadata> = all_ref_tokens
        .into_iter()
        .filter(|(token_id, _)| whitelist_set.contains(token_id.as_str()))
        .collect();

    // Add NEAR token
    filtered_tokens.insert("near".to_string(), TokenMetadata::near());

    // Cache the result
    let tokens_value = serde_json::to_value(&filtered_tokens).map_err(|e| {
        eprintln!("Error serializing tokens: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to serialize tokens".to_string(),
        )
    })?;

    state
        .cache
        .insert(cache_key.to_string(), tokens_value)
        .await;

    Ok(filtered_tokens)
}

/// Fetches user balances from FastNear API
async fn fetch_user_balances(
    state: &Arc<AppState>,
    account: &str,
) -> Result<FastNearResponse, (StatusCode, String)> {
    let response = state
        .http_client
        .get(format!(
            "https://api.fastnear.com/v1/account/{}/full",
            account
        ))
        .header(
            "Authorization",
            format!("Bearer {}", state.env_vars.fastnear_api_key),
        )
        .send()
        .await
        .map_err(|e| {
            eprintln!("Error fetching user balances: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch user balances".to_string(),
            )
        })?;

    response.json().await.map_err(|e| {
        eprintln!("Error parsing balances: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to parse balances".to_string(),
        )
    })
}

/// Fetches token prices from Ref Finance API
async fn fetch_token_prices(
    state: &Arc<AppState>,
) -> Result<HashMap<String, serde_json::Value>, (StatusCode, String)> {
    let response = state
        .http_client
        .get("https://api.ref.finance/list-token-price")
        .send()
        .await
        .map_err(|e| {
            eprintln!("Error fetching token prices: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch token prices".to_string(),
            )
        })?;

    response.json().await.map_err(|e| {
        eprintln!("Error parsing prices: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to parse prices".to_string(),
        )
    })
}

/// Builds a map of token balances from FastNear response
fn build_balance_map(user_balances: &FastNearResponse) -> HashMap<String, String> {
    let mut balance_map = HashMap::new();
    if let Some(tokens) = &user_balances.tokens {
        for token in tokens {
            balance_map.insert(token.contract_id.to_lowercase(), token.balance.clone());
        }
    }
    balance_map
}

/// Gets the balance for a specific token
fn get_token_balance(
    token_id: &str,
    user_balances: &FastNearResponse,
    balance_map: &HashMap<String, String>,
) -> String {
    if token_id == "near" {
        user_balances
            .state
            .as_ref()
            .map(|s| s.balance.clone())
            .unwrap_or_else(|| "0".to_string())
    } else {
        balance_map
            .get(token_id)
            .cloned()
            .unwrap_or_else(|| "0".to_string())
    }
}

/// Gets the appropriate icon for a token
fn get_token_icon(
    token_id: &str,
    metadata: &TokenMetadata,
    metadata_icon: Option<&String>,
) -> String {
    // First check if we have metadata icon from enriched tokens
    if let Some(icon) = metadata_icon {
        return icon.clone();
    }

    // Fallback to hardcoded icons or contract metadata
    if token_id == "near" {
        NEAR_ICON.to_string()
    } else if token_id == "wrap.near" {
        WRAP_NEAR_ICON.to_string()
    } else {
        metadata.icon.clone()
    }
}

#[derive(Deserialize, Debug)]
struct IntentsToken {
    token_id: String,
}

/// Fetches tokens owned by an account from intents.near
async fn fetch_intents_owned_tokens(
    state: &Arc<AppState>,
    account_id: &str,
) -> Result<Vec<String>, (StatusCode, String)> {
    let owned_tokens = Contract(INTENTS_CONTRACT_ID.into())
        .call_function(
            "mt_tokens_for_owner",
            serde_json::json!({
                "account_id": account_id
            }),
        )
        .read_only::<Vec<IntentsToken>>()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching owned tokens from intents.near: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch owned tokens from intents.near".to_string(),
            )
        })?;

    Ok(owned_tokens.data.into_iter().map(|t| t.token_id).collect())
}

/// Fetches balances for multiple tokens from intents.near
async fn fetch_intents_balances(
    state: &Arc<AppState>,
    account_id: &str,
    token_ids: &[String],
) -> Result<Vec<String>, (StatusCode, String)> {
    if token_ids.is_empty() {
        return Ok(Vec::new());
    }

    let balances = Contract(INTENTS_CONTRACT_ID.into())
        .call_function(
            "mt_batch_balance_of",
            serde_json::json!({
                "account_id": account_id,
                "token_ids": token_ids
            }),
        )
        .read_only::<Vec<String>>()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching balances from intents.near: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch balances from intents.near".to_string(),
            )
        })?;

    Ok(balances.data)
}

/// Builds the list of simplified tokens with balances and prices using enriched metadata
fn build_simplified_tokens(
    all_tokens: HashMap<String, TokenMetadata>,
    user_balances: &FastNearResponse,
    token_prices: &HashMap<String, serde_json::Value>,
    enriched_tokens: &Vec<crate::handlers::intents::supported_tokens::EnrichedTokenMetadata>,
) -> Vec<SimplifiedToken> {
    let balance_map = build_balance_map(user_balances);
    let mut simplified_tokens = all_tokens
        .into_iter()
        .flat_map(|(token_id, token_metadata)| {
            let price_key = if token_id == "near" {
                "wrap.near"
            } else {
                &token_id
            };

            // Try to find enriched metadata by near_token_id
            let enriched_meta = enriched_tokens.iter().find(|m| {
                (m.near_token_id
                    .as_ref()
                    .map(|id| id == &token_id)
                    .unwrap_or(false)
                    || m.contract_address == token_id)
                    && m.chain_name == "near"
            });

            // Use price from enriched metadata first, then fallback to ref finance prices
            let price = enriched_meta
                .and_then(|m| m.price.map(|p| p.to_string()))
                .or_else(|| {
                    token_prices
                        .get(price_key)
                        .and_then(|p| p.get("price"))
                        .and_then(|p| p.as_str())
                        .map(|p| p.to_string())
                });

            if let Some(price) = price {
                let decimals = token_metadata.decimals;

                // Use enriched metadata first, fallback to token_metadata
                let symbol = enriched_meta
                    .map(|m| m.symbol.clone())
                    .unwrap_or_else(|| token_metadata.symbol.clone());
                let name = enriched_meta.map(|m| m.name.clone()).unwrap_or_else(|| {
                    if token_metadata.name.is_empty() {
                        token_metadata.symbol.clone()
                    } else {
                        token_metadata.name.clone()
                    }
                });

                let is_near = token_id == "near";
                let id = if is_near {
                    "near".to_string()
                } else {
                    format!("ft:{}", token_id)
                };

                Some(SimplifiedToken {
                    id,
                    contract_id: if is_near {
                        None
                    } else {
                        Some(token_id.clone())
                    },
                    decimals,
                    balance: get_token_balance(&token_id, user_balances, &balance_map),
                    price,
                    symbol,
                    name,
                    icon: get_token_icon(
                        &token_id,
                        &token_metadata,
                        enriched_meta.and_then(|m| m.icon.as_ref()),
                    ),
                    network: "near".to_string(),
                    residency: if is_near {
                        TokenResidency::Near
                    } else {
                        TokenResidency::Ft
                    },
                })
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    // Sort by parsed balance (highest first)
    simplified_tokens.sort_by(|a, b| {
        let a_val: u128 = a.balance.parse().unwrap_or(0);
        let b_val: u128 = b.balance.parse().unwrap_or(0);
        b_val
            .partial_cmp(&a_val)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    simplified_tokens
}

/// Builds intents tokens from enriched metadata
fn build_intents_tokens(
    tokens_with_balances: Vec<(String, String)>,
    enriched_tokens: &Vec<crate::handlers::intents::supported_tokens::EnrichedTokenMetadata>,
) -> Vec<SimplifiedToken> {
    // Build simplified tokens with metadata
    let mut simplified_tokens: Vec<SimplifiedToken> = tokens_with_balances
        .into_iter()
        .filter_map(|(token_id, balance)| {
            let metadata = enriched_tokens
                .iter()
                .find(|t| t.intents_token_id.as_ref() == Some(&token_id))?;

            // Extract contract_id (remove prefix like "nep141:" if present)
            let contract_id = if token_id.starts_with("nep141:") {
                token_id.split(':').nth(1).unwrap_or(&token_id).to_string()
            } else {
                token_id.clone()
            };

            // Use price from enriched metadata, or "0" as fallback
            let price = metadata
                .price
                .map(|p| p.to_string())
                .unwrap_or_else(|| "0".to_string());

            let symbol = metadata.symbol.clone();
            let name = metadata.name.clone();
            let icon = metadata
                .icon
                .clone()
                .unwrap_or_else(|| NEAR_ICON.to_string());

            Some(SimplifiedToken {
                id: format!("intents:{}", metadata.defuse_asset_id),
                contract_id: Some(contract_id),
                decimals: metadata.decimals,
                balance,
                price,
                symbol,
                name,
                icon,
                network: metadata.chain_name.clone(),
                residency: TokenResidency::Intents,
            })
        })
        .collect();

    // Sort by parsed balance (highest first)
    simplified_tokens.sort_by(|a, b| {
        let a_val: u128 = a.balance.parse().unwrap_or(0);
        let b_val: u128 = b.balance.parse().unwrap_or(0);
        b_val
            .partial_cmp(&a_val)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    simplified_tokens
}

pub async fn get_user_assets(
    State(state): State<Arc<AppState>>,
    Query(params): Query<UserAssetsQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let account = &params.account_id;

    if account.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "account is required".to_string()));
    }

    let cache_key = format!("{}-user-assets", account);

    // Check cache
    if let Some(cached_tokens) = state.cache.get(&cache_key).await {
        println!("🔁 Returning cached user assets for {}", account);
        return Ok((StatusCode::OK, Json(cached_tokens)));
    }

    // Fetch enriched metadata once for all tokens
    let enriched_tokens_future = fetch_enriched_tokens(&state);

    // Fetch REF Finance data
    let ref_data_future = async {
        let tokens_future = fetch_ref_finance_tokens(&state);
        let balances_future = fetch_user_balances(&state, account);
        let prices_future = fetch_token_prices(&state);

        tokio::try_join!(tokens_future, balances_future, prices_future)
    };

    // Fetch intents balances
    let intents_data_future = async {
        let owned_token_ids = fetch_intents_owned_tokens(&state, account).await?;
        if owned_token_ids.is_empty() {
            return Ok::<_, (StatusCode, String)>(Vec::new());
        }

        let balances = fetch_intents_balances(&state, account, &owned_token_ids).await?;

        // Filter to only tokens with non-zero balances
        let tokens_with_balances: Vec<(String, String)> = owned_token_ids
            .into_iter()
            .zip(balances.into_iter())
            .filter(|(_, balance)| balance.parse::<u128>().unwrap_or(0) > 0)
            .collect();

        Ok(tokens_with_balances)
    };

    // Fetch all data concurrently
    let (enriched_tokens_result, ref_data_result, intents_data_result) =
        tokio::join!(enriched_tokens_future, ref_data_future, intents_data_future);

    // Handle enriched tokens result
    let enriched_tokens = enriched_tokens_result.map_err(|e| {
        eprintln!("Error fetching enriched tokens: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to fetch enriched tokens: {}", e),
        )
    })?;

    // Build REF Finance tokens with enriched metadata
    let (all_tokens, user_balances, token_prices) = ref_data_result?;
    let mut all_simplified_tokens =
        build_simplified_tokens(all_tokens, &user_balances, &token_prices, &enriched_tokens);

    // Build intents tokens with enriched metadata
    let intents_balances = intents_data_result.unwrap_or_else(|e| {
        eprintln!("Warning: Failed to fetch intents tokens: {:?}", e);
        Vec::new()
    });

    let intents_tokens = build_intents_tokens(intents_balances, &enriched_tokens);
    all_simplified_tokens.extend(intents_tokens);

    // Sort combined list by balance (highest first)
    all_simplified_tokens = all_simplified_tokens
        .into_iter()
        .filter(|t| t.balance.parse::<u128>().unwrap_or(0) > 0)
        .collect::<Vec<_>>();
    all_simplified_tokens.sort_by(|a, b| {
        let a_val: u128 = a.balance.parse().unwrap_or(0);
        let b_val: u128 = b.balance.parse().unwrap_or(0);
        b_val
            .partial_cmp(&a_val)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let result_value = serde_json::to_value(&all_simplified_tokens).map_err(|e| {
        eprintln!("Error serializing result: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to serialize result".to_string(),
        )
    })?;

    state.cache.insert(cache_key, result_value.clone()).await;

    Ok((StatusCode::OK, Json(result_value)))
}
