use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::query_as;
use sqlx::types::BigDecimal;
use sqlx::types::chrono::{DateTime, Utc};
use std::collections::HashMap;
use std::sync::Arc;

use crate::AppState;
use crate::handlers::balance_changes::{gap_filler, query_builder::*};
use crate::handlers::token::{TokenMetadata, fetch_tokens_metadata};

fn comma_separated<'de, D>(deserializer: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt: Option<String> = Option::deserialize(deserializer)?;
    Ok(opt.map(|s| s.split(',').map(|item| item.trim().to_string()).collect()))
}

#[derive(Debug, Deserialize)]
pub struct BalanceChangesQuery {
    pub account_id: String,

    // Pagination
    pub limit: Option<i64>,
    pub offset: Option<i64>,

    // Date Filtering
    pub start_time: Option<String>, // ISO 8601 format
    pub end_time: Option<String>,   // ISO 8601 format

    // Token Filtering (Whitelist OR Blacklist)
    #[serde(default, deserialize_with = "comma_separated")]
    pub token_ids: Option<Vec<String>>, // Include ONLY these (whitelist)
    #[serde(default, deserialize_with = "comma_separated")]
    pub exclude_token_ids: Option<Vec<String>>, // Exclude these (blacklist)

    // Transaction Type Filtering (can select multiple)
    #[serde(default, deserialize_with = "comma_separated")]
    pub transaction_types: Option<Vec<String>>, // "incoming", "outgoing", "staking_rewards"

    // Amount Filtering (decimal-adjusted, requires single token filter)
    pub min_amount: Option<f64>, // Minimum amount in decimal-adjusted format (e.g., 1.5 NEAR)
    pub max_amount: Option<f64>, // Maximum amount in decimal-adjusted format (e.g., 100 USDC)

    // Metadata
    pub include_metadata: Option<bool>, // default: false (enrich with token metadata + prices)
}

#[derive(Debug, Serialize, sqlx::FromRow)]
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

/// Enriched balance change with optional metadata
#[derive(Debug, Serialize, Clone)]
pub struct EnrichedBalanceChange {
    pub id: i64,
    pub account_id: String,
    pub block_height: i64,
    pub block_time: DateTime<Utc>,
    pub token_id: String, // Transformed: "near" for staking
    pub receipt_id: Vec<String>,
    pub transaction_hashes: Vec<String>,
    pub counterparty: Option<String>, // Transformed: pool address for staking
    pub signer_id: Option<String>,
    pub receiver_id: Option<String>,
    pub amount: BigDecimal,
    pub balance_before: BigDecimal,
    pub balance_after: BigDecimal,
    pub created_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_metadata: Option<TokenMetadata>, // Only present if include_metadata: true
}

// Helper function to fetch metadata for multiple tokens with fallback
async fn fetch_tokens_with_fallback(
    state: &Arc<AppState>,
    token_ids: &[String],
) -> HashMap<String, TokenMetadata> {
    if token_ids.is_empty() {
        return HashMap::new();
    }

    // Helper to transform database token ID to defuse asset ID format
    let transform_to_defuse = |token_id: &str| -> String {
        if token_id == "near" {
            "nep141:wrap.near".to_string()
        } else if let Some(stripped) = token_id.strip_prefix("intents.near:") {
            stripped.to_string()
        } else {
            format!("nep141:{}", token_id)
        }
    };

    // Remove duplicates
    let unique_tokens: Vec<String> = token_ids
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    // Transform to defuse format
    let defuse_ids: Vec<String> = unique_tokens
        .iter()
        .map(|id| transform_to_defuse(id))
        .collect();

    // Fetch from API
    let metadata_from_api = match fetch_tokens_metadata(state, &defuse_ids).await {
        Ok(metadata) => metadata,
        Err(e) => {
            log::error!("Failed to fetch metadata from API: {:?}", e);
            Vec::new()
        }
    };

    // Build map keyed by defuse ID
    let metadata_map: HashMap<String, TokenMetadata> = metadata_from_api
        .into_iter()
        .map(|meta| (meta.token_id.clone(), meta))
        .collect();

    // For each requested token, look up or use fallback
    let mut result = HashMap::new();

    for token_id in &unique_tokens {
        let lookup_key = transform_to_defuse(token_id);
        let metadata = if let Some(meta) = metadata_map.get(&lookup_key) {
            meta.clone()
        } else {
            if token_id == "near" || token_id.starts_with("nep141:wrap.near") {
                // NEAR fallback
                TokenMetadata {
                    token_id: "near".to_string(),
                    name: "NEAR".to_string(),
                    symbol: "NEAR".to_string(),
                    decimals: 24,
                    icon: Some("https://assets.ref.finance/images/near.png".to_string()),
                    price: None,
                    price_updated_at: None,
                    network: Some("near".to_string()),
                    chain_name: Some("Near Protocol".to_string()),
                    chain_icons: None,
                }
            } else {
                // Generic fallback
                let symbol = token_id
                    .split('.')
                    .next()
                    .unwrap_or(token_id)
                    .to_uppercase();
                TokenMetadata {
                    token_id: token_id.to_string(),
                    name: symbol.clone(),
                    symbol,
                    decimals: 18,
                    icon: None,
                    price: None,
                    price_updated_at: None,
                    network: Some("near".to_string()),
                    chain_name: Some("Near Protocol".to_string()),
                    chain_icons: None,
                }
            }
        };
        result.insert(token_id.clone(), metadata);
    }

    result
}

