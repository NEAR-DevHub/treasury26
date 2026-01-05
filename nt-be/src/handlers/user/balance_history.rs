use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use near_api::{AccountId, Chain, FTBalance, Reference, Tokens, W_NEAR_BALANCE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use crate::{
    AppState,
    constants::BLOCKS_PER_HOUR,
    utils::cache::{CacheKey, CacheTier},
};

#[derive(Deserialize)]
pub struct TokenBalanceHistoryQuery {
    #[serde(rename = "accountId")]
    pub account_id: AccountId,
    #[serde(rename = "tokenId")]
    pub token_id: AccountId,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BalanceHistoryEntry {
    pub timestamp: u64,
    pub date: String,
    pub balance: String,
    pub decimals: u8,
}

/// Period configuration for balance history
struct Period {
    name: &'static str,
    hours: u64,
    interval: u64,
}

impl Period {
    const DEFAULT: &[Period] = &[
        Period {
            name: "1Y",
            hours: 24 * 365,
            interval: 12,
        },
        Period {
            name: "1M",
            hours: 24 * 30,
            interval: 15,
        },
        Period {
            name: "1W",
            hours: 24 * 7,
            interval: 8,
        },
        Period {
            name: "1D",
            hours: 24,
            interval: 12,
        },
        Period {
            name: "1H",
            hours: 1,
            interval: 6,
        },
        Period {
            name: "All",
            hours: 24 * 365 * 2,
            interval: 20,
        },
    ];

    pub fn format_timestamp(&self, timestamp_ms: u64) -> String {
        let timestamp_sec = timestamp_ms / 1000;
        match self.name {
            "1H" | "1D" => {
                // Format as HH:MM
                let datetime =
                    chrono::DateTime::from_timestamp(timestamp_sec as i64, 0).unwrap_or_default();
                datetime.format("%H:%M").to_string()
            }
            "1W" | "1M" => {
                // Format as MMM DD
                let datetime =
                    chrono::DateTime::from_timestamp(timestamp_sec as i64, 0).unwrap_or_default();
                datetime.format("%b %d").to_string()
            }
            "1Y" | "All" => {
                // Format as MMM YYYY
                let datetime =
                    chrono::DateTime::from_timestamp(timestamp_sec as i64, 0).unwrap_or_default();
                datetime.format("%b %Y").to_string()
            }
            _ => timestamp_ms.to_string(),
        }
    }
}

/// Fetches current block height and timestamp
async fn fetch_current_block(state: &Arc<AppState>) -> Result<(u64, u64), (StatusCode, String)> {
    let block = Chain::block()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching current block: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch current block: {}", e),
            )
        })?;

    Ok((block.header.height, block.header.timestamp / 1_000_000))
}

/// Fetches the timestamp for a specific block
async fn fetch_block_timestamp(
    state: &Arc<AppState>,
    block_height: u64,
) -> Result<u64, (StatusCode, String)> {
    let block = Chain::block()
        .at(Reference::AtBlock(block_height))
        .fetch_from(&state.archival_network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching block {}: {}", block_height, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch block {}: {}", block_height, e),
            )
        })?;

    Ok(block.header.timestamp / 1_000_000)
}

/// Fetches NEAR balance for an account at a specific block
async fn fetch_near_balance(
    state: &Arc<AppState>,
    account_id: AccountId,
    block_height: u64,
) -> Result<FTBalance, (StatusCode, String)> {
    let balance = Tokens::account(account_id.clone())
        .near_balance()
        .at(Reference::AtBlock(block_height))
        .fetch_from(&state.archival_network)
        .await
        .map_err(|e| {
            eprintln!(
                "Error fetching near balance for {} at block {}: {}",
                account_id, block_height, e
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch token balance: {}", e),
            )
        })?;

    Ok(W_NEAR_BALANCE.with_amount(balance.total.as_yoctonear()))
}

