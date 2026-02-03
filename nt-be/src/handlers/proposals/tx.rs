use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use chrono::NaiveDate;
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

use crate::AppState;
use crate::utils::cache::{CacheKey, CacheTier};

#[derive(Deserialize, Debug)]
struct NearBlocksTransaction {
    actions: Vec<NearBlocksAction>,
    block: NearBlocksBlock,
    receipt_block: NearBlocksReceiptBlock,
    transaction_hash: String,
}

#[derive(Deserialize, Debug)]
struct NearBlocksAction {
    args: String,
    method: String,
}

#[derive(Deserialize, Debug)]
struct NearBlocksBlock {
    block_height: u64,
}

#[derive(Deserialize, Debug)]
struct NearBlocksReceiptBlock {
    block_timestamp: u64,
}

#[derive(Deserialize, Debug)]
struct NearBlocksResponse {
    txns: Vec<NearBlocksTransaction>,
}

#[derive(Serialize, Debug)]
pub struct ProposalTransactionResponse {
    pub transaction_hash: String,
    pub nearblocks_url: String,
    pub block_height: u64,
    pub timestamp: u64,
}

#[derive(Deserialize)]
pub struct TransactionQueryParams {
    #[serde(rename = "afterDate")]
    pub after_date: NaiveDate,
    #[serde(rename = "beforeDate")]
    pub before_date: NaiveDate,
    pub action: String,
}

async fn fetch_nearblocks_transactions(
    http_client: &reqwest::Client,
    api_key: &str,
    dao_id: &AccountId,
    method: &str,
    after_date: NaiveDate,
    before_date: NaiveDate,
) -> Result<Vec<NearBlocksTransaction>, (StatusCode, String)> {
    let url = format!(
        "https://api.nearblocks.io/v1/account/{}/receipts?method={}&after_date={}&before_date={}",
        dao_id, method, after_date, before_date
    );

    let response = http_client
        .get(&url)
        .header("accept", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| {
            log::error!("Failed to fetch from NearBlocks API: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch from external API".to_string(),
            )
        })?;

    if !response.status().is_success() {
        log::info!(
            "No transactions found or API error for method {}: {}",
            method,
            response.status()
        );
        return Ok(vec![]);
    }

    let data: NearBlocksResponse = response.json().await.map_err(|e| {
        log::error!("Failed to parse NearBlocks response: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to parse API response".to_string(),
        )
    })?;

    Ok(data.txns)
}

fn find_matching_transaction<'a>(
    txns: &'a [NearBlocksTransaction],
    proposal_id: u64,
    action_str: &str,
) -> Option<&'a NearBlocksTransaction> {
    txns.iter().find(|txn| {
        txn.actions.iter().any(|action| {
            let Ok(args) = serde_json::from_str::<serde_json::Value>(&action.args) else {
                return false;
            };

            match action.method.as_str() {
                "on_proposal_callback" => {
                    args.get("proposal_id").and_then(|v| v.as_u64()) == Some(proposal_id)
                }
                "act_proposal" => {
                    args.get("id").and_then(|v| v.as_u64()) == Some(proposal_id)
                        && args.get("action").and_then(|v| v.as_str()) == Some(action_str)
                }
                _ => false,
            }
        })
    })
}

