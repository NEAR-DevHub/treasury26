use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::types::BigDecimal;
use sqlx::types::chrono::{DateTime, Utc};
use std::sync::Arc;

use crate::AppState;
use crate::handlers::balance_changes::gap_filler;
use crate::handlers::token::{TokenMetadata, fetch_tokens_metadata};

#[derive(Debug, Deserialize)]
pub struct BalanceChangesQuery {
    pub account_id: String,
    pub token_id: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub exclude_snapshots: Option<bool>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct BalanceChange {
    pub id: i64,
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "blockHeight")]
    pub block_height: i64,
    #[serde(rename = "blockTime")]
    pub block_time: DateTime<Utc>,
    #[serde(rename = "tokenId")]
    pub token_id: String,
    #[serde(rename = "receiptId")]
    pub receipt_id: Vec<String>,
    #[serde(rename = "transactionHashes")]
    pub transaction_hashes: Vec<String>,
    #[serde(rename = "counterparty")]
    pub counterparty: Option<String>,
    #[serde(rename = "signerId")]
    pub signer_id: Option<String>,
    #[serde(rename = "receiverId")]
    pub receiver_id: Option<String>,
    pub amount: BigDecimal,
    #[serde(rename = "balanceBefore")]
    pub balance_before: BigDecimal,
    #[serde(rename = "balanceAfter")]
    pub balance_after: BigDecimal,
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct RecentActivityResponse {
    pub data: Vec<RecentActivity>,
    pub total: i64,
}

#[derive(Debug, Serialize)]
pub struct RecentActivity {
    pub id: i64,
    pub block_time: DateTime<Utc>,
    #[serde(rename = "tokenId")]
    pub token_id: String,
    #[serde(rename = "tokenMetadata")]
    pub token_metadata: TokenMetadata,
    pub counterparty: Option<String>,
    #[serde(rename = "signerId")]
    pub signer_id: Option<String>,
    #[serde(rename = "receiverId")]
    pub receiver_id: Option<String>,
    pub amount: BigDecimal,
    #[serde(rename = "transactionHashes")]
    pub transaction_hashes: Vec<String>,
    #[serde(rename = "receiptIds")]
    pub receipt_ids: Vec<String>,
}

