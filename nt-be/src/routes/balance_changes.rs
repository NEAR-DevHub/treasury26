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
use crate::handlers::balance_changes::completeness;
use crate::handlers::balance_changes::gap_filler;
use crate::handlers::token::{TokenMetadata, fetch_tokens_metadata};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceChangesQuery {
    pub account_id: String,
    pub token_id: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub exclude_snapshots: Option<bool>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BalanceChange {
    pub id: i64,
    pub account_id: String,
    pub block_height: i64,
    pub block_time: DateTime<Utc>,
    pub token_id: String,
    pub receipt_id: Vec<String>,
    pub transaction_hashes: Vec<String>,
    pub counterparty: Option<String>,
    pub signer_id: Option<String>,
    pub receiver_id: Option<String>,
    pub amount: BigDecimal,
    pub balance_before: BigDecimal,
    pub balance_after: BigDecimal,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceChangesResponse {
    pub data: Vec<BalanceChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentActivityResponse {
    pub data: Vec<RecentActivity>,
    pub total: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SwapInfo {
    pub sent_token_id: Option<String>,
    pub sent_amount: Option<BigDecimal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_token_metadata: Option<TokenMetadata>,
    pub received_token_id: String,
    pub received_amount: BigDecimal,
    pub received_token_metadata: TokenMetadata,
    pub solver_transaction_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentActivity {
    pub id: i64,
    pub block_time: DateTime<Utc>,
    pub token_id: String,
    pub token_metadata: TokenMetadata,
    pub counterparty: Option<String>,
    pub signer_id: Option<String>,
    pub receiver_id: Option<String>,
    pub amount: BigDecimal,
    pub transaction_hashes: Vec<String>,
    pub receipt_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap: Option<SwapInfo>,
}

pub async fn get_balance_changes(
    State(state): State<Arc<AppState>>,
    Query(params): Query<BalanceChangesQuery>,
) -> Result<Json<BalanceChangesResponse>, (StatusCode, Json<Value>)> {
    let limit = params.limit.unwrap_or(100).min(1000);
    let offset = params.offset.unwrap_or(0);
    let exclude_snapshots = params.exclude_snapshots.unwrap_or(false);

    let last_synced_at = fetch_last_synced_at(&state.db_pool, &params.account_id).await;

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
        Ok(data) => Ok(Json(BalanceChangesResponse {
            data,
            last_synced_at,
        })),
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
#[serde(rename_all = "camelCase")]
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

    let last_synced_at = fetch_last_synced_at(&state.db_pool, &params.account_id).await;

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

    fn resolve_metadata(
        token_id: &str,
        metadata_map: &std::collections::HashMap<String, TokenMetadata>,
    ) -> TokenMetadata {
        if token_id == "near" {
            return TokenMetadata {
                token_id: "near".to_string(),
                name: "NEAR Protocol".to_string(),
                symbol: "NEAR".to_string(),
                decimals: 24,
                icon: Some(
                    "https://s2.coinmarketcap.com/static/img/coins/128x128/6535.png".to_string(),
                ),
                price: None,
                price_updated_at: None,
                network: Some("near".to_string()),
                chain_name: Some("Near Protocol".to_string()),
                chain_icons: None,
            };
        }

        if let Some(lookup_id) = token_id_for_metadata(token_id) {
            metadata_map.get(&lookup_id).cloned().unwrap_or_else(|| {
                let symbol = token_id
                    .split('.')
                    .next()
                    .unwrap_or("UNKNOWN")
                    .to_uppercase();
                TokenMetadata {
                    token_id: token_id.to_string(),
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
            let symbol = token_id
                .split('.')
                .next()
                .unwrap_or("UNKNOWN")
                .to_uppercase();
            TokenMetadata {
                token_id: token_id.to_string(),
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
    }

    // Get total count (for pagination), excluding swap deposit legs
    let total = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)
        FROM balance_changes bc
        WHERE bc.account_id = $1
          AND bc.counterparty NOT IN ('SNAPSHOT', 'STAKING_SNAPSHOT', 'STAKING_REWARD', 'NOT_REGISTERED')
          AND bc.id NOT IN (
            SELECT ds.deposit_balance_change_id
            FROM detected_swaps ds
            WHERE ds.account_id = $1
              AND ds.deposit_balance_change_id IS NOT NULL
          )
        "#,
    )
    .bind(&params.account_id)
    .fetch_one(&state.db_pool)
    .await
    .unwrap_or(0);

    // Fetch recent balance changes, excluding swap deposit legs
    let changes = sqlx::query_as::<_, BalanceChange>(
        r#"
        SELECT id, account_id, block_height, block_time, token_id,
               receipt_id, transaction_hashes, counterparty, signer_id, receiver_id,
               amount, balance_before, balance_after, created_at
        FROM balance_changes bc
        WHERE bc.account_id = $1
          AND bc.counterparty NOT IN ('SNAPSHOT', 'STAKING_SNAPSHOT', 'STAKING_REWARD', 'NOT_REGISTERED')
          AND bc.id NOT IN (
            SELECT ds.deposit_balance_change_id
            FROM detected_swaps ds
            WHERE ds.account_id = $1
              AND ds.deposit_balance_change_id IS NOT NULL
          )
        ORDER BY bc.block_height DESC, bc.id DESC
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

    // Look up detected swaps for fulfillment IDs on this page
    let change_ids: Vec<i64> = changes.iter().map(|c| c.id).collect();

    #[derive(Debug)]
    struct SwapRecord {
        fulfillment_balance_change_id: i64,
        sent_token_id: Option<String>,
        sent_amount: Option<BigDecimal>,
        received_token_id: String,
        received_amount: BigDecimal,
        solver_transaction_hash: String,
    }

    let swap_records = sqlx::query_as!(
        SwapRecord,
        r#"
        SELECT
            fulfillment_balance_change_id,
            sent_token_id,
            sent_amount,
            received_token_id,
            received_amount,
            solver_transaction_hash
        FROM detected_swaps
        WHERE account_id = $1
          AND fulfillment_balance_change_id = ANY($2)
        "#,
        &params.account_id,
        &change_ids,
    )
    .fetch_all(&state.db_pool)
    .await
    .unwrap_or_default();

    // Build swap lookup map
    let swap_map: std::collections::HashMap<i64, SwapRecord> = swap_records
        .into_iter()
        .map(|s| (s.fulfillment_balance_change_id, s))
        .collect();

    // Get unique token IDs for metadata (from balance changes + swap tokens)
    let mut token_id_set: std::collections::HashSet<String> = changes
        .iter()
        .filter_map(|c| token_id_for_metadata(&c.token_id))
        .collect();

    for swap in swap_map.values() {
        if let Some(meta_id) = swap
            .sent_token_id
            .as_ref()
            .and_then(|id| token_id_for_metadata(id))
        {
            token_id_set.insert(meta_id);
        }
        if let Some(meta_id) = token_id_for_metadata(&swap.received_token_id) {
            token_id_set.insert(meta_id);
        }
    }

    let token_ids: Vec<String> = token_id_set.into_iter().collect();

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

    // Build metadata map
    let mut metadata_map: std::collections::HashMap<String, TokenMetadata> =
        std::collections::HashMap::new();
    for meta in tokens_metadata {
        metadata_map.insert(meta.token_id.clone(), meta);
    }

    // Enrich balance changes with token metadata and swap info
    let activities: Vec<RecentActivity> = changes
        .into_iter()
        .map(|change| {
            let token_metadata = resolve_metadata(&change.token_id, &metadata_map);

            let swap = swap_map.get(&change.id).map(|s| {
                let sent_token_metadata = s
                    .sent_token_id
                    .as_ref()
                    .map(|id| resolve_metadata(id, &metadata_map));
                let received_token_metadata = resolve_metadata(&s.received_token_id, &metadata_map);

                SwapInfo {
                    sent_token_id: s.sent_token_id.clone(),
                    sent_amount: s.sent_amount.clone(),
                    sent_token_metadata,
                    received_token_id: s.received_token_id.clone(),
                    received_amount: s.received_amount.clone(),
                    received_token_metadata,
                    solver_transaction_hash: s.solver_transaction_hash.clone(),
                }
            });

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
                swap,
            }
        })
        .collect();

    Ok(Json(RecentActivityResponse {
        data: activities,
        total,
        last_synced_at,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FillGapsRequest {
    pub account_id: String,
    pub token_id: String,
    pub up_to_block: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
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

async fn fetch_last_synced_at(pool: &sqlx::PgPool, account_id: &str) -> Option<DateTime<Utc>> {
    sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
        "SELECT last_synced_at FROM monitored_accounts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten() // unwrap Option<Option<DateTime>> from fetch_optional
    .flatten() // unwrap Option<DateTime> from nullable column
}

async fn get_current_block_height(
    _network: &near_api::NetworkConfig,
) -> Result<u64, Box<dyn std::error::Error>> {
    let block = near_api::Chain::block().fetch_from_mainnet().await?;
    Ok(block.header.height)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletenessQuery {
    pub account_id: String,
}

pub async fn get_completeness(
    State(state): State<Arc<AppState>>,
    Query(params): Query<CompletenessQuery>,
) -> Result<Json<completeness::CompletenessResponse>, (StatusCode, Json<Value>)> {
    // Get current block height for gap detection
    let up_to_block = match get_current_block_height(&state.network).await {
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
    };

    match completeness::check_completeness(
        &state.db_pool,
        &state.archival_network,
        &params.account_id,
        up_to_block,
    )
    .await
    {
        Ok(response) => Ok(Json(response)),
        Err(e) => {
            log::error!("Failed to check completeness: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "Failed to check completeness",
                    "details": e.to_string()
                })),
            ))
        }
    }
}
