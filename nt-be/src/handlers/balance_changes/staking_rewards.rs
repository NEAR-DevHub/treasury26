//! Staking Rewards Tracking
//!
//! This module handles the discovery of staking pools and creation of epoch-based
//! balance snapshots for tracking staking rewards.
//!
//! ## Overview
//!
//! When an account interacts with a staking pool, this module:
//! 1. Detects the staking pool from balance_changes counterparties
//! 2. Creates periodic balance snapshots at epoch boundaries
//! 3. Stores these snapshots in the balance_changes table with `counterparty = "STAKING_SNAPSHOT"`
//!
//! ## Token ID Format
//!
//! Staking snapshots use a special token_id format: `staking:<pool_address>`
//! For example: `staking:aurora.poolv1.near`
//!
//! ## Database Schema
//!
//! Staking snapshots are stored in the existing balance_changes table:
//! - `token_id`: `staking:<pool_address>` (e.g., "staking:aurora.poolv1.near")
//! - `counterparty`: "STAKING_SNAPSHOT" (synthetic entry marker)
//! - `transaction_hashes`: empty array (no actual transaction)
//! - `raw_data`: JSON with epoch metadata
//!
//! ## Epoch-Based Tracking
//!
//! NEAR mainnet uses 43,200 blocks per epoch (~12 hours).
//! Snapshots are created at epoch boundaries to track reward accumulation.

use bigdecimal::BigDecimal;
use near_api::NetworkConfig;
use sqlx::PgPool;
use std::collections::HashSet;

use super::balance::staking::{
    block_to_epoch, epoch_to_block, get_staking_balance_at_block, is_staking_pool,
};
use super::block_info::get_block_timestamp;
use super::utils::block_timestamp_to_datetime;

/// Counterparty value for staking snapshot records
pub const STAKING_SNAPSHOT_COUNTERPARTY: &str = "STAKING_SNAPSHOT";

/// Prefix for staking pool token IDs in balance_changes
pub const STAKING_TOKEN_PREFIX: &str = "staking:";

/// Create the token_id for a staking pool
///
/// # Arguments
/// * `staking_pool` - The staking pool contract address
///
/// # Returns
/// Token ID in format "staking:<pool_address>"
pub fn staking_token_id(staking_pool: &str) -> String {
    format!("{}{}", STAKING_TOKEN_PREFIX, staking_pool)
}

/// Extract staking pool address from a staking token_id
///
/// # Arguments
/// * `token_id` - Token ID in format "staking:<pool_address>"
///
/// # Returns
/// The staking pool address if the token_id is a staking token, None otherwise
pub fn extract_staking_pool(token_id: &str) -> Option<&str> {
    token_id.strip_prefix(STAKING_TOKEN_PREFIX)
}

/// Check if a token_id represents a staking pool balance
pub fn is_staking_token(token_id: &str) -> bool {
    token_id.starts_with(STAKING_TOKEN_PREFIX)
}

/// Discover staking pools from balance_changes counterparties
///
/// Scans the counterparty column for addresses matching staking pool patterns
/// and returns unique staking pools that the account has interacted with.
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `account_id` - The account to find staking pools for
///
/// # Returns
/// Set of staking pool addresses
pub async fn discover_staking_pools(
    pool: &PgPool,
    account_id: &str,
) -> Result<HashSet<String>, Box<dyn std::error::Error>> {
    // Query all unique counterparties for this account
    let counterparties: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT counterparty
        FROM balance_changes
        WHERE account_id = $1
          AND counterparty != 'SNAPSHOT'
          AND counterparty != 'UNKNOWN'
          AND counterparty != 'STAKING_SNAPSHOT'
        ORDER BY counterparty
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;

    // Filter for staking pool patterns
    let staking_pools: HashSet<String> = counterparties
        .into_iter()
        .filter(|cp| is_staking_pool(cp))
        .collect();

    if !staking_pools.is_empty() {
        log::info!(
            "Discovered {} staking pools for {}: {:?}",
            staking_pools.len(),
            account_id,
            staking_pools
        );
    }

    Ok(staking_pools)
}

/// Get already tracked staking pools for an account
///
/// Returns the set of staking pool addresses that already have snapshot records.
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `account_id` - The account to check
///
/// # Returns
/// Set of staking pool addresses already being tracked
pub async fn get_tracked_staking_pools(
    pool: &PgPool,
    account_id: &str,
) -> Result<HashSet<String>, Box<dyn std::error::Error>> {
    let token_ids: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT token_id
        FROM balance_changes
        WHERE account_id = $1
          AND token_id LIKE 'staking:%'
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;

    let pools: HashSet<String> = token_ids
        .iter()
        .filter_map(|t| extract_staking_pool(t).map(String::from))
        .collect();

    Ok(pools)
}

