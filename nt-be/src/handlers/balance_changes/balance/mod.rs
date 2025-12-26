//! Balance Query Services
//!
//! This module provides a unified interface for querying token balances at specific block heights.
//! Supports three token types:
//! - NEAR native tokens (via `near` submodule)
//! - Fungible Tokens/NEP-141 (via `ft` submodule)
//! - NEAR Intents multi-tokens (via `intents` submodule)
//!
//! Uses the near-api crate with FastNEAR archival RPC for historical queries.

pub mod ft;
pub mod intents;
pub mod near;

use near_api::NetworkConfig;

/// Query balance at a specific block height for any token type
///
/// This is a convenience function that routes to the appropriate specialized function
/// based on the token_id format.
///
/// # Arguments
/// * `network` - The NEAR network configuration (use archival network for historical queries)
/// * `account_id` - The NEAR account to query
/// * `token_id` - Token identifier:
///   - "NEAR" or "near" for native NEAR tokens
///   - "contract:token_id" for NEAR Intents multi-tokens
///   - contract address for standard FT tokens
/// * `block_height` - The block height to query at
///
/// # Returns
/// The balance as a string (to handle arbitrary precision)
pub async fn get_balance_at_block(
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    block_height: u64,
) -> Result<String, Box<dyn std::error::Error>> {
    if token_id == "NEAR" || token_id == "near" {
        near::get_balance_at_block(network, account_id, block_height).await
    } else if token_id.contains(':') {
        // NEAR Intents format: "contract:token_id"
        intents::get_balance_at_block(network, account_id, token_id, block_height).await
    } else {
        // Fungible token contract address
        ft::get_balance_at_block(network, account_id, token_id, block_height).await
    }
}

/// Query balance change at a specific block (both before and after)
///
/// # Arguments
/// * `network` - The NEAR network configuration (use archival network for historical queries)
/// * `account_id` - The NEAR account to query
/// * `token_id` - Token identifier (see `get_balance_at_block` for format)
/// * `block_height` - The block height to query at
///
/// # Returns
/// Tuple of (balance_before, balance_after)
pub async fn get_balance_change_at_block(
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    block_height: u64,
) -> Result<(String, String), Box<dyn std::error::Error>> {
    // For now, we query the block and the previous block
    // In the future, this should be optimized with transaction-specific queries
    let balance_after = get_balance_at_block(network, account_id, token_id, block_height).await?;
    let balance_before = if block_height > 0 {
        get_balance_at_block(network, account_id, token_id, block_height - 1).await?
    } else {
        "0".to_string()
    };
    
    Ok((balance_before, balance_after))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init_app_state;

    #[tokio::test]
    async fn test_query_mainnet_near_balance() {
        // Load both .env files for complete environment setup
        dotenvy::from_filename("../.env").ok();
        dotenvy::from_filename(".env.test").ok();
        
        let state = init_app_state().await.expect("Failed to initialize app state");
        
        // Block 151386339 from test data
        let balance = get_balance_at_block(
            &state.archival_network,
            "webassemblymusic-treasury.sputnik-dao.near",
            "NEAR",
            151386339,
        ).await.unwrap();
        
        // Expected balance after from test data
        assert_eq!(balance, "11100211126630537100000000");
    }

    #[tokio::test]
    async fn test_query_balance_change() {
        // Load both .env files for complete environment setup
        dotenvy::from_filename("../.env").ok();
        dotenvy::from_filename(".env.test").ok();
        
        // Add a small delay to avoid rate limiting when running multiple tests
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        
        let state = init_app_state().await.expect("Failed to initialize app state");
        
        // Block 151386339 from test data with known before/after balances
        let (before, after) = get_balance_change_at_block(
            &state.archival_network,
            "webassemblymusic-treasury.sputnik-dao.near",
            "NEAR",
            151386339,
        ).await.unwrap();
        
        // From test data: balanceBefore and balanceAfter at block 151386339
        assert_eq!(before, "6100211126630537100000000");
        assert_eq!(after, "11100211126630537100000000");
    }
}