pub async fn get_balance_changes(
    State(state): State<Arc<AppState>>,
    Query(params): Query<BalanceChangesQuery>,
) -> Result<Json<Vec<BalanceChange>>, (StatusCode, Json<Value>)> {
    let limit = params.limit.unwrap_or(100).min(1000);
    let offset = params.offset.unwrap_or(0);
    let exclude_snapshots = params.exclude_snapshots.unwrap_or(false);

    let changes = if let Some(token_id) = params.token_id {
        sqlx::query_as::<_, BalanceChange>(
            r#"
            SELECT id, account_id, block_height, block_time, token_id, 
                   receipt_id, transaction_hashes, counterparty, signer_id, receiver_id,
                   amount, balance_before, balance_after, created_at
            FROM balance_changes
            WHERE account_id = $1 AND token_id = $2
              AND (NOT $5::bool OR counterparty NOT IN ('SNAPSHOT', 'STAKING_SNAPSHOT'))
            ORDER BY block_height DESC, id DESC
            LIMIT $3 OFFSET $4
            "#,
        )
        .bind(&params.account_id)
        .bind(&token_id)
        .bind(limit)
        .bind(offset)
        .bind(exclude_snapshots)
        .fetch_all(&state.db_pool)
        .await
    } else {
        sqlx::query_as::<_, BalanceChange>(
            r#"
            SELECT id, account_id, block_height, block_time, token_id, 
                   receipt_id, transaction_hashes, counterparty, signer_id, receiver_id,
                   amount, balance_before, balance_after, created_at
            FROM balance_changes
            WHERE account_id = $1
              AND (NOT $2::bool OR counterparty NOT IN ('SNAPSHOT', 'STAKING_SNAPSHOT'))
            ORDER BY block_height DESC, id DESC
            LIMIT $3 OFFSET $4
            "#,
        )
        .bind(&params.account_id)
        .bind(exclude_snapshots)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db_pool)
        .await
    };

    match changes {
        Ok(data) => Ok(Json(data)),
        Err(e) => {
            log::error!("Failed to fetch balance changes: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "Failed to fetch balance changes",
                    "details": e.to_string()
                })),
            ))
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct RecentActivityQuery {
    pub account_id: String,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

pub async fn get_recent_activity(
    State(state): State<Arc<AppState>>,
    Query(params): Query<RecentActivityQuery>,
) -> Result<Json<RecentActivityResponse>, (StatusCode, Json<Value>)> {
    let limit = params.limit.unwrap_or(50).min(100);
    let offset = params.offset.unwrap_or(0);

    // Helper function to convert token_id to metadata API format
    fn token_id_for_metadata(token_id: &str) -> Option<String> {
        // Skip native NEAR - we have a fallback for it
        if token_id == "near" {
            return None;
        }

        Some(if token_id.starts_with("intents.near:") {
            // Strip "intents.near:" prefix for metadata API
            token_id.strip_prefix("intents.near:").unwrap().to_string()
        } else if token_id.starts_with("nep141:") || token_id.starts_with("nep245:") {
            token_id.to_string()
        } else {
            format!("nep141:{}", token_id)
        })
    }

    // Get total count (for pagination)
    let total = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)
        FROM balance_changes
        WHERE account_id = $1
          AND counterparty != 'SNAPSHOT'
                    AND counterparty != 'STAKING_SNAPSHOT'
          AND counterparty != 'NOT_REGISTERED'
        "#,
    )
    .bind(&params.account_id)
    .fetch_one(&state.db_pool)
    .await
    .unwrap_or(0);

    // Fetch recent balance changes (exclude SNAPSHOT and NOT_REGISTERED)
    let changes = sqlx::query_as::<_, BalanceChange>(
        r#"
        SELECT id, account_id, block_height, block_time, token_id, 
               receipt_id, transaction_hashes, counterparty, signer_id, receiver_id,
               amount, balance_before, balance_after, created_at
        FROM balance_changes
        WHERE account_id = $1
          AND counterparty != 'SNAPSHOT'
                    AND counterparty != 'STAKING_SNAPSHOT'
          AND counterparty != 'NOT_REGISTERED'
        ORDER BY block_height DESC, id DESC
        LIMIT $2 OFFSET $3
        "#,
    )
    .bind(&params.account_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db_pool)
    .await;

    let changes = match changes {
        Ok(data) => data,
        Err(e) => {
            log::error!("Failed to fetch recent activity: {}", e);
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "Failed to fetch recent activity",
                    "details": e.to_string()
                })),
            ));
        }
    };

    // Get unique token IDs (excluding native NEAR since we have a fallback)
    let token_ids: Vec<String> = changes
        .iter()
        .filter_map(|c| token_id_for_metadata(&c.token_id))
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    // Fetch token metadata using the token metadata handler
    let tokens_metadata = if !token_ids.is_empty() {
        fetch_tokens_metadata(&state, &token_ids)
            .await
            .map_err(|e| {
                log::error!("Failed to fetch token metadata: {:?}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "error": "Failed to fetch token metadata"
                    })),
                )
            })?
    } else {
        Vec::new()
    };

    // Build a map
    let mut metadata_map: std::collections::HashMap<String, TokenMetadata> =
        std::collections::HashMap::new();
    for meta in tokens_metadata {
        metadata_map.insert(meta.token_id.clone(), meta);
    }

    // Enrich balance changes with token metadata
    let activities: Vec<RecentActivity> = changes
        .into_iter()
        .map(|change| {
            let token_metadata = if change.token_id == "near" {
                // Use fallback for native NEAR (we didn't fetch metadata for it)
                TokenMetadata {
                    token_id: "near".to_string(),
                    name: "NEAR Protocol".to_string(),
                    symbol: "NEAR".to_string(),
                    decimals: 24,
                    icon: Some(
                        "https://s2.coinmarketcap.com/static/img/coins/128x128/6535.png"
                            .to_string(),
                    ),
                    price: None,
                    price_updated_at: None,
                    network: Some("near".to_string()),
                    chain_name: Some("Near Protocol".to_string()),
                    chain_icons: None,
                }
            } else {
                // Look up metadata
                if let Some(lookup_id) = token_id_for_metadata(&change.token_id) {
                    metadata_map.get(&lookup_id).cloned().unwrap_or_else(|| {
                        // Fallback - extract symbol from token ID
                        let symbol = change
                            .token_id
                            .split('.')
                            .next()
                            .unwrap_or("UNKNOWN")
                            .to_uppercase();
                        TokenMetadata {
                            token_id: change.token_id.clone(),
                            name: symbol.clone(),
                            symbol,
                            decimals: 18,
                            icon: None,
                            price: None,
                            price_updated_at: None,
                            network: None,
                            chain_name: None,
                            chain_icons: None,
                        }
                    })
                } else {
                    // This shouldn't happen, but provide a fallback anyway
                    let symbol = change
                        .token_id
                        .split('.')
                        .next()
                        .unwrap_or("UNKNOWN")
                        .to_uppercase();
                    TokenMetadata {
                        token_id: change.token_id.clone(),
                        name: symbol.clone(),
                        symbol,
                        decimals: 18,
                        icon: None,
                        price: None,
                        price_updated_at: None,
                        network: None,
                        chain_name: None,
                        chain_icons: None,
                    }
                }
            };

            RecentActivity {
                id: change.id,
                block_time: change.block_time,
                token_id: change.token_id,
                token_metadata,
                counterparty: change.counterparty,
                signer_id: change.signer_id,
                receiver_id: change.receiver_id,
                amount: change.amount,
                receipt_ids: change.receipt_id,
                transaction_hashes: change.transaction_hashes,
            }
        })
        .collect();

    Ok(Json(RecentActivityResponse {
        data: activities,
        total,
    }))
}

