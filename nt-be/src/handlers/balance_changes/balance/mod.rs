//! Balance Query Services
//!
//! This module provides a unified interface for querying token balances at specific block heights.
//! Supports four token types:
//! - NEAR native tokens (via `near` submodule)
//! - Fungible Tokens/NEP-141 (via `ft` submodule)
//! - NEAR Intents multi-tokens (via `intents` submodule)
//! - Staking pool balances (via `staking` submodule)
//!
//! Uses the near-api crate with FastNEAR archival RPC for historical queries.

pub mod ft;
pub mod intents;
pub mod near;
pub mod staking;

use bigdecimal::BigDecimal;
use near_api::NetworkConfig;
use sqlx::PgPool;

/// Query balance at a specific block height for any token type
///
/// This is a convenience function that routes to the appropriate specialized function
/// based on the token_id format.
///
/// # Arguments
/// * `pool` - Database connection pool for querying token metadata (needed for FT tokens)
/// * `network` - The NEAR network configuration (use archival network for historical queries)
/// * `account_id` - The NEAR account to query
/// * `token_id` - Token identifier:
///   - "NEAR" or "near" for native NEAR tokens
///   - "contract:token_id" for NEAR Intents multi-tokens
///   - contract address for standard FT tokens
/// * `block_height` - The block height to query at
///
/// # Returns
/// The balance as a BigDecimal (for arbitrary precision with proper decimal places)
pub async fn get_balance_at_block(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    block_height: u64,
) -> Result<bigdecimal::BigDecimal, Box<dyn std::error::Error>> {
    get_balance_at_block_with_fallback(pool, network, account_id, token_id, block_height, 0).await
}

/// Query balance at a specific block height, falling back to earlier blocks on 422 errors
///
/// When `max_block_retries > 0`, retries with previous blocks if the archival RPC
/// returns 422 (block unavailable). This is useful for non-binary-search callers
/// where an approximate block is acceptable.
pub async fn get_balance_at_block_with_fallback(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    block_height: u64,
    max_block_retries: u64,
) -> Result<bigdecimal::BigDecimal, Box<dyn std::error::Error>> {
    for offset in 0..=max_block_retries {
        let current_block = block_height.saturating_sub(offset);
        tracing::info!(
            "Get balance at block {} {} {}",
            account_id,
            token_id,
            current_block
        );
        let result = if token_id == "NEAR" || token_id == "near" {
            near::get_balance_at_block(network, account_id, current_block).await
        } else if token_id.contains(':') {
            intents::get_balance_at_block(pool, network, account_id, token_id, current_block).await
        } else {
            ft::get_balance_at_block(pool, network, account_id, token_id, current_block).await
        };

        match result {
            Ok(balance) => {
                if offset > 0 {
                    tracing::warn!(
                        "Block {} unavailable for {} {}, used block {} instead (offset: {})",
                        block_height,
                        account_id,
                        token_id,
                        current_block,
                        offset
                    );
                }
                return Ok(balance);
            }
            Err(e) => {
                let err_str = e.to_string();
                if (err_str.contains("422")
                    || err_str.contains("UnknownBlock")
                    || err_str.contains("GarbageCollectedBlock"))
                    && offset < max_block_retries
                {
                    tracing::debug!(
                        "Block {} unavailable for {} {}, trying previous block",
                        current_block,
                        account_id,
                        token_id,
                    );
                    continue;
                }
                return Err(e);
            }
        }
    }
    unreachable!()
}

/// Query balance change at a specific block (both before and after)
///
/// # Arguments
/// * `pool` - Database connection pool for querying token metadata (needed for FT tokens)
/// * `network` - The NEAR network configuration (use archival network for historical queries)
/// * `account_id` - The NEAR account to query
/// * `token_id` - Token identifier (see `get_balance_at_block` for format)
/// * `block_height` - The block height to query at
///
/// # Returns
/// Tuple of (balance_before, balance_after) as BigDecimal values
pub async fn get_balance_change_at_block(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    block_height: u64,
) -> Result<(BigDecimal, BigDecimal), Box<dyn std::error::Error>> {
    // Query balance at this block and the previous, falling back to earlier blocks on 422
    let balance_after =
        get_balance_at_block_with_fallback(pool, network, account_id, token_id, block_height, 10)
            .await?;
    let balance_before = if block_height > 0 {
        get_balance_at_block_with_fallback(
            pool,
            network,
            account_id,
            token_id,
            block_height - 1,
            10,
        )
        .await?
    } else {
        BigDecimal::from(0)
    };

    Ok((balance_before, balance_after))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_utils::init_test_state;

    #[tokio::test]
    async fn test_query_mainnet_near_balance() {
        let state = init_test_state().await;

        // Block 151386339 from test data
        let balance = get_balance_at_block(
            &state.db_pool,
            &state.archival_network,
            "webassemblymusic-treasury.sputnik-dao.near",
            "NEAR",
            151386339,
        )
        .await
        .unwrap();

        // Expected balance after from test data (converted to NEAR from yoctoNEAR)
        use bigdecimal::BigDecimal;
        use std::str::FromStr;
        assert_eq!(balance, BigDecimal::from_str("5.6882211266305371").unwrap());
    }

    #[tokio::test]
    async fn test_query_balance_change() {
        // Add a small delay to avoid rate limiting when running multiple tests
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        let state = init_test_state().await;

        // Block 151386339 from test data with known before/after balances
        let (before, after) = get_balance_change_at_block(
            &state.db_pool,
            &state.archival_network,
            "webassemblymusic-treasury.sputnik-dao.near",
            "NEAR",
            151386339,
        )
        .await
        .unwrap();

        // From test data: balanceBefore and balanceAfter at block 151386339 (converted to NEAR)
        use bigdecimal::BigDecimal;
        use std::str::FromStr;
        assert_eq!(
            before,
            BigDecimal::from_str("0.688221126630537100000000").unwrap()
        );
        assert_eq!(
            after,
            BigDecimal::from_str("5.688221126630537100000000").unwrap()
        );
    }
}
