use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::query_as;
use sqlx::types::BigDecimal;
use sqlx::types::chrono::{DateTime, Utc};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::handlers::balance_changes::completeness;
use crate::handlers::balance_changes::confidential_list;
use crate::handlers::balance_changes::public_list;
use crate::handlers::balance_changes::{gap_filler, query_builder::*};
use crate::handlers::token::{TokenMetadata, fetch_tokens_with_fallback};
use crate::utils::serde::comma_separated;
use crate::{AppState, auth::OptionalAuthUser};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceChangesQuery {
    pub account_id: AccountId,

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
    pub transaction_types: Option<Vec<String>>, // "incoming", "outgoing", "staking_rewards", "exchange"

    // Amount Filtering (decimal-adjusted, requires single token filter)
    pub min_amount: Option<f64>, // Minimum amount in decimal-adjusted format (e.g., 1.5 NEAR)
    pub max_amount: Option<f64>, // Maximum amount in decimal-adjusted format (e.g., 100 USDC)

    // Search filtering
    pub tx_hash: Option<String>, // Partial match against transaction hashes
    #[serde(default, deserialize_with = "comma_separated")]
    pub from_accounts: Option<Vec<String>>, // "From" account(s) filter
    #[serde(default, deserialize_with = "comma_separated")]
    pub from_accounts_not: Option<Vec<String>>, // Exclude these "From" account(s)
    #[serde(default, deserialize_with = "comma_separated")]
    pub to_accounts: Option<Vec<String>>, // "To" account(s) filter
    #[serde(default, deserialize_with = "comma_separated")]
    pub to_accounts_not: Option<Vec<String>>, // Exclude these "To" account(s)

    pub include_metadata: Option<bool>, // default: false (enrich with token metadata like symbol, name, decimals, icon)
    pub include_prices: Option<bool>, // default: false (fetch historical USD prices for transaction dates from DB; if missing, returns None)
    pub include_chain_metadata: Option<bool>, // default: false (enrich with chain/network metadata for cross-chain tokens)

    #[serde(skip)]
    pub exclude_near_dust: bool, // Filter out tiny NEAR amounts (< 0.01) — not a query param, set internally

    #[serde(skip)]
    pub exclude_swaps_from_direction: bool, // If true, "incoming" and "outgoing" exclude swaps (for UI tabs); if false, include swaps (for exports/API)
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
    pub action_kind: Option<String>,
    pub method_name: Option<String>,
    pub actions: Option<serde_json::Value>,
    pub usd_value: Option<BigDecimal>,
}

/// Swap information attached to balance changes
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SwapInfo {
    pub sent_token_id: Option<String>,
    pub sent_amount: Option<BigDecimal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_token_metadata: Option<TokenMetadata>,
    pub received_token_id: String,
    pub received_amount: Option<BigDecimal>,
    pub received_token_metadata: TokenMetadata,
    pub solver_transaction_hash: String,
}

/// Enriched balance change with optional metadata and swap info
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap: Option<SwapInfo>, // Only present for swap transactions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usd_value: Option<BigDecimal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proposal_id: Option<i64>,
}

