use crate::{
    handlers::user::{balance::TokenBalanceResponse, lockup::fetch_lockup_balance_of_account},
    utils::cache::CacheTier,
};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use near_api::{AccountId, Contract, types::json::U128};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::{
    AppState,
    constants::{
        INTENTS_CONTRACT_ID, NEAR_ICON, REF_FINANCE_CONTRACT_ID, intents_chains::ChainIcons,
    },
    handlers::token::{TokenMetadata as TokenMetadataResponse, fetch_tokens_metadata},
};

#[derive(Deserialize)]
pub struct UserAssetsQuery {
    #[serde(rename = "accountId")]
    pub account_id: AccountId,
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
    Lockup,
    Staked,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SimplifiedToken {
    pub id: String,
    #[serde(rename = "contractId")]
    pub contract_id: Option<String>,
    pub residency: TokenResidency,
    pub network: String,
    #[serde(rename = "chainName")]
    pub chain_name: String,
    pub symbol: String,

    pub balance: String,
    #[serde(rename = "lockedBalance")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked_balance: Option<String>,
    #[serde(rename = "stakedBalance")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staked_balance: Option<String>,
    pub decimals: u8,
    pub price: String,
    pub name: String,
    pub icon: Option<String>,
    #[serde(rename = "chainIcons")]
    pub chain_icons: Option<ChainIcons>,
}

#[derive(Deserialize, Debug)]
struct FastNearToken {
    contract_id: String,
    balance: U128,
}

#[derive(Deserialize, Debug)]
struct FastNearResponse {
    tokens: Option<Vec<FastNearToken>>,
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

/// Fetches all Ref Finance tokens and filters them by whitelist
async fn fetch_whitelisted_tokens(
    state: &Arc<AppState>,
) -> Result<HashSet<String>, (StatusCode, String)> {
    let cache_key = "ref-whitelisted-tokens".to_string();
    let state_clone = state.clone();

    state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            fetch_whitelisted_tokens_from_rpc(&state_clone).await
        })
        .await
}

/// Fetches user balances from FastNear API
async fn fetch_user_balances(
    state: &Arc<AppState>,
    account: &AccountId,
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

/// Builds a map of token balances from FastNear response
fn build_balance_map(user_balances: &FastNearResponse) -> HashMap<String, U128> {
    let mut balance_map = HashMap::new();
    if let Some(tokens) = &user_balances.tokens {
        for token in tokens {
            balance_map.insert(token.contract_id.to_lowercase(), token.balance.clone());
        }
    }
    balance_map
}

#[derive(Deserialize, Debug)]
struct IntentsToken {
    token_id: String,
}

/// Fetches tokens owned by an account from intents.near
async fn fetch_intents_owned_tokens(
    state: &Arc<AppState>,
    account_id: &AccountId,
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
    account_id: &AccountId,
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

/// Builds intents tokens from token metadata
fn build_intents_tokens(
    tokens_with_balances: Vec<(String, String)>,
    tokens_metadata: &[TokenMetadataResponse],
) -> Vec<(SimplifiedToken, U128)> {
    tokens_with_balances
        .into_iter()
        .filter_map(|(token_id, balance)| {
            // Find metadata by matching token_id
            let metadata = tokens_metadata.iter().find(|t| t.token_id == token_id)?;

            // Extract contract_id (remove prefix like "nep141:" if present)
            let contract_id = if token_id.starts_with("nep141:") {
                token_id.split(':').nth(1).unwrap_or(&token_id).to_string()
            } else {
                token_id.clone()
            };
            let balance_raw: U128 = balance.parse::<u128>().unwrap_or(0).into();

            Some((
                SimplifiedToken {
                    id: metadata.token_id.clone(),
                    contract_id: Some(contract_id),
                    decimals: metadata.decimals,
                    balance: balance_raw.0.to_string(),
                    price: metadata
                        .price
                        .map(|p| p.to_string())
                        .unwrap_or_else(|| "0".to_string()),
                    locked_balance: None,
                    staked_balance: None,
                    symbol: metadata.symbol.clone(),
                    name: metadata.name.clone(),
                    icon: metadata.icon.clone(),
                    network: metadata.network.clone().unwrap_or_default(),
                    residency: TokenResidency::Intents,
                    chain_icons: metadata.chain_icons.clone(),
                    chain_name: metadata.chain_name.clone().unwrap_or(metadata.name.clone()),
                },
                balance_raw,
            ))
        })
        .collect()
}

pub async fn fetch_near_balance(
    state: &Arc<AppState>,
    account_id: &AccountId,
) -> Result<TokenBalanceResponse, (StatusCode, String)> {
    crate::handlers::user::balance::fetch_near_balance(state, account_id.clone())
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch NEAR balance: {}", e),
            )
        })
}

