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

/// Counterparty value for staking reward records (balance changes without transactions)
pub const STAKING_REWARD_COUNTERPARTY: &str = "STAKING_REWARD";

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

/// Maximum number of epochs to fill per monitoring cycle
const MAX_EPOCHS_PER_CYCLE: usize = 5;

/// Track staking rewards for all discovered staking pools
///
/// This function:
/// 1. Discovers staking pools from balance_changes counterparties
/// 2. Finds all missing epochs between first staking transaction and current epoch
/// 3. Fills up to MAX_EPOCHS_PER_CYCLE missing epochs per cycle (prioritizing recent ones)
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

    let current_epoch = block_to_epoch(up_to_block as u64);
    let mut snapshots_created = 0;

    for staking_pool in &discovered_pools {
        let token_id = staking_token_id(staking_pool);

        // Find the first staking transaction to determine how far back to go
        let first_staking_tx: Option<(i64,)> = sqlx::query_as(
            r#"
            SELECT MIN(block_height) as first_block
            FROM balance_changes
            WHERE account_id = $1 AND counterparty = $2
            "#,
        )
        .bind(account_id)
        .bind(staking_pool.as_str())
        .fetch_optional(pool)
        .await?;

        let first_tx_epoch = match first_staking_tx {
            Some((first_block,)) => block_to_epoch(first_block as u64),
            None => {
                log::debug!(
                    "No staking transactions found for {}/{}",
                    account_id,
                    staking_pool
                );
                continue;
            }
        };

        // Get all existing epoch snapshots for this staking pool
        let existing_epochs: Vec<(i64,)> = sqlx::query_as(
            r#"
            SELECT block_height
            FROM balance_changes
            WHERE account_id = $1 AND token_id = $2
            ORDER BY block_height
            "#,
        )
        .bind(account_id)
        .bind(&token_id)
        .fetch_all(pool)
        .await?;

        let existing_epoch_set: HashSet<u64> = existing_epochs
            .iter()
            .map(|(block,)| block_to_epoch(*block as u64))
            .collect();

        // Find all missing epochs from first_tx_epoch to current_epoch
        let mut missing_epochs: Vec<u64> = (first_tx_epoch..=current_epoch)
            .filter(|epoch| !existing_epoch_set.contains(epoch))
            .collect();

        if missing_epochs.is_empty() {
            log::debug!(
                "All epochs covered for {}/{} ({} to {})",
                account_id,
                staking_pool,
                first_tx_epoch,
                current_epoch
            );
            continue;
        }

        // Sort descending to prioritize recent epochs
        missing_epochs.sort_by(|a, b| b.cmp(a));

        // Take up to MAX_EPOCHS_PER_CYCLE missing epochs
        let epochs_to_fill: Vec<u64> = missing_epochs
            .into_iter()
            .take(MAX_EPOCHS_PER_CYCLE)
            .collect();

        log::info!(
            "Filling {} missing staking epochs for {}/{} (epochs: {:?})",
            epochs_to_fill.len(),
            account_id,
            staking_pool,
            epochs_to_fill
        );

        for epoch in epochs_to_fill {
            let epoch_block = epoch_to_block(epoch);

            match insert_staking_snapshot(pool, network, account_id, staking_pool, epoch_block)
                .await
            {
                Ok(Some(_)) => {
                    snapshots_created += 1;
                    log::info!(
                        "Created staking snapshot for {}/{} at epoch {} (block {})",
                        account_id,
                        staking_pool,
                        epoch,
                        epoch_block
                    );
                }
                Ok(None) => {
                    log::debug!(
                        "No staking balance for {}/{} at epoch {}",
                        account_id,
                        staking_pool,
                        epoch
                    );
                }
                Err(e) => {
                    log::warn!(
                        "Failed to create staking snapshot for {}/{} at epoch {}: {}",
                        account_id,
                        staking_pool,
                        epoch,
                        e
                    );
                }
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

/// Represents a gap in staking balance changes between two snapshots
#[derive(Debug, Clone)]
pub struct StakingGap {
    pub account_id: String,
    pub staking_pool: String,
    pub token_id: String,
    pub start_block: i64,
    pub end_block: i64,
    pub balance_at_start: BigDecimal,
    pub balance_at_end: BigDecimal,
}

/// Find gaps in staking balance changes
///
/// A gap exists when two consecutive staking records have different balances,
/// indicating that a balance change occurred somewhere between them.
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `account_id` - Account to check
/// * `staking_pool` - Staking pool contract address
/// * `up_to_block` - Only check records up to this block height
///
/// # Returns
/// Vector of gaps found, ordered by block height. Empty if no gaps.
pub async fn find_staking_gaps(
    pool: &PgPool,
    account_id: &str,
    staking_pool: &str,
    up_to_block: i64,
) -> Result<Vec<StakingGap>, Box<dyn std::error::Error>> {
    let token_id = staking_token_id(staking_pool);

    // Use window function to find gaps between consecutive staking records
    // Exclude records that are already filled gaps (STAKING_REWARD)
    let gaps: Vec<StakingGap> = sqlx::query_as::<_, (String, String, i64, i64, BigDecimal, BigDecimal)>(
        r#"
        WITH staking_chain AS (
            SELECT
                account_id,
                token_id,
                block_height,
                balance_after,
                LAG(block_height) OVER w as prev_block_height,
                LAG(balance_after) OVER w as prev_balance_after
            FROM balance_changes
            WHERE account_id = $1
              AND token_id = $2
              AND block_height <= $3
              AND counterparty = 'STAKING_SNAPSHOT'
            WINDOW w AS (PARTITION BY account_id, token_id ORDER BY block_height)
        )
        SELECT
            account_id,
            token_id,
            prev_block_height as start_block,
            block_height as end_block,
            prev_balance_after as balance_at_start,
            balance_after as balance_at_end
        FROM staking_chain
        WHERE prev_block_height IS NOT NULL 
          AND balance_after != prev_balance_after
        ORDER BY block_height
        "#,
    )
    .bind(account_id)
    .bind(&token_id)
    .bind(up_to_block)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(account_id, token_id, start_block, end_block, balance_at_start, balance_at_end)| {
        StakingGap {
            account_id,
            staking_pool: staking_pool.to_string(),
            token_id,
            start_block,
            end_block,
            balance_at_start,
            balance_at_end,
        }
    })
    .collect();

    Ok(gaps)
}

/// Fill a single staking gap using binary search
///
/// Finds the exact block where the staking balance changed and inserts a
/// STAKING_REWARD record at that block.
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR network configuration (archival RPC)
/// * `gap` - The gap to fill
///
/// # Returns
/// The block height where the record was inserted, or None if the gap couldn't be filled
pub async fn fill_staking_gap(
    pool: &PgPool,
    network: &NetworkConfig,
    gap: &StakingGap,
) -> Result<Option<i64>, Box<dyn std::error::Error>> {
    log::info!(
        "Filling staking gap for {}/{} between blocks {} and {} (balance: {} -> {})",
        gap.account_id,
        gap.staking_pool,
        gap.start_block,
        gap.end_block,
        gap.balance_at_start,
        gap.balance_at_end
    );

    // Binary search to find the exact block where balance changed to balance_at_end
    // We search from start_block+1 to end_block-1 since we already know the balances at boundaries
    let search_start = (gap.start_block + 1) as u64;
    let search_end = (gap.end_block - 1) as u64;

    if search_start > search_end {
        // Consecutive blocks, the change happened at end_block
        return insert_staking_reward(
            pool,
            network,
            &gap.account_id,
            &gap.staking_pool,
            gap.end_block as u64,
        )
        .await
        .map(|_| Some(gap.end_block));
    }

    // For staking tokens, we need a custom binary search using staking balance queries
    let change_block = find_staking_balance_change_block(
        network,
        &gap.account_id,
        &gap.staking_pool,
        search_start,
        search_end,
        &gap.balance_at_end,
    )
    .await?;

    let block_height = match change_block {
        Some(block) => block,
        None => {
            log::warn!(
                "Could not find staking balance change block for gap: {} {} [{}-{}]",
                gap.account_id,
                gap.staking_pool,
                gap.start_block,
                gap.end_block
            );
            return Ok(None);
        }
    };

    insert_staking_reward(pool, network, &gap.account_id, &gap.staking_pool, block_height)
        .await
        .map(|_| Some(block_height as i64))
}

/// Binary search to find the exact block where staking balance changed
///
/// Similar to the regular binary search but uses staking-specific balance queries.
async fn find_staking_balance_change_block(
    network: &NetworkConfig,
    account_id: &str,
    staking_pool: &str,
    start_block: u64,
    end_block: u64,
    expected_balance: &BigDecimal,
) -> Result<Option<u64>, Box<dyn std::error::Error>> {
    // Check if range is valid
    if start_block > end_block {
        return Ok(None);
    }

    // Check balance at end_block first
    let end_balance =
        get_staking_balance_at_block(network, account_id, staking_pool, end_block).await?;

    // If balance at end doesn't match, expected balance is not in this range
    if &end_balance != expected_balance {
        return Ok(None);
    }

    // Check balance at start_block
    let start_balance =
        get_staking_balance_at_block(network, account_id, staking_pool, start_block).await?;

    // If balance at start already matches, return start_block
    if &start_balance == expected_balance {
        return Ok(Some(start_block));
    }

    // Binary search to find the first block with expected_balance
    let mut left = start_block;
    let mut right = end_block;
    let mut result = end_block;

    while left <= right {
        let mid = left + (right - left) / 2;

        let mid_balance =
            get_staking_balance_at_block(network, account_id, staking_pool, mid).await?;

        if &mid_balance == expected_balance {
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

/// Insert a STAKING_REWARD record at a specific block
///
/// Creates a balance_changes record for the staking reward at the given block.
/// Uses `counterparty = "STAKING_REWARD"` to mark this as a reward (not a snapshot).
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR network configuration (archival RPC)
/// * `account_id` - The account
/// * `staking_pool` - The staking pool contract address
/// * `block_height` - The block height where the reward was earned
///
/// # Returns
/// The balance at the block, or error if insertion failed
pub async fn insert_staking_reward(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    staking_pool: &str,
    block_height: u64,
) -> Result<BigDecimal, Box<dyn std::error::Error>> {
    let token_id = staking_token_id(staking_pool);

    // Get current staking balance
    let balance_after =
        get_staking_balance_at_block(network, account_id, staking_pool, block_height).await?;

    // Get balance at previous block
    let balance_before = if block_height > 0 {
        get_staking_balance_at_block(network, account_id, staking_pool, block_height - 1).await?
    } else {
        BigDecimal::from(0)
    };

    let amount = &balance_after - &balance_before;

    // Get block timestamp
    let block_timestamp = get_block_timestamp(network, block_height, None)
        .await
        .map_err(|e| -> Box<dyn std::error::Error> { e.to_string().into() })?;

    let block_time = block_timestamp_to_datetime(block_timestamp);

    // Build metadata for raw_data
    let raw_data = serde_json::json!({
        "staking_pool": staking_pool,
        "reward_type": "staking_reward",
        "epoch": block_to_epoch(block_height),
    });

    // Insert the staking reward record
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
    .bind(&balance_after)
    .bind(Vec::<String>::new()) // No transaction hashes for staking rewards
    .bind(Vec::<String>::new()) // No receipt IDs
    .bind(None::<String>)        // No signer
    .bind(None::<String>)        // No receiver
    .bind(STAKING_REWARD_COUNTERPARTY)
    .bind(serde_json::json!({})) // No actions
    .bind(&raw_data)
    .execute(pool)
    .await?;

    log::info!(
        "Inserted staking reward for {}/{} at block {}: {} -> {} (reward: {})",
        account_id,
        staking_pool,
        block_height,
        balance_before,
        balance_after,
        amount
    );

    Ok(balance_after)
}

/// Fill all staking gaps for an account's staking pool
///
/// Detects gaps between staking snapshots and fills them with STAKING_REWARD records
/// at the exact block where each balance change occurred.
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR network configuration (archival RPC)
/// * `account_id` - Account to process
/// * `staking_pool` - Staking pool contract address
/// * `up_to_block` - Only process gaps up to this block height
///
/// # Returns
/// Number of gaps successfully filled
pub async fn fill_staking_gaps(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    staking_pool: &str,
    up_to_block: i64,
) -> Result<usize, Box<dyn std::error::Error>> {
    let gaps = find_staking_gaps(pool, account_id, staking_pool, up_to_block).await?;

    if gaps.is_empty() {
        log::debug!(
            "No staking gaps found for {}/{}",
            account_id,
            staking_pool
        );
        return Ok(0);
    }

    log::info!(
        "Found {} staking gaps for {}/{} up to block {}",
        gaps.len(),
        account_id,
        staking_pool,
        up_to_block
    );

    let mut filled_count = 0;
    for gap in &gaps {
        match fill_staking_gap(pool, network, gap).await {
            Ok(Some(block)) => {
                log::info!(
                    "Filled staking gap at block {} for {}/{}",
                    block,
                    account_id,
                    staking_pool
                );
                filled_count += 1;
            }
            Ok(None) => {
                log::warn!(
                    "Could not fill staking gap for {}/{} [{}-{}]",
                    account_id,
                    staking_pool,
                    gap.start_block,
                    gap.end_block
                );
            }
            Err(e) => {
                log::error!(
                    "Error filling staking gap for {}/{} [{}-{}]: {}",
                    account_id,
                    staking_pool,
                    gap.start_block,
                    gap.end_block,
                    e
                );
            }
        }
    }

    Ok(filled_count)
}

/// Track staking rewards and fill gaps for all discovered staking pools
///
/// This is the main entry point for staking rewards tracking. It:
/// 1. Creates epoch-based snapshots using `track_staking_rewards`
/// 2. Fills gaps between snapshots with exact STAKING_REWARD records
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR network configuration (archival RPC)
/// * `account_id` - Account to track staking rewards for
/// * `up_to_block` - Current block height
///
/// # Returns
/// Total number of records created (snapshots + filled gaps)
pub async fn track_and_fill_staking_rewards(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    up_to_block: i64,
) -> Result<usize, Box<dyn std::error::Error>> {
    // First, create epoch-based snapshots
    let snapshots_created = track_staking_rewards(pool, network, account_id, up_to_block).await?;

    // Then, discover all staking pools and fill gaps for each
    let staking_pools = discover_staking_pools(pool, account_id).await?;

    let mut gaps_filled = 0;
    for staking_pool in staking_pools {
        match fill_staking_gaps(pool, network, account_id, &staking_pool, up_to_block).await {
            Ok(count) => {
                gaps_filled += count;
            }
            Err(e) => {
                log::error!(
                    "Error filling staking gaps for {}/{}: {}",
                    account_id,
                    staking_pool,
                    e
                );
            }
        }
    }

    Ok(snapshots_created + gaps_filled)
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
