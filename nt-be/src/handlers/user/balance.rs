use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use near_api::{AccountId, Contract, Tokens, types::json::U128};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{
    AppState,
    constants::INTENTS_CONTRACT_ID,
    utils::cache::{CacheKey, cached_json},
};

#[derive(Deserialize)]
pub struct TokenBalanceQuery {
    #[serde(rename = "accountId")]
    pub account_id: AccountId,
    #[serde(rename = "tokenId")]
    pub token_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TokenBalanceResponse {
    pub account_id: String,
    pub token_id: String,
    pub balance: U128,
    #[serde(rename = "lockedBalance")]
    pub locked_balance: Option<U128>,
    pub decimals: u8,
}

/// Fetch NEAR balance for an account
pub async fn fetch_near_balance(
    state: &Arc<AppState>,
    account_id: AccountId,
) -> Result<TokenBalanceResponse, String> {
    let balance = Tokens::account(account_id.clone())
        .near_balance()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching NEAR balance for {}: {}", account_id, e);
            format!("Failed to fetch NEAR balance: {}", e)
        })?;

    Ok(TokenBalanceResponse {
        account_id: account_id.to_string(),
        token_id: "near".to_string(),
        balance: balance
            .total
            .saturating_sub(balance.storage_locked)
            .as_yoctonear()
            .into(),
        locked_balance: Some(balance.storage_locked.as_yoctonear().into()),
        decimals: 24,
    })
}

/// Fetch FT balance for an account
async fn fetch_ft_balance(
    state: &Arc<AppState>,
    account_id: AccountId,
    token_id: AccountId,
) -> Result<TokenBalanceResponse, String> {
    let balance = Tokens::account(account_id.clone())
        .ft_balance(token_id.clone())
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!(
                "Error fetching FT balance for {} on {}: {}",
                account_id, token_id, e
            );
            format!("Failed to fetch token balance: {}", e)
        })?;

    Ok(TokenBalanceResponse {
        account_id: account_id.to_string(),
        token_id: token_id.to_string(),
        balance: balance.amount().into(),
        locked_balance: None,
        decimals: balance.decimals(),
    })
}

pub async fn fetch_intents_balance(
    state: &Arc<AppState>,
    account_id: AccountId,
    token_id: String,
) -> Result<TokenBalanceResponse, String> {
    let balance: U128 = Contract(INTENTS_CONTRACT_ID.into())
        .call_function(
            "mt_balance_of",
            serde_json::json!({
                "account_id": account_id,
                "token_id": token_id
            }),
        )
        .read_only()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!(
                "Error fetching Intents balance for {} on {}: {}",
                account_id, token_id, e
            );
            format!("Failed to fetch token balance: {}", e)
        })?
        .data;

    let prefix_less_token_id = token_id
        .strip_prefix("nep141:")
        .unwrap_or(&token_id)
        .parse::<AccountId>()
        .map_err(|e| {
            eprintln!("Invalid token ID '{}': {}", token_id, e);
            format!("Invalid token ID: {}", e)
        })?;
    let metadata = Tokens::ft_metadata(prefix_less_token_id)
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching Intents metadata for {}: {}", token_id, e);
            format!("Failed to fetch metadata: {}", e)
        })?;

    Ok(TokenBalanceResponse {
        account_id: account_id.to_string(),
        token_id: token_id.to_string(),
        balance,
        locked_balance: None,
        decimals: metadata.data.decimals,
    })
}

/// Main handler for token balance endpoint
pub async fn get_token_balance(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TokenBalanceQuery>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    let account_id = params.account_id.clone();
    let token_id = params.token_id.trim().to_string();

    let cache_key = CacheKey::new("token-balance")
        .with(&account_id)
        .with(&token_id)
        .build();

    let state_clone = state.clone();
    cached_json(&state.cache.short_term, cache_key, async move {
        // Determine if it's NEAR or FT token
        let is_near = token_id == "near" || token_id == "NEAR";

        if is_near {
            fetch_near_balance(&state_clone, account_id).await
        } else if token_id.starts_with("nep141:") {
            fetch_intents_balance(&state_clone, account_id, token_id.to_string()).await
        } else {
            // Parse token_id as AccountId
            let token_account_id: AccountId = token_id.parse().map_err(|e| {
                eprintln!("Invalid token ID '{}': {}", token_id, e);
                format!("Invalid token ID: {}", e)
            })?;

            fetch_ft_balance(&state_clone, account_id, token_account_id).await
        }
    })
    .await
}