/// Internal function to fetch and enrich balance changes
/// This is the single source of truth for all balance change queries
pub async fn get_balance_changes_internal(
    state: &Arc<AppState>,
    params: &BalanceChangesQuery,
) -> Result<Vec<EnrichedBalanceChange>, Box<dyn std::error::Error + Send + Sync>> {
    let is_confidential =
        confidential_list::is_confidential_dao(&state.db_pool, params.account_id.as_str()).await?;
    if is_confidential {
        return confidential_list::fetch_balance_change_legs(state, params).await;
    }

    let has_public_gold_rows: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM gold_public_history_events WHERE dao_id = $1)",
    )
    .bind(params.account_id.as_str())
    .fetch_one(&state.db_pool)
    .await?;

    if has_public_gold_rows {
        return public_list::fetch_balance_change_legs(state, params).await;
    }

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
    let (min_amount_raw, max_amount_raw) = if params.min_amount.is_some()
        || params.max_amount.is_some()
    {
        // Require single token for min/max amount filtering
        if let Some(ref tokens) = params.token_ids {
            if tokens.len() == 1 {
                let token_id = &tokens[0];

                // Fetch metadata to get decimals using the helper function
                let metadata_map: std::collections::HashMap<String, TokenMetadata> =
                    fetch_tokens_with_fallback(state, std::slice::from_ref(token_id), false, false)
                        .await;
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
        transaction_hash_query: params.tx_hash.clone(),
        from_accounts: params.from_accounts.clone(),
        from_accounts_not: params.from_accounts_not.clone(),
        to_accounts: params.to_accounts.clone(),
        to_accounts_not: params.to_accounts_not.clone(),
        exclude_near_dust: params.exclude_near_dust,
        exclude_swaps_from_direction: params.exclude_swaps_from_direction,
    };

    // Build SQL query
    let select_fields = "id, account_id, block_height, block_time, token_id, receipt_id, transaction_hashes, counterparty, signer_id, receiver_id, amount, balance_before, balance_after, created_at, action_kind, method_name, actions, usd_value";

    // Determine pagination based on whether limit is specified
    // For exports, limit is None and we want all records
    // For API queries, limit has a value (default 100, max 1000)
    let with_pagination = params.limit.is_some() || params.offset.is_some();

    let (query_str, _next_param_idx) = build_select_query(
        &filters,
        select_fields,
        "block_height DESC, id DESC",
        with_pagination,
    );

    let mut query = query_as::<_, BalanceChange>(&query_str).bind(filters.account_id.as_str());

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
    if let Some(ref tx_hash_query) = filters.transaction_hash_query {
        query = query.bind(format!("%{}%", tx_hash_query));
    }
    if let Some(ref from_accounts) = filters.from_accounts {
        query = query.bind(from_accounts);
    }
    if let Some(ref from_accounts_not) = filters.from_accounts_not {
        query = query.bind(from_accounts_not);
    }
    if let Some(ref to_accounts) = filters.to_accounts {
        query = query.bind(to_accounts);
    }
    if let Some(ref to_accounts_not) = filters.to_accounts_not {
        query = query.bind(to_accounts_not);
    }

    // Bind pagination only if we're using it
    if with_pagination {
        let limit = params
            .limit
            .expect("limit should be Some when with_pagination is true")
            .min(1000);
        let offset = params.offset.unwrap_or(0);
        query = query.bind(limit).bind(offset);
    }

    // Execute query
    let changes = query.fetch_all(&state.db_pool).await?;

    // Transform staking tokens and prepare for enrichment
    let mut enriched_changes: Vec<EnrichedBalanceChange> = changes
        .into_iter()
        .map(|change| {
            // Transform staking tokens: normalise token_id to "near",
            // replace counterparty with pool address, and tag action_kind
            // so the frontend can reliably identify staking rewards.
            let (token_id, counterparty, action_kind) = if change.token_id.starts_with("staking:") {
                let pool_address = change
                    .token_id
                    .strip_prefix("staking:")
                    .unwrap_or(&change.token_id);
                (
                    "near".to_string(),
                    Some(pool_address.to_string()),
                    Some("StakingReward".to_string()),
                )
            } else {
                (
                    change.token_id.clone(),
                    change.counterparty.clone(),
                    change.action_kind,
                )
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
                swap: None,           // Swap detection not implemented in this endpoint yet
                action_kind,
                method_name: change.method_name,
                actions: change.actions,
                usd_value: change.usd_value,
                proposal_id: None,
            }
        })
        .collect();

    // Conditionally enrich with metadata
    if params.include_metadata.unwrap_or(false) {
        // Collect token IDs and fetch metadata with fallbacks
        let token_ids: Vec<String> = enriched_changes
            .iter()
            .map(|c| c.token_id.clone())
            .collect();

        let metadata_map = fetch_tokens_with_fallback(
            state,
            &token_ids,
            params.include_chain_metadata.unwrap_or(false),
            false,
        )
        .await;

        // Attach metadata to each change
        for change in &mut enriched_changes {
            change.token_metadata = metadata_map.get(&change.token_id).cloned();
        }
    }

    // Conditionally enrich with historical prices
    if params.include_prices.unwrap_or(false) {
        // Group changes by token_id and collect unique dates
        let mut token_dates: HashMap<String, HashSet<chrono::NaiveDate>> = HashMap::new();

        for change in &enriched_changes {
            token_dates
                .entry(change.token_id.clone())
                .or_default()
                .insert(change.block_time.date_naive());
        }

        // Fetch prices for each token
        let mut all_prices: HashMap<String, HashMap<chrono::NaiveDate, f64>> = HashMap::new();

        for (token_id, dates) in token_dates {
            let dates_vec: Vec<chrono::NaiveDate> = dates.into_iter().collect();
            match state
                .price_service
                .get_prices_batch(&token_id, &dates_vec)
                .await
            {
                Ok(prices) => {
                    all_prices.insert(token_id, prices);
                }
                Err(e) => {
                    tracing::warn!("Failed to fetch prices for {}: {}", token_id, e);
                }
            }
        }

        // Attach prices to metadata
        for change in &mut enriched_changes {
            if let Some(ref mut metadata) = change.token_metadata {
                let change_date = change.block_time.date_naive();
                if let Some(token_prices) = all_prices.get(&change.token_id)
                    && let Some(&price) = token_prices.get(&change_date)
                {
                    metadata.price = Some(price);
                }
            }
        }
    }

    Ok(enriched_changes)
}

pub async fn get_balance_changes(
    State(state): State<Arc<AppState>>,
    user: OptionalAuthUser,
    Query(mut params): Query<BalanceChangesQuery>,
) -> Result<Json<Vec<EnrichedBalanceChange>>, (StatusCode, Json<Value>)> {
    user.verify_member_if_confidential(&state.db_pool, &params.account_id)
        .await
        .map_err(|(status, message)| (status, Json(serde_json::json!({ "error": message }))))?;

    // Apply default limit for public API if not specified
    if params.limit.is_none() {
        params.limit = Some(100);
    }

    let enriched_changes = get_balance_changes_internal(&state, &params)
        .await
        .map_err(|e| {
            tracing::error!("Failed to fetch balance changes: {}", e);
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
#[serde(rename_all = "camelCase")]
pub struct FillGapsRequest {
    pub account_id: AccountId,
    pub token_id: String,
    pub up_to_block: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FillGapsResponse {
    pub gaps_filled: usize,
    pub account_id: AccountId,
    pub token_id: String,
    pub up_to_block: i64,
}

pub async fn fill_gaps(
    State(state): State<Arc<AppState>>,
    user: OptionalAuthUser,
    Json(params): Json<FillGapsRequest>,
) -> Result<Json<FillGapsResponse>, (StatusCode, Json<Value>)> {
    user.verify_member_if_confidential(&state.db_pool, &params.account_id)
        .await
        .map_err(|(status, message)| (status, Json(serde_json::json!({ "error": message }))))?;

    // Get current block height from RPC if not specified
    let up_to_block = if let Some(block) = params.up_to_block {
        block
    } else {
        // Query current block height from RPC
        match get_current_block_height(&state.network).await {
            Ok(height) => height as i64,
            Err(e) => {
                tracing::error!("Failed to get current block height: {}", e);
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

    tracing::info!(
        "fill_gaps request: account={}, token={}, up_to_block={}",
        params.account_id,
        params.token_id,
        up_to_block
    );

    match gap_filler::fill_gaps(
        &state.db_pool,
        &state.archival_network,
        params.account_id.as_str(),
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
            tracing::error!("Failed to fill gaps: {}", e);
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletenessQuery {
    pub account_id: AccountId,
    /// Start of the time range (ISO 8601)
    pub from: DateTime<Utc>,
    /// End of the time range (ISO 8601)
    pub to: DateTime<Utc>,
}

pub async fn get_completeness(
    State(state): State<Arc<AppState>>,
    user: OptionalAuthUser,
    Query(params): Query<CompletenessQuery>,
) -> Result<Json<completeness::CompletenessResponse>, (StatusCode, Json<Value>)> {
    user.verify_member_if_confidential(&state.db_pool, &params.account_id)
        .await
        .map_err(|(status, message)| (status, Json(serde_json::json!({ "error": message }))))?;

    match completeness::check_completeness(
        &state.db_pool,
        &params.account_id,
        params.from,
        params.to,
    )
    .await
    {
        Ok(response) => Ok(Json(response)),
        Err(e) => {
            tracing::error!("Failed to check completeness: {}", e);
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