/// Find the execution transaction for a proposal by querying NearBlocks API
pub async fn find_proposal_execution_transaction(
    State(state): State<Arc<AppState>>,
    Path((dao_id, proposal_id)): Path<(AccountId, u64)>,
    Query(params): Query<TransactionQueryParams>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, String)> {
    log::info!(
        "Searching for proposal {} execution between {} and {}",
        proposal_id,
        params.after_date,
        params.before_date
    );

    let Some(nearblocks_api_key) = state.env_vars.nearblocks_api_key.as_ref() else {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "NearBlocks API is not enabled".to_string(),
        ));
    };

    let cache_key = CacheKey::new("proposal-tx")
        .with(&dao_id)
        .with(proposal_id)
        .with(&params.action)
        .build();

    let http_client = state.http_client.clone();
    let api_key = nearblocks_api_key.clone();
    let dao_id_clone = dao_id.clone();
    let action = params.action.clone();
    let after_date = params.after_date;
    let before_date = params.before_date;

    state
        .cache
        .cached_json(CacheTier::LongTerm, cache_key, async move {
            if action == "VoteApprove" {
                // Try on_proposal_callback first
                let callback_txns = fetch_nearblocks_transactions(
                    &http_client,
                    &api_key,
                    &dao_id_clone,
                    "on_proposal_callback",
                    after_date,
                    before_date,
                )
                .await?;

                log::info!(
                    "Found {} on_proposal_callback transactions",
                    callback_txns.len()
                );

                if let Some(txn) = find_matching_transaction(&callback_txns, proposal_id, &action) {
                    log::info!("Found execution transaction: {}", txn.transaction_hash);
                    return Ok(ProposalTransactionResponse {
                        transaction_hash: txn.transaction_hash.clone(),
                        nearblocks_url: format!(
                            "https://nearblocks.io/txns/{}",
                            txn.transaction_hash
                        ),
                        block_height: txn.block.block_height,
                        timestamp: txn.receipt_block.block_timestamp,
                    });
                }
            }

            // Fallback to act_proposal if not found
            let act_proposal_txns = fetch_nearblocks_transactions(
                &http_client,
                &api_key,
                &dao_id_clone,
                "act_proposal",
                after_date,
                before_date,
            )
            .await?;

            log::info!(
                "Found {} act_proposal transactions",
                act_proposal_txns.len()
            );

            if let Some(txn) = find_matching_transaction(&act_proposal_txns, proposal_id, &action) {
                log::info!("Found execution transaction: {}", txn.transaction_hash);
                return Ok(ProposalTransactionResponse {
                    transaction_hash: txn.transaction_hash.clone(),
                    nearblocks_url: format!("https://nearblocks.io/txns/{}", txn.transaction_hash),
                    block_height: txn.block.block_height,
                    timestamp: txn.receipt_block.block_timestamp,
                });
            }

            log::info!(
                "No execution transaction found for proposal {}",
                proposal_id
            );
            Err((
                StatusCode::NOT_FOUND,
                format!(
                    "No execution transaction found for proposal {}",
                    proposal_id
                ),
            ))
        })
        .await
}

// Receipt search types and endpoint

#[derive(Deserialize, Debug)]
struct NearBlocksReceiptSearchResponse {
    receipts: Vec<NearBlocksReceiptInfo>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct NearBlocksReceiptInfo {
    pub receipt_id: String,
    pub originated_from_transaction_hash: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ReceiptSearchResult {
    #[serde(rename = "receiptId")]
    pub receipt_id: String,
    #[serde(rename = "originatedFromTransactionHash")]
    pub originated_from_transaction_hash: String,
}

#[derive(Deserialize)]
pub struct ReceiptSearchQuery {
    pub keyword: String,
}

/// Search for a receipt by keyword (receipt ID) and return the originating transaction hash
pub async fn search_receipt(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ReceiptSearchQuery>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, String)> {
    let Some(nearblocks_api_key) = state.env_vars.nearblocks_api_key.as_ref() else {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "NearBlocks API is not enabled".to_string(),
        ));
    };

    let cache_key = CacheKey::new("receipt-search")
        .with(&params.keyword)
        .build();

    let http_client = state.http_client.clone();
    let api_key = nearblocks_api_key.clone();
    let keyword = params.keyword.clone();

    state
        .cache
        .cached_json(CacheTier::LongTerm, cache_key, async move {
            let url = format!(
                "https://api.nearblocks.io/v1/search/receipts?keyword={}",
                keyword
            );

            let response = http_client
                .get(&url)
                .header("accept", "application/json")
                .header("Authorization", format!("Bearer {}", api_key))
                .send()
                .await
                .map_err(|e| {
                    log::error!("Failed to fetch from NearBlocks receipt search API: {}", e);
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Failed to fetch from external API".to_string(),
                    )
                })?;

            if !response.status().is_success() {
                log::error!("NearBlocks receipt search API error: {}", response.status());
                return Err((
                    StatusCode::from_u16(response.status().as_u16())
                        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                    "Receipt search failed".to_string(),
                ));
            }
            let data = response.json().await;

            println!("data: {:?}", data);

            let data: NearBlocksReceiptSearchResponse = data.map_err(|e| {
                log::error!("Failed to parse NearBlocks receipt search response: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to parse API response".to_string(),
                )
            })?;

            Ok::<_, (StatusCode, String)>(
                data.receipts
                    .into_iter()
                    .map(|r| ReceiptSearchResult {
                        receipt_id: r.receipt_id,
                        originated_from_transaction_hash: r.originated_from_transaction_hash,
                    })
                    .collect::<Vec<ReceiptSearchResult>>(),
            )
        })
        .await
}