/// Fetches fungible token balance for an account at a specific block
async fn fetch_ft_balance(
    state: &Arc<AppState>,
    account_id: AccountId,
    token_id: AccountId,
    block_height: u64,
) -> Result<FTBalance, (StatusCode, String)> {
    let balance = Tokens::account(account_id.clone())
        .ft_balance(token_id.clone())
        .at(Reference::AtBlock(block_height))
        .fetch_from(&state.archival_network)
        .await
        .map_err(|e| {
            eprintln!(
                "Error fetching ft_balance_of for {} on {} at block {}: {}",
                account_id, token_id, block_height, e
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch token balance: {}", e),
            )
        })?;

    Ok(balance)
}

/// Fetches balance history for a single period
async fn fetch_period_history(
    state: &Arc<AppState>,
    account_id: AccountId,
    token_id: AccountId,
    period: &Period,
    current_block: u64,
) -> Result<Vec<BalanceHistoryEntry>, (StatusCode, String)> {
    let hours_per_step = (period.hours as f64) / (period.interval as f64);
    let blocks_per_step = (hours_per_step * BLOCKS_PER_HOUR as f64).floor() as u64;

    let block_heights = (0..period.interval).map(|i| current_block - (blocks_per_step * i));

    // Fetch timestamps and balances for all blocks in parallel
    let is_near = token_id == "near";
    let futures: Vec<_> = block_heights
        .map(|block_height| {
            let state = state.clone();
            let account_id = account_id.clone();
            let token_id = token_id.clone();
            async move {
                let (timestamp_result, balance_result) = if is_near {
                    tokio::join!(
                        fetch_block_timestamp(&state, block_height),
                        fetch_near_balance(&state, account_id, block_height)
                    )
                } else {
                    tokio::join!(
                        fetch_block_timestamp(&state, block_height),
                        fetch_ft_balance(&state, account_id, token_id, block_height)
                    )
                };

                match (timestamp_result, balance_result) {
                    (Ok(timestamp), Ok(balance)) => Some((timestamp, balance)),
                    (a, b) => {
                        eprintln!("ERROR: {a:?}\n{b:?}");
                        None
                    }
                }
            }
        })
        .collect();

    let results = futures::future::join_all(futures).await;
    let entries: Vec<BalanceHistoryEntry> = results
        .into_iter()
        .flatten()
        .map(|(timestamp, balance)| BalanceHistoryEntry {
            timestamp,
            date: period.format_timestamp(timestamp),
            balance: balance.amount().to_string(),
            decimals: balance.decimals(),
        })
        .collect();

    Ok(entries)
}

/// Main handler for token balance history endpoint
pub async fn get_token_balance_history(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TokenBalanceHistoryQuery>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    let account_id = params.account_id.clone();
    let token_id = params.token_id.clone();

    let cache_key = CacheKey::new("balance-history")
        .with(&account_id)
        .with(&token_id)
        .build();

    state
        .clone()
        .cache
        .cached_json(CacheTier::LongTerm, cache_key, async move {
            // Fetch current block
            let (current_block, _current_timestamp) =
                fetch_current_block(&state).await.map_err(|e| e.1)?;

            // Fetch balance history for all periods concurrently
            let mut period_futures = Vec::new();
            for period in Period::DEFAULT {
                let state_clone = state.clone();
                let account_id = account_id.clone();
                let token_id = token_id.clone();

                period_futures.push(async move {
                    let result = fetch_period_history(
                        &state_clone,
                        account_id,
                        token_id,
                        period,
                        current_block,
                    )
                    .await;
                    (period.name, result)
                });
            }

            // Await all futures
            let period_results = futures::future::join_all(period_futures).await;

            // Build response map
            let mut response: HashMap<String, Vec<BalanceHistoryEntry>> = HashMap::new();

            for (period_name, result) in period_results {
                match result {
                    Ok(mut entries) => {
                        entries.sort_by_key(|e| e.timestamp);
                        response.insert(period_name.to_string(), entries);
                    }
                    Err(_) => {
                        // If a period fails, insert empty array
                        response.insert(period_name.to_string(), Vec::new());
                    }
                }
            }

            Ok::<_, String>(response)
        })
        .await
}