pub async fn get_user_assets(
    State(state): State<Arc<AppState>>,
    Query(params): Query<UserAssetsQuery>,
) -> Result<Json<Vec<SimplifiedToken>>, (StatusCode, String)> {
    let account = params.account_id.clone();

    let cache_key = format!("{}-user-assets", account);

    let state_clone = state.clone();
    let all_simplified_tokens = state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            // Fetch REF Finance data
            let ref_data_future = async {
                let tokens_future = fetch_whitelisted_tokens(&state_clone);
                let balances_future = fetch_user_balances(&state_clone, &account);
                let near_balance = fetch_near_balance(&state_clone, &account);
                let lockup_balance = fetch_lockup_balance_of_account(&state_clone, &account);

                tokio::try_join!(tokens_future, balances_future, near_balance, lockup_balance)
            };

            // Fetch intents balances
            let intents_data_future = async {
                let owned_token_ids = fetch_intents_owned_tokens(&state_clone, &account).await?;
                if owned_token_ids.is_empty() {
                    return Ok::<_, (StatusCode, String)>(Vec::new());
                }

                let balances =
                    fetch_intents_balances(&state_clone, &account, &owned_token_ids).await?;

                // Filter to only tokens with non-zero balances
                let tokens_with_balances: Vec<(String, String)> = owned_token_ids
                    .into_iter()
                    .zip(balances.into_iter())
                    .filter(|(_, balance)| balance.parse::<u128>().unwrap_or(0) > 0)
                    .collect();

                Ok(tokens_with_balances)
            };

            // Fetch all data concurrently
            let (ref_data_result, intents_data_result) =
                tokio::join!(ref_data_future, intents_data_future);

            // Get whitelisted tokens and user balances
            let (whitelist_set, user_balances, near_balance, lockup_balance) = ref_data_result?;

            // Get intents balances (already filtered to non-zero)
            let intents_balances = intents_data_result.unwrap_or_else(|e| {
                eprintln!("Warning: Failed to fetch intents tokens: {:?}", e);
                Vec::new()
            });

            // Build balance map and filter REF Finance tokens to only those with positive balances
            let balance_map = build_balance_map(&user_balances);
            let ref_tokens_with_balances: Vec<(String, U128)> = whitelist_set
                .into_iter()
                .filter_map(|token_id| {
                    let balance = balance_map
                        .get(&token_id)
                        .cloned()
                        .unwrap_or_else(|| U128::from(0));
                    if balance != U128::from(0) {
                        Some((token_id, balance))
                    } else {
                        None
                    }
                })
                .collect();

            // Collect all unique token IDs that have positive balances
            let mut token_ids_to_fetch: Vec<String> = ref_tokens_with_balances
                .iter()
                .map(|(id, _)| format!("nep141:{}", id.clone()))
                .collect();
            token_ids_to_fetch.extend(intents_balances.iter().map(|(id, _)| id.clone()));
            token_ids_to_fetch.push("nep141:wrap.near".to_string());

            // Fetch metadata for only tokens with positive balances in a single batch request
            let tokens_metadata = if !token_ids_to_fetch.is_empty() {
                fetch_tokens_metadata(&state_clone, &token_ids_to_fetch).await?
            } else {
                Vec::new()
            };

            // Find wrap.near metadata explicitly instead of assuming it's last
            let near_token_meta = tokens_metadata
                .iter()
                .find(|m| m.token_id == "nep141:wrap.near")
                .cloned()
                .unwrap_or_else(|| {
                    eprintln!(
                        "[User Assets] Warning: wrap.near metadata not found, using fallback"
                    );
                    // Fallback metadata if wrap.near is not found
                    TokenMetadataResponse {
                        token_id: "nep141:wrap.near".to_string(),
                        name: "NEAR".to_string(),
                        symbol: "NEAR".to_string(),
                        decimals: 24,
                        icon: Some(crate::constants::NEAR_ICON.to_string()),
                        price: None,
                        price_updated_at: None,
                        network: Some("near".to_string()),
                        chain_name: Some("Near Protocol".to_string()),
                        chain_icons: None,
                    }
                });

            // Build simplified tokens for REF Finance tokens
            let mut all_simplified_tokens: Vec<(SimplifiedToken, U128)> = ref_tokens_with_balances
                .into_iter()
                .filter_map(|(token_id, balance)| {
                    let intents_token_id = format!("nep141:{}", token_id.clone());
                    let token_meta = tokens_metadata
                        .iter()
                        .find(|m| m.token_id == intents_token_id)?;

                    let price = token_meta.price.unwrap_or(0.0).to_string();

                    Some((
                        SimplifiedToken {
                            id: token_id.clone(),
                            contract_id: Some(token_id),
                            decimals: token_meta.decimals,
                            balance: balance.0.to_string(),
                            locked_balance: None,
                            price,
                            symbol: token_meta.symbol.clone(),
                            name: token_meta.name.clone(),
                            icon: token_meta.icon.clone(),
                            network: "near".to_string(),
                            staked_balance: None,
                            residency: TokenResidency::Ft,
                            chain_icons: token_meta.chain_icons.clone(),
                            chain_name: token_meta
                                .chain_name
                                .clone()
                                .unwrap_or_else(|| "Near Protocol".to_string()),
                        },
                        balance.clone(),
                    ))
                })
                .collect();

            // Build intents tokens with metadata
            let intents_tokens = build_intents_tokens(intents_balances, &tokens_metadata);
            all_simplified_tokens.extend(intents_tokens);

            // Add lockup balance if exists
            if let Some(lockup) = lockup_balance {
                all_simplified_tokens.push((
                    SimplifiedToken {
                        id: "near".to_string(),
                        contract_id: None,
                        decimals: near_token_meta.decimals,
                        balance: lockup.available.as_yoctonear().to_string(),
                        locked_balance: Some(lockup.not_vested.as_yoctonear().to_string()),
                        price: near_token_meta.price.unwrap_or(0.0).to_string(),
                        symbol: near_token_meta.symbol.clone(),
                        name: near_token_meta.name.clone(),
                        icon: near_token_meta.icon.clone(),
                        staked_balance: Some(lockup.staked.as_yoctonear().to_string()),
                        network: near_token_meta.network.clone().unwrap_or_default(),
                        residency: TokenResidency::Lockup,
                        chain_name: near_token_meta
                            .chain_name
                            .clone()
                            .unwrap_or(near_token_meta.name.clone()),
                        chain_icons: near_token_meta.chain_icons.clone(),
                    },
                    U128::from(lockup.available.as_yoctonear()),
                ));
            }
            all_simplified_tokens.push((
                SimplifiedToken {
                    id: "near".to_string(),
                    contract_id: None,
                    decimals: near_token_meta.decimals,
                    balance: near_balance.balance.0.to_string(),
                    locked_balance: near_balance.locked_balance.map(|b| b.0.to_string()),
                    price: near_token_meta.price.unwrap_or(0.0).to_string(),
                    symbol: near_token_meta.symbol.clone(),
                    name: near_token_meta.name.clone(),
                    icon: near_token_meta.icon.clone(),
                    network: near_token_meta.network.clone().unwrap_or_default(),
                    residency: TokenResidency::Near,
                    staked_balance: None,
                    chain_name: near_token_meta
                        .chain_name
                        .clone()
                        .unwrap_or(near_token_meta.name.clone()),
                    chain_icons: near_token_meta.chain_icons.clone(),
                },
                near_balance.balance,
            ));

            // Sort combined list by balance (highest first)
            all_simplified_tokens = all_simplified_tokens
                .into_iter()
                .filter(|(_, balance)| balance.0 > 0)
                .collect::<Vec<(SimplifiedToken, U128)>>();
            all_simplified_tokens.sort_by(|(_, a_balance), (_, b_balance)| {
                b_balance
                    .0
                    .partial_cmp(&a_balance.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

            Ok::<_, (StatusCode, String)>(
                all_simplified_tokens
                    .into_iter()
                    .map(|(token, _)| token)
                    .collect(),
            )
        })
        .await?;

    Ok(Json(all_simplified_tokens))
}