#[derive(Debug, Deserialize)]
pub struct FillGapsRequest {
    pub account_id: String,
    pub token_id: String,
    pub up_to_block: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct FillGapsResponse {
    pub gaps_filled: usize,
    pub account_id: String,
    pub token_id: String,
    pub up_to_block: i64,
}

pub async fn fill_gaps(
    State(state): State<Arc<AppState>>,
    Json(params): Json<FillGapsRequest>,
) -> Result<Json<FillGapsResponse>, (StatusCode, Json<Value>)> {
    // Get current block height from RPC if not specified
    let up_to_block = if let Some(block) = params.up_to_block {
        block
    } else {
        // Query current block height from RPC
        match get_current_block_height(&state.network).await {
            Ok(height) => height as i64,
            Err(e) => {
                log::error!("Failed to get current block height: {}", e);
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "error": "Failed to get current block height",
                        "details": e.to_string()
                    })),
                ));
            }
        }
    };

    log::info!(
        "fill_gaps request: account={}, token={}, up_to_block={}",
        params.account_id,
        params.token_id,
        up_to_block
    );

    match gap_filler::fill_gaps(
        &state.db_pool,
        &state.archival_network,
        &params.account_id,
        &params.token_id,
        up_to_block,
    )
    .await
    {
        Ok(filled) => Ok(Json(FillGapsResponse {
            gaps_filled: filled.len(),
            account_id: params.account_id,
            token_id: params.token_id,
            up_to_block,
        })),
        Err(e) => {
            log::error!("Failed to fill gaps: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "Failed to fill gaps",
                    "details": e.to_string()
                })),
            ))
        }
    }
}

async fn get_current_block_height(
    _network: &near_api::NetworkConfig,
) -> Result<u64, Box<dyn std::error::Error>> {
    let block = near_api::Chain::block().fetch_from_mainnet().await?;
    Ok(block.header.height)
}
