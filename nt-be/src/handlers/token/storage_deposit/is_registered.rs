use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use near_api::{AccountId, Contract};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct GetStorageDepositQuery {
    #[serde(rename = "accountId")]
    pub account_id: AccountId,
    #[serde(rename = "tokenId")]
    pub token_id: AccountId,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StorageDepositResponse {
    pub account_id: String,
    pub token_id: String,
    pub is_registered: bool,
}

/// Check storage deposit for a single token
async fn check_storage_deposit(
    state: &Arc<AppState>,
    account_id: AccountId,
    token_id: AccountId,
) -> Result<bool, String> {
    if token_id == "near" || token_id == "NEAR" {
        return Ok(true);
    }

    let cache_key = format!("storage-deposit:{}:{}", account_id, token_id);
    if let Some(cached_storage_deposit) = state.cache.get(&cache_key).await {
        println!(
            "🔁 Returning cached storage deposit for {} / {}",
            account_id, token_id
        );
        return Ok(cached_storage_deposit == "true");
    }

    let storage_deposit = Contract(token_id.clone())
        .storage_deposit()
        .view_account_storage(account_id.clone())
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!(
                "Error fetching storage deposit with account_id: {} and token_id: {}: {e}",
                account_id, token_id,
            );
            e.to_string()
        })?
        .data;

    let is_registered = storage_deposit.is_some();
    state
        .cache
        .insert(cache_key, serde_json::Value::Bool(is_registered))
        .await;
    Ok(is_registered)
}

pub async fn is_storage_deposit_registered(
    State(state): State<Arc<AppState>>,
    Query(params): Query<GetStorageDepositQuery>,
) -> Result<Json<bool>, (StatusCode, String)> {
    let account_id = params.account_id.clone();
    let token_id = params.token_id;

    check_storage_deposit(&state, account_id, token_id)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

/// Request body for batch storage deposit check
#[derive(Debug, Deserialize)]
pub struct StorageDepositRequest {
    #[serde(rename = "accountId")]
    pub account_id: AccountId,
    #[serde(rename = "tokenId")]
    pub token_id: AccountId,
}

/// Batch endpoint to check storage deposit for multiple account-token pairs
#[derive(Deserialize)]
pub struct BatchStorageDepositRequest {
    pub requests: Vec<StorageDepositRequest>,
}

pub async fn get_batch_storage_deposit_is_registered(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<BatchStorageDepositRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if payload.requests.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "No requests provided".to_string()));
    }

    let mut futures = Vec::new();

    for request in payload.requests {
        let state_clone = state.clone();
        let account_id = request.account_id;
        let token_id = request.token_id;

        futures.push(async move {
            match check_storage_deposit(&state_clone, account_id.clone(), token_id.clone()).await {
                Ok(is_registered) => Some(StorageDepositResponse {
                    account_id: account_id.to_string(),
                    token_id: token_id.to_string(),
                    is_registered,
                }),
                Err(e) => {
                    eprintln!(
                        "Error checking storage deposit for {} / {}: {}",
                        account_id, token_id, e
                    );
                    None
                }
            }
        });
    }

    let results = futures::future::join_all(futures).await;
    let deposits: Vec<StorageDepositResponse> = results.into_iter().flatten().collect();

    Ok((StatusCode::OK, Json(deposits)))
}
