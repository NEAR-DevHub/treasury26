//! Staking Pool Balance Queries
//!
//! Functions to query staking pool balances at specific block heights via RPC.
//! Supports detecting staking pools by contract naming patterns and querying
//! the `get_account_total_balance` view function to get staked amounts.
//!
//! # Staking Pool Patterns
//! - `*.poolv1.near` - NEAR staking pools (v1)
//! - `*.pool.near` - NEAR staking pools
//!
//! # Balance Representation
//! Staking balances are returned as human-readable NEAR strings (e.g., "11.1002")
//! using 24 decimals, consistent with native NEAR balance conversion.

use bigdecimal::BigDecimal;
use near_api::types::json::U128;
use near_api::{AccountId, Contract, NetworkConfig, Reference};
use std::str::FromStr;

use crate::handlers::balance_changes::counterparty::convert_raw_to_decimal;
use crate::handlers::balance_changes::utils::with_transport_retry;

/// NEAR mainnet epoch length in blocks (~12 hours)
pub const EPOCH_LENGTH_BLOCKS: u64 = 43_200;

/// Number of decimals for NEAR token (used for staking balances)
const NEAR_DECIMALS: u8 = 24;

/// Staking pool parent accounts
const POOLV1_NEAR: &str = "poolv1.near";
const POOL_NEAR: &str = "pool.near";

/// Check if an account ID matches a staking pool pattern
///
/// Detects common staking pool naming conventions on NEAR:
/// - `*.poolv1.near` - NEAR foundation staking pools
/// - `*.pool.near` - Community staking pools
///
/// Uses NEAR's AccountId type for proper subaccount validation.
///
/// # Arguments
/// * `account_id` - The account ID to check
///
/// # Returns
/// `true` if the account ID matches a staking pool pattern
pub fn is_staking_pool(account_id: &str) -> bool {
    let Ok(account) = AccountId::from_str(account_id) else {
        return false;
    };

    // Check if account is a direct subaccount of poolv1.near or pool.near
    let Ok(poolv1) = AccountId::from_str(POOLV1_NEAR) else {
        return false;
    };
    let Ok(pool) = AccountId::from_str(POOL_NEAR) else {
        return false;
    };

    account.is_sub_account_of(&poolv1) || account.is_sub_account_of(&pool)
}

/// Query staking pool balance for an account at a specific block height
///
/// Calls `get_account_total_balance` on the staking pool contract to get the
/// total staked amount (including rewards) for the account.
///
/// If the RPC returns a 422 error (unprocessable entity), assumes the block doesn't exist
/// and retries with previous blocks (up to 10 attempts).
///
/// # Arguments
/// * `network` - The NEAR network configuration (use archival network for historical queries)
/// * `account_id` - The NEAR account to query staking balance for
/// * `staking_pool` - The staking pool contract address
/// * `block_height` - The block height to query at
///
/// # Returns
/// The staking balance as a BigDecimal (e.g., "11.1002" for 11.1002 NEAR staked)
pub async fn get_staking_balance_at_block(
    network: &NetworkConfig,
    account_id: &str,
    staking_pool: &str,
    block_height: u64,
) -> Result<BigDecimal, Box<dyn std::error::Error>> {
    let pool_account_id = AccountId::from_str(staking_pool)?;
    let max_retries = 10;

    for offset in 0..=max_retries {
        let current_block = block_height.saturating_sub(offset);

        let result: Result<near_api::Data<U128>, _> =
            with_transport_retry("staking_balance", || {
                Contract(pool_account_id.clone())
                    .call_function(
                        "get_account_total_balance",
                        serde_json::json!({
                            "account_id": account_id
                        }),
                    )
                    .read_only()
                    .at(Reference::AtBlock(current_block))
                    .fetch_from(network)
            })
            .await;

        match result {
            Ok(data) => {
                if offset > 0 {
                    log::warn!(
                        "Block {} not available for staking pool {}, used block {} instead (offset: {})",
                        block_height,
                        staking_pool,
                        current_block,
                        offset
                    );
                }

                // Convert yoctoNEAR to human-readable NEAR (24 decimals)
                let raw_balance = data.data;
                let decimal_balance =
                    convert_raw_to_decimal(&raw_balance.0.to_string(), NEAR_DECIMALS)?;

                return Ok(decimal_balance);
            }
            Err(e) => {
                let err_str = e.to_string();
                // Check for various error conditions
                if err_str.contains("422")
                    || err_str.contains("UnknownBlock")
                    || err_str.contains("MethodNotFound")
                    || err_str.contains("doesn't exist")
                {
                    if offset < max_retries {
                        log::debug!(
                            "Block {} not available for staking pool {} ({}), trying previous block",
                            current_block,
                            staking_pool,
                            err_str
                        );
                        continue;
                    } else {
                        return Err(format!(
                            "Failed to query staking balance after {} retries: {}",
                            max_retries, err_str
                        )
                        .into());
                    }
                } else {
                    // For other errors, fail immediately
                    return Err(e.into());
                }
            }
        }
    }

    Err(format!(
        "Failed to query staking balance for block {} after {} attempts",
        block_height,
        max_retries + 1
    )
    .into())
}

