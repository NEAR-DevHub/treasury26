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
    constants::{NEAR_ICON, REF_FINANCE_CONTRACT_ID, WRAP_NEAR_ICON},
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
pub struct SimplifiedToken {
    pub id: String,
    pub decimals: u8,
    pub balance: String,
    pub price: String,
    pub symbol: String,
    pub name: String,
    pub icon: String,
    pub network: String,
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
fn get_token_icon(token_id: &str, metadata: &TokenMetadata) -> String {
    if token_id == "near" {
        NEAR_ICON.to_string()
    } else if token_id == "wrap.near" {
        WRAP_NEAR_ICON.to_string()
    } else {
        metadata.icon.clone()
    }
}

/// Builds the list of simplified tokens with balances and prices
fn build_simplified_tokens(
    all_tokens: HashMap<String, TokenMetadata>,
    user_balances: &FastNearResponse,
    token_prices: &HashMap<String, serde_json::Value>,
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

            if let Some(price_data) = token_prices.get(price_key) {
                if let Some(price) = price_data.get("price").and_then(|p| p.as_str()) {
                    Some(SimplifiedToken {
                        id: token_id.clone(),
                        decimals: token_metadata.decimals,
                        balance: get_token_balance(&token_id, user_balances, &balance_map),
                        price: price.to_string(),
                        symbol: token_metadata.symbol.clone(),
                        name: if token_metadata.name.is_empty() {
                            token_metadata.symbol.clone()
                        } else {
                            token_metadata.name.clone()
                        },
                        icon: get_token_icon(&token_id, &token_metadata),
                        network: "NEAR".to_string(),
                    })
                } else {
                    None
                }
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

    // Fetch data concurrently
    let tokens_future = fetch_ref_finance_tokens(&state);
    let balances_future = fetch_user_balances(&state, account);
    let prices_future = fetch_token_prices(&state);

    let (all_tokens, user_balances, token_prices) =
        tokio::try_join!(tokens_future, balances_future, prices_future).map_err(|e| {
            eprintln!("Error in concurrent requests: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch data".to_string(),
            )
        })?;

    // Build simplified tokens list
    let simplified_tokens = build_simplified_tokens(all_tokens, &user_balances, &token_prices);

    let result_value = serde_json::to_value(&simplified_tokens).map_err(|e| {
        eprintln!("Error serializing result: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to serialize result".to_string(),
        )
    })?;

    state.cache.insert(cache_key, result_value.clone()).await;

    Ok((StatusCode::OK, Json(result_value)))
}
