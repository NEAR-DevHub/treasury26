use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use near_api::{AccountId, Tokens};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;

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
    pub balance: String,
    pub decimals: u8,
}

/// Fetch NEAR balance for an account
async fn fetch_near_balance(
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
        balance: balance.total.as_yoctonear().to_string(),
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
        balance: balance.amount().to_string(),
        decimals: balance.decimals(),
    })
}

/// Main handler for token balance endpoint
pub async fn get_token_balance(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TokenBalanceQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let account_id = params.account_id;
    let token_id = params.token_id.trim();

    // Check cache first (short cache for balances as they change frequently)
    let cache_key = format!("token-balance:{}:{}", account_id, token_id);
    if let Some(cached_data) = state.cache.get(&cache_key).await {
        println!(
            "🔁 Returning cached balance for {} / {}",
            account_id, token_id
        );
        return Ok((StatusCode::OK, Json(cached_data)));
    }

    // Determine if it's NEAR or FT token
    let is_near = token_id == "near" || token_id == "NEAR";

    let response = if is_near {
        fetch_near_balance(&state, account_id).await.map_err(|e| {
            eprintln!("Error fetching NEAR balance: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e)
        })?
    } else {
        // Parse token_id as AccountId
        let token_account_id: AccountId = token_id.parse().map_err(|e| {
            eprintln!("Invalid token ID '{}': {}", token_id, e);
            (StatusCode::BAD_REQUEST, format!("Invalid token ID: {}", e))
        })?;

        fetch_ft_balance(&state, account_id, token_account_id)
            .await
            .map_err(|e| {
                eprintln!("Error fetching token balance: {}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, e)
            })?
    };

    let result_value = serde_json::to_value(&response).map_err(|e| {
        eprintln!("Error serializing token balance: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to serialize token balance".to_string(),
        )
    })?;

    // Cache for 30 seconds (balances change frequently)
    state.cache.insert(cache_key, result_value.clone()).await;

    Ok((StatusCode::OK, Json(result_value)))
}

/// Batch endpoint to fetch multiple token balances at once
#[derive(Deserialize)]
pub struct BatchTokenBalanceQuery {
    #[serde(rename = "accountId")]
    pub account_id: AccountId,
    #[serde(rename = "tokenIds")]
    pub token_ids: String, // Comma-separated token IDs
}

pub async fn get_batch_token_balances(
    State(state): State<Arc<AppState>>,
    Query(params): Query<BatchTokenBalanceQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let account_id = params.account_id;
    let token_ids: Vec<&str> = params.token_ids.split(',').map(|s| s.trim()).collect();

    if token_ids.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "No token IDs provided".to_string()));
    }

    let mut futures = Vec::new();

    for token_id in token_ids {
        let state_clone = state.clone();
        let account_id_clone = account_id.clone();
        let token_id_owned = token_id.to_string();

        futures.push(async move {
            let cache_key = format!("token-balance:{}:{}", account_id_clone, token_id_owned);

            // Check cache first
            if let Some(cached_data) = state_clone.cache.get(&cache_key).await {
                return serde_json::from_value::<TokenBalanceResponse>(cached_data).ok();
            }

            let is_near = token_id_owned == "near" || token_id_owned == "NEAR";

            let result = if is_near {
                fetch_near_balance(&state_clone, account_id_clone).await
            } else {
                match token_id_owned.parse::<AccountId>() {
                    Ok(token_account_id) => {
                        fetch_ft_balance(&state_clone, account_id_clone, token_account_id).await
                    }
                    Err(e) => {
                        eprintln!("Invalid token ID '{}': {}", token_id_owned, e);
                        Err(format!("Invalid token ID: {}", e))
                    }
                }
            };

            match result {
                Ok(response) => {
                    if let Ok(value) = serde_json::to_value(&response) {
                        state_clone.cache.insert(cache_key, value).await;
                    }
                    Some(response)
                }
                Err(e) => {
                    eprintln!("Error fetching balance for {}: {}", token_id_owned, e);
                    None
                }
            }
        });
    }

    let results = futures::future::join_all(futures).await;
    let balances: Vec<TokenBalanceResponse> = results.into_iter().flatten().collect();

    Ok((StatusCode::OK, Json(balances)))
}
