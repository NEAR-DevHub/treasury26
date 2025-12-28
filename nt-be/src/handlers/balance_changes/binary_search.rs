//! Binary Search for Balance Changes
//!
//! This module implements RPC-based binary search to find the exact block where a balance change occurred.
//! Uses the balance query service to efficiently locate transaction blocks.

use crate::handlers::balance_changes::balance;
use near_api::NetworkConfig;
use sqlx::PgPool;

/// Find the exact block where a balance changed to match expected balance
///
/// Uses binary search over RPC queries to efficiently locate the block.
/// Searches the range [start_block, end_block] inclusive.
///
/// # Arguments
/// * `pool` - Database connection pool for querying token metadata
/// * `network` - The NEAR network configuration (use archival network for historical queries)
/// * `account_id` - The NEAR account to query
/// * `token_id` - Token identifier (see balance::get_balance_at_block for format)
/// * `start_block` - Starting block height (inclusive)
/// * `end_block` - Ending block height (inclusive)
/// * `expected_balance` - The balance we're looking for
///
/// # Returns
/// * `Some(block_height)` - The block where balance changed to expected_balance
/// * `None` - If the expected balance is not found in the range
pub async fn find_balance_change_block(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    start_block: u64,
    end_block: u64,
    expected_balance: &str,
) -> Result<Option<u64>, Box<dyn std::error::Error>> {
    // Check if range is valid
    if start_block > end_block {
        return Ok(None);
    }

    // Check balance at end_block first
    let end_balance =
        balance::get_balance_at_block(pool, network, account_id, token_id, end_block).await?;

    // If balance at end doesn't match, expected balance is not in this range
    if end_balance != expected_balance {
        return Ok(None);
    }

    // Check balance at start_block
    let start_balance =
        balance::get_balance_at_block(pool, network, account_id, token_id, start_block).await?;

    // If balance at start already matches, return start_block
    if start_balance == expected_balance {
        return Ok(Some(start_block));
    }

    // Binary search to find the first block with expected_balance
    let mut left = start_block;
    let mut right = end_block;
    let mut result = end_block;

    while left <= right {
        let mid = left + (right - left) / 2;

        let mid_balance = balance::get_balance_at_block(pool, network, account_id, token_id, mid).await?;

        if mid_balance == expected_balance {
            // Found a match - check if there's an earlier one
            result = mid;
            if mid == left {
                break;
            }
            right = mid - 1;
        } else {
            // Balance doesn't match yet, search later blocks
            left = mid + 1;
        }
    }

    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_utils::init_test_state;

    #[tokio::test]
    async fn test_find_balance_change_mainnet() {
        let state = init_test_state().await;

        // Test data: balance changed at block 151386339
        // Before: "6100211126630537100000000"
        // After: "11100211126630537100000000"
        let result = find_balance_change_block(
            &state.db_pool,
            &state.archival_network,
            "webassemblymusic-treasury.sputnik-dao.near",
            "NEAR",
            151386338, // Block before the change
            151386340, // Block after the change
            "11100211126630537100000000",
        )
        .await
        .unwrap();

        // Should find block 151386339 where balance changed
        assert_eq!(result, Some(151386339));
    }

    #[tokio::test]
    async fn test_balance_not_found() {
        let state = init_test_state().await;

        // Search for a balance that doesn't exist in this range
        let result = find_balance_change_block(
            &state.db_pool,
            &state.archival_network,
            "webassemblymusic-treasury.sputnik-dao.near",
            "NEAR",
            151386338,
            151386340,
            "99999999999999999999999999", // Non-existent balance
        )
        .await
        .unwrap();

        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn test_single_block_range() {
        let state = init_test_state().await;

        // Single block range
        let result = find_balance_change_block(
            &state.db_pool,
            &state.archival_network,
            "webassemblymusic-treasury.sputnik-dao.near",
            "NEAR",
            151386339,
            151386339,
            "11100211126630537100000000",
        )
        .await
        .unwrap();

        assert_eq!(result, Some(151386339));
    }

    #[tokio::test]
    async fn test_find_intents_btc_balance_change_mainnet() {
        let state = init_test_state().await;

        // Test data: BTC intents balance changed at block 159487770
        // Before: "0"
        // After: "32868"
        // Token format: "intents.near:nep141:btc.omft.near"
        let result = find_balance_change_block(
            &state.db_pool,
            &state.archival_network,
            "webassemblymusic-treasury.sputnik-dao.near",
            "intents.near:nep141:btc.omft.near",
            159487760, // 10 blocks before the change
            159487780, // 10 blocks after the change
            "32868",
        )
        .await
        .unwrap();

        // Should find block 159487770 where balance changed
        assert_eq!(result, Some(159487770));
    }

    #[tokio::test]
    async fn test_intents_balance_not_found() {
        let state = init_test_state().await;

        // Search for a balance that doesn't exist in this range
        let result = find_balance_change_block(
            &state.db_pool,
            &state.archival_network,
            "webassemblymusic-treasury.sputnik-dao.near",
            "intents.near:nep141:btc.omft.near",
            159487769,
            159487771,
            "99999999999999999999999999", // Non-existent balance
        )
        .await
        .unwrap();

        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn test_find_ft_balance_mainnet() {
        use crate::handlers::balance_changes::balance;

        let state = init_test_state().await;

        // Test FT balance query for arizcredits.near token
        // At block 168568481, the treasury received 3000000 arizcredits tokens (6 decimals = 3.0 tokens)
        // Query at different blocks to verify the balance mechanism works

        // Check balance before receiving (should be 0)
        let balance_before = balance::ft::get_balance_at_block(
            &state.db_pool,
            &state.archival_network,
            "webassemblymusic-treasury.sputnik-dao.near",
            "arizcredits.near",
            168568480, // Before the transfer
        )
        .await
        .expect("FT balance query should succeed");

        // Check balance after receiving
        let balance_after = balance::ft::get_balance_at_block(
            &state.db_pool,
            &state.archival_network,
            "webassemblymusic-treasury.sputnik-dao.near",
            "arizcredits.near",
            168568485, // After the transfer
        )
        .await
        .expect("FT balance query should succeed");

        println!("arizcredits balance before (168568480): {}", balance_before);
        println!("arizcredits balance after (168568485): {}", balance_after);

        // Verify balance increased after the transfer
        let before: u128 = balance_before.parse().unwrap_or(0);
        let after: u128 = balance_after.parse().unwrap_or(0);
        assert!(
            after > before,
            "Balance should increase after receiving tokens"
        );
    }

    #[tokio::test]
    async fn test_find_ft_balance_change_mainnet() {
        let state = init_test_state().await;

        // Test binary search for arizcredits.near balance change
        // At block 168568481, the treasury received tokens (balance went from 0 to non-zero)
        // We need to find the exact balance at that block

        // First query the balance at a block after the transfer
        let balance_after = crate::handlers::balance_changes::balance::ft::get_balance_at_block(
            &state.db_pool,
            &state.archival_network,
            "webassemblymusic-treasury.sputnik-dao.near",
            "arizcredits.near",
            168568485,
        )
        .await
        .expect("FT balance query should succeed");

        println!("arizcredits balance at 168568485: {}", balance_after);

        // Now binary search for when this balance first appeared
        let result = find_balance_change_block(
            &state.db_pool,
            &state.archival_network,
            "webassemblymusic-treasury.sputnik-dao.near",
            "arizcredits.near",
            168568479, // Block before the change
            168568485, // Block after the change
            &balance_after,
        )
        .await
        .unwrap();

        // Should find block 168568482 where balance changed to 3 ARIZ
        assert!(result.is_some(), "Should find the balance change block");
        let block = result.unwrap();
        println!("Found balance change at block: {}", block);
        assert_eq!(
            block, 168568482,
            "Balance change should be at block 168568482"
        );
        assert_eq!(
            balance_after, "3",
            "Balance after should be 3 ARIZ (6 decimals, so 3000000 raw = 3)"
        );
    }
}