/// Internal function to fetch and enrich balance changes
/// This is the single source of truth for all balance change queries
pub async fn get_balance_changes_internal(
    state: &Arc<AppState>,
    params: &BalanceChangesQuery,
) -> Result<Vec<EnrichedBalanceChange>, Box<dyn std::error::Error + Send + Sync>> {
    // Parse dates
    let start_date = params
        .start_time
        .as_ref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc));

    let end_date = params
        .end_time
        .as_ref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc));

    // Convert decimal-adjusted min/max amounts to raw token units
    // This only works when filtering by a single token
    let (min_amount_raw, max_amount_raw) =
        if params.min_amount.is_some() || params.max_amount.is_some() {
            // Require single token for min/max amount filtering
            if let Some(ref tokens) = params.token_ids {
                if tokens.len() == 1 {
                    let token_id = &tokens[0];

                    // Fetch metadata to get decimals using the helper function
                    let metadata_map = fetch_tokens_with_fallback(state, &[token_id.clone()]).await;
                    let metadata = metadata_map.get(token_id);

                    let decimals = metadata.map(|m| m.decimals).unwrap_or(24); // Default to NEAR decimals
                    let multiplier = 10_f64.powi(decimals as i32);

                    let min_raw = params.min_amount.map(|v| v * multiplier);
                    let max_raw = params.max_amount.map(|v| v * multiplier);

                    (min_raw, max_raw)
                } else {
                    // Multiple tokens - can't determine decimals
                    (None, None)
                }
            } else {
                // No token filter - can't determine decimals
                (None, None)
            }
        } else {
            (None, None)
        };

    // Build filters
    let filters = BalanceChangeFilters {
        account_id: params.account_id.clone(),
        date_cutoff: None, // Only used by recent activity/export with plan limits
        start_date,
        end_date,
        token_ids: params.token_ids.clone(),
        exclude_token_ids: params.exclude_token_ids.clone(),
        transaction_types: params.transaction_types.clone(),
        min_amount: min_amount_raw,
        max_amount: max_amount_raw,
    };

    // Build SQL query
    let select_fields = "id, account_id, block_height, block_time, token_id, receipt_id, transaction_hashes, counterparty, signer_id, receiver_id, amount, balance_before, balance_after, created_at";
    let (query_str, _next_param_idx) = build_select_query(
        &filters,
        select_fields,
        "block_height DESC, id DESC",
        true, // with pagination
    );

    // Bind parameters
    let limit = params.limit.unwrap_or(100).min(1000);
    let offset = params.offset.unwrap_or(0);

    let mut query = query_as::<_, BalanceChange>(&query_str).bind(&filters.account_id);

    // Bind date filters in order
    if let Some(ref cutoff) = filters.date_cutoff {
        query = query.bind(cutoff);
    }
    if let Some(ref start) = filters.start_date {
        query = query.bind(start);
    }
    if let Some(ref end) = filters.end_date {
        query = query.bind(end);
    }

    // Bind token filters
    if let Some(ref tokens) = filters.token_ids {
        query = query.bind(tokens);
    } else if let Some(ref exclude_tokens) = filters.exclude_token_ids {
        query = query.bind(exclude_tokens);
    }

    // Bind amount filters
    if let Some(min) = filters.min_amount {
        query = query.bind(min);
    }
    if let Some(max) = filters.max_amount {
        query = query.bind(max);
    }

    // Bind pagination
    query = query.bind(limit).bind(offset);

    // Execute query
    let changes = query.fetch_all(&state.db_pool).await?;

    // Transform staking tokens and prepare for enrichment
    let mut enriched_changes: Vec<EnrichedBalanceChange> = changes
        .into_iter()
        .map(|change| {
            // Transform staking tokens
            let (token_id, counterparty) = if change.token_id.starts_with("staking:") {
                // Extract pool address from "staking:pool.near"
                let pool_address = change
                    .token_id
                    .strip_prefix("staking:")
                    .unwrap_or(&change.token_id);
                ("near".to_string(), Some(pool_address.to_string()))
            } else {
                (change.token_id.clone(), change.counterparty.clone())
            };

            EnrichedBalanceChange {
                id: change.id,
                account_id: change.account_id,
                block_height: change.block_height,
                block_time: change.block_time,
                token_id,
                receipt_id: change.receipt_id,
                transaction_hashes: change.transaction_hashes,
                counterparty,
                signer_id: change.signer_id,
                receiver_id: change.receiver_id,
                amount: change.amount,
                balance_before: change.balance_before,
                balance_after: change.balance_after,
                created_at: change.created_at,
                token_metadata: None, // Will be populated if include_metadata is true
            }
        })
        .collect();

    // Conditionally enrich with metadata (includes prices)
    if params.include_metadata.unwrap_or(false) {
        // Collect token IDs and fetch metadata with fallbacks
        let token_ids: Vec<String> = enriched_changes
            .iter()
            .map(|c| c.token_id.clone())
            .collect();

        let metadata_map = fetch_tokens_with_fallback(state, &token_ids).await;

        // Attach metadata to each change
        for change in &mut enriched_changes {
            change.token_metadata = metadata_map.get(&change.token_id).cloned();
        }
    }

    Ok(enriched_changes)
}

pub async fn get_balance_changes(
    State(state): State<Arc<AppState>>,
    Query(params): Query<BalanceChangesQuery>,
) -> Result<Json<Vec<EnrichedBalanceChange>>, (StatusCode, Json<Value>)> {
    // Use internal function for all the logic
    let enriched_changes = get_balance_changes_internal(&state, &params)
        .await
        .map_err(|e| {
            log::error!("Failed to fetch balance changes: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "Failed to fetch balance changes",
                    "details": e.to_string()
                })),
            )
        })?;

    Ok(Json(enriched_changes))
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