/// Insert a staking balance snapshot at a specific block
///
/// Creates a balance_changes record for the staking pool balance at the given block.
/// Uses `counterparty = "STAKING_SNAPSHOT"` to mark this as a synthetic entry.
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR network configuration (archival RPC)
/// * `account_id` - The account to snapshot
/// * `staking_pool` - The staking pool contract address
/// * `block_height` - The block height to snapshot at
///
/// # Returns
/// The inserted balance, or None if no balance exists
pub async fn insert_staking_snapshot(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    staking_pool: &str,
    block_height: u64,
) -> Result<Option<BigDecimal>, Box<dyn std::error::Error>> {
    let token_id = staking_token_id(staking_pool);
    let epoch = block_to_epoch(block_height);

    // Get current staking balance
    let balance =
        match get_staking_balance_at_block(network, account_id, staking_pool, block_height).await {
            Ok(b) => b,
            Err(e) => {
                log::debug!(
                    "Could not query staking balance for {}/{} at block {}: {}",
                    account_id,
                    staking_pool,
                    block_height,
                    e
                );
                return Ok(None);
            }
        };

    // Skip if balance is zero
    if balance == BigDecimal::from(0) {
        log::debug!(
            "Staking balance is 0 for {}/{} at block {}, skipping",
            account_id,
            staking_pool,
            block_height
        );
        return Ok(None);
    }

    // Get balance at previous block to calculate change
    let balance_before = if block_height > 0 {
        match get_staking_balance_at_block(network, account_id, staking_pool, block_height - 1)
            .await
        {
            Ok(b) => b,
            Err(_) => BigDecimal::from(0),
        }
    } else {
        BigDecimal::from(0)
    };

    let amount = &balance - &balance_before;

    // Get block timestamp
    let block_timestamp = get_block_timestamp(network, block_height, None)
        .await
        .map_err(|e| -> Box<dyn std::error::Error> { e.to_string().into() })?;

    let block_time = block_timestamp_to_datetime(block_timestamp);

    // Build epoch metadata for raw_data
    let raw_data = serde_json::json!({
        "epoch": epoch,
        "epoch_start_block": epoch_to_block(epoch),
        "staking_pool": staking_pool,
        "snapshot_type": "epoch_boundary"
    });

    // Insert the snapshot record
    sqlx::query(
        r#"
        INSERT INTO balance_changes
        (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, transaction_hashes, receipt_id, signer_id, receiver_id, counterparty, actions, raw_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (account_id, block_height, token_id) DO NOTHING
        "#,
    )
    .bind(account_id)
    .bind(&token_id)
    .bind(block_height as i64)
    .bind(block_timestamp)
    .bind(block_time)
    .bind(&amount)
    .bind(&balance_before)
    .bind(&balance)
    .bind(Vec::<String>::new()) // No transaction hashes for synthetic records
    .bind(Vec::<String>::new()) // No receipt IDs
    .bind(None::<String>)        // No signer
    .bind(None::<String>)        // No receiver
    .bind(STAKING_SNAPSHOT_COUNTERPARTY)
    .bind(serde_json::json!({})) // No actions
    .bind(&raw_data)
    .execute(pool)
    .await?;

    log::info!(
        "Inserted staking snapshot for {}/{} at block {} (epoch {}): {} -> {} (change: {})",
        account_id,
        staking_pool,
        block_height,
        epoch,
        balance_before,
        balance,
        amount
    );

    Ok(Some(balance))
}

/// Track staking rewards for all discovered staking pools
///
/// This function:
/// 1. Discovers staking pools from balance_changes counterparties
/// 2. For each new staking pool, creates initial and current epoch snapshots
/// 3. For existing staking pools, creates snapshot at current epoch if missing
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR network configuration (archival RPC)
/// * `account_id` - The account to track staking rewards for
/// * `up_to_block` - Current block height
///
/// # Returns
/// Number of staking snapshots created
pub async fn track_staking_rewards(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    up_to_block: i64,
) -> Result<usize, Box<dyn std::error::Error>> {
    // Discover staking pools from counterparties
    let discovered_pools = discover_staking_pools(pool, account_id).await?;

    if discovered_pools.is_empty() {
        return Ok(0);
    }

    // Get already tracked staking pools
    let tracked_pools = get_tracked_staking_pools(pool, account_id).await?;

    // Find new pools (discovered but not yet tracked)
    let new_pools: Vec<_> = discovered_pools
        .iter()
        .filter(|p| !tracked_pools.contains(*p))
        .collect();

    let current_epoch = block_to_epoch(up_to_block as u64);
    let mut snapshots_created = 0;

    // For new pools, create initial snapshot at current epoch
    for staking_pool in &new_pools {
        let epoch_block = epoch_to_block(current_epoch);

        match insert_staking_snapshot(pool, network, account_id, staking_pool, epoch_block).await {
            Ok(Some(_)) => {
                snapshots_created += 1;
                log::info!(
                    "Created initial staking snapshot for {}/{} at epoch {}",
                    account_id,
                    staking_pool,
                    current_epoch
                );
            }
            Ok(None) => {
                log::debug!(
                    "No staking balance for {}/{} at epoch {}",
                    account_id,
                    staking_pool,
                    current_epoch
                );
            }
            Err(e) => {
                log::warn!(
                    "Failed to create staking snapshot for {}/{}: {}",
                    account_id,
                    staking_pool,
                    e
                );
            }
        }
    }

    // For all tracked pools (including newly added), check if current epoch snapshot exists
    let all_pools: HashSet<_> = discovered_pools.union(&tracked_pools).cloned().collect();

    for staking_pool in &all_pools {
        let token_id = staking_token_id(staking_pool);
        let epoch_block = epoch_to_block(current_epoch);

        // Check if snapshot exists for current epoch
        let existing: Option<(i64,)> = sqlx::query_as(
            r#"
            SELECT block_height
            FROM balance_changes
            WHERE account_id = $1 AND token_id = $2 AND block_height = $3
            "#,
        )
        .bind(account_id)
        .bind(&token_id)
        .bind(epoch_block as i64)
        .fetch_optional(pool)
        .await?;

        #[allow(clippy::collapsible_if)]
        if existing.is_none() {
            if let Ok(Some(_)) =
                insert_staking_snapshot(pool, network, account_id, staking_pool, epoch_block).await
            {
                snapshots_created += 1;
            }
        }
    }

    Ok(snapshots_created)
}

/// Backfill staking snapshots for historical epochs
///
/// Creates snapshots at epoch boundaries going back from the current block.
/// Prioritizes recent epochs first, then progressively backfills historical data.
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR network configuration (archival RPC)
/// * `account_id` - The account to backfill
/// * `staking_pool` - The staking pool to backfill
/// * `from_epoch` - The oldest epoch to backfill to
/// * `to_epoch` - The newest epoch to backfill to
///
/// # Returns
/// Number of snapshots created
pub async fn backfill_staking_snapshots(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    staking_pool: &str,
    from_epoch: u64,
    to_epoch: u64,
) -> Result<usize, Box<dyn std::error::Error>> {
    let token_id = staking_token_id(staking_pool);
    let mut snapshots_created = 0;

    // Process epochs from newest to oldest (prioritize recent data)
    for epoch in (from_epoch..=to_epoch).rev() {
        let epoch_block = epoch_to_block(epoch);

        // Check if snapshot already exists
        let existing: Option<(i64,)> = sqlx::query_as(
            r#"
            SELECT block_height
            FROM balance_changes
            WHERE account_id = $1 AND token_id = $2 AND block_height = $3
            "#,
        )
        .bind(account_id)
        .bind(&token_id)
        .bind(epoch_block as i64)
        .fetch_optional(pool)
        .await?;

        if existing.is_some() {
            log::debug!(
                "Snapshot already exists for {}/{} at epoch {}",
                account_id,
                staking_pool,
                epoch
            );
            continue;
        }

        match insert_staking_snapshot(pool, network, account_id, staking_pool, epoch_block).await {
            Ok(Some(_)) => {
                snapshots_created += 1;
            }
            Ok(None) => {
                // Zero balance at this epoch - likely account hadn't staked yet
                log::debug!(
                    "No staking balance for {}/{} at epoch {}",
                    account_id,
                    staking_pool,
                    epoch
                );
            }
            Err(e) => {
                // Log error but continue with other epochs
                log::warn!(
                    "Failed to backfill epoch {} for {}/{}: {}",
                    epoch,
                    account_id,
                    staking_pool,
                    e
                );
            }
        }
    }

    if snapshots_created > 0 {
        log::info!(
            "Backfilled {} staking snapshots for {}/{} (epochs {}-{})",
            snapshots_created,
            account_id,
            staking_pool,
            from_epoch,
            to_epoch
        );
    }

    Ok(snapshots_created)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_staking_token_id() {
        assert_eq!(
            staking_token_id("aurora.poolv1.near"),
            "staking:aurora.poolv1.near"
        );
        assert_eq!(
            staking_token_id("kiln.poolv1.near"),
            "staking:kiln.poolv1.near"
        );
    }

    #[test]
    fn test_extract_staking_pool() {
        assert_eq!(
            extract_staking_pool("staking:aurora.poolv1.near"),
            Some("aurora.poolv1.near")
        );
        assert_eq!(
            extract_staking_pool("staking:kiln.poolv1.near"),
            Some("kiln.poolv1.near")
        );
        assert_eq!(extract_staking_pool("NEAR"), None);
        assert_eq!(extract_staking_pool("wrap.near"), None);
    }

    #[test]
    fn test_is_staking_token() {
        assert!(is_staking_token("staking:aurora.poolv1.near"));
        assert!(is_staking_token("staking:kiln.poolv1.near"));
        assert!(!is_staking_token("NEAR"));
        assert!(!is_staking_token("wrap.near"));
        assert!(!is_staking_token("aurora.poolv1.near")); // Pool address alone is not a staking token
    }
}