/// Query staking balance change at a specific block (both before and after)
///
/// # Arguments
/// * `network` - The NEAR network configuration (use archival network for historical queries)
/// * `account_id` - The NEAR account to query
/// * `staking_pool` - The staking pool contract address
/// * `block_height` - The block height to query at
///
/// # Returns
/// Tuple of (balance_before, balance_after) as BigDecimal values
pub async fn get_staking_balance_change_at_block(
    network: &NetworkConfig,
    account_id: &str,
    staking_pool: &str,
    block_height: u64,
) -> Result<(BigDecimal, BigDecimal), Box<dyn std::error::Error>> {
    let balance_after =
        get_staking_balance_at_block(network, account_id, staking_pool, block_height).await?;
    let balance_before = if block_height > 0 {
        get_staking_balance_at_block(network, account_id, staking_pool, block_height - 1).await?
    } else {
        BigDecimal::from(0)
    };

    Ok((balance_before, balance_after))
}

/// Calculate the epoch number for a given block height
///
/// NEAR mainnet uses 43,200 blocks per epoch (~12 hours).
///
/// # Arguments
/// * `block_height` - The block height
///
/// # Returns
/// The epoch number
pub fn block_to_epoch(block_height: u64) -> u64 {
    block_height / EPOCH_LENGTH_BLOCKS
}

/// Calculate the first block of a given epoch
///
/// # Arguments
/// * `epoch` - The epoch number
///
/// # Returns
/// The first block height of the epoch
pub fn epoch_to_block(epoch: u64) -> u64 {
    epoch * EPOCH_LENGTH_BLOCKS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_staking_pool() {
        // Valid staking pool patterns
        assert!(is_staking_pool("aurora.poolv1.near"));
        assert!(is_staking_pool("kiln.poolv1.near"));
        assert!(is_staking_pool("meta-pool.pool.near"));
        assert!(is_staking_pool("some-validator.pool.near"));

        // Not staking pools
        assert!(!is_staking_pool("wrap.near"));
        assert!(!is_staking_pool("usdt.tether-token.near"));
        assert!(!is_staking_pool("example.near"));
        assert!(!is_staking_pool("pool.near")); // Missing prefix
        assert!(!is_staking_pool("poolv1.near")); // Missing prefix
        assert!(!is_staking_pool("aurora.poolv1")); // Missing .near suffix
    }

    #[test]
    fn test_block_to_epoch() {
        // Block 0 is epoch 0
        assert_eq!(block_to_epoch(0), 0);

        // First epoch boundary
        assert_eq!(block_to_epoch(43_199), 0);
        assert_eq!(block_to_epoch(43_200), 1);

        // Arbitrary epoch
        assert_eq!(block_to_epoch(100_000), 2);
        assert_eq!(block_to_epoch(177_000_000), 4097); // Recent mainnet block
    }

    #[test]
    fn test_epoch_to_block() {
        assert_eq!(epoch_to_block(0), 0);
        assert_eq!(epoch_to_block(1), 43_200);
        assert_eq!(epoch_to_block(2), 86_400);
        assert_eq!(epoch_to_block(4097), 176_990_400);
    }
}
