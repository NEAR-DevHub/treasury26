//! Gap Filler Service
//!
//! This module implements the core gap filling logic using RPC-based binary search.
//! It orchestrates the detection and filling of gaps in balance change chains.
//!
//! # Overview
//!
//! When a gap is detected (balance_after of record N doesn't match balance_before of record N+1),
//! this service:
//! 1. Uses binary search to find the exact block where the balance changed
//! 2. Queries the balance before and after at that block
//! 3. Gets the block timestamp
//! 4. Inserts a new balance_change record to fill the gap
//!
//! This approach uses only RPC queries and doesn't require external APIs.

use near_api::NetworkConfig;
use sqlx::PgPool;
use sqlx::types::BigDecimal;
use std::str::FromStr;

use crate::handlers::balance_changes::{
    balance, binary_search, block_info,
    gap_detector::{self, BalanceGap},
};

/// Error type for gap filler operations
pub type GapFillerError = Box<dyn std::error::Error + Send + Sync>;

/// Result of filling a single gap
#[derive(Debug, Clone)]
pub struct FilledGap {
    pub account_id: String,
    pub token_id: String,
    pub block_height: i64,
    pub block_timestamp: i64,
    pub balance_before: String,
    pub balance_after: String,
}

/// Fill a single gap in the balance change chain
///
/// Uses binary search to find the exact block where the balance changed,
/// then inserts a new record to fill the gap.
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR network configuration (archival RPC)
/// * `gap` - The gap to fill
///
/// # Returns
/// The filled gap information, or an error if filling failed
pub async fn fill_gap(
    pool: &PgPool,
    network: &NetworkConfig,
    gap: &BalanceGap,
) -> Result<FilledGap, GapFillerError> {
    // Binary search to find the exact block where balance changed
    // Note: gap.expected_balance_before is the balance_before at gap.end_block,
    // which equals the balance at the END of (gap.end_block - 1).
    // The RPC returns balance at the end of a block, so we search up to end_block - 1.
    let search_end_block = (gap.end_block - 1) as u64;

    let change_block = binary_search::find_balance_change_block(
        network,
        &gap.account_id,
        &gap.token_id,
        gap.start_block as u64,
        search_end_block,
        &gap.expected_balance_before,
    )
    .await
    .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    let block_height = change_block.ok_or_else(|| -> GapFillerError {
        format!(
            "Could not find balance change block for gap: {} {} [{}-{}]",
            gap.account_id, gap.token_id, gap.start_block, gap.end_block
        )
        .into()
    })?;

    // Use the shared insert helper
    let result = insert_balance_change_record(pool, network, &gap.account_id, &gap.token_id, block_height).await?;
    
    result.ok_or_else(|| -> GapFillerError {
        format!(
            "Failed to insert balance change for gap: {} {} at block {}",
            gap.account_id, gap.token_id, block_height
        )
        .into()
    })
}

/// Fill all gaps in the balance change chain for an account and token
///
/// Detects gaps and fills them one by one using RPC binary search.
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR network configuration (archival RPC)
/// * `account_id` - Account to process
/// * `token_id` - Token to process
/// * `up_to_block` - Only process gaps up to this block height
///
/// # Returns
/// Number of gaps successfully filled
pub async fn fill_gaps(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    up_to_block: i64,
) -> Result<Vec<FilledGap>, GapFillerError> {
    log::info!(
        "Starting gap detection for {}/{} up to block {}",
        account_id,
        token_id,
        up_to_block
    );

    // Check if there are any records at all - if not, seed initial balance first
    let existing_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM balance_changes WHERE account_id = $1 AND token_id = $2",
    )
    .bind(account_id)
    .bind(token_id)
    .fetch_one(pool)
    .await?;

    let mut filled = Vec::new();

    if existing_count.0 == 0 {
        log::info!(
            "No existing records for {}/{}, seeding initial balance",
            account_id,
            token_id
        );

        if let Some(seed_record) = seed_initial_balance(
            pool,
            network,
            account_id,
            token_id,
            up_to_block as u64,
            None, // Use default lookback
        )
        .await?
        {
            filled.push(seed_record);
        }

        // After seeding, we have at most one record - continue to check for more gaps
    }

    // --- Fill gap to present (virtual end boundary) ---
    // Check if current balance differs from the latest record's balance_after
    if let Some(gap_record) =
        fill_gap_to_present(pool, network, account_id, token_id, up_to_block as u64).await?
    {
        filled.push(gap_record);
    }

    // --- Fill gap to past (virtual start boundary) ---
    // Check if earliest record's balance_before is not 0
    if let Some(gap_record) = fill_gap_to_past(pool, network, account_id, token_id).await? {
        filled.push(gap_record);
    }

    // --- Fill gaps between existing records ---
    let gaps = gap_detector::find_gaps(pool, account_id, token_id, up_to_block).await?;

    if gaps.is_empty() {
        log::info!("No gaps between records for {}/{}", account_id, token_id);
    } else {
        log::info!(
            "Found {} gaps for {}/{} up to block {}",
            gaps.len(),
            account_id,
            token_id,
            up_to_block
        );

        for gap in &gaps {
            match fill_gap(pool, network, gap).await {
                Ok(filled_gap) => {
                    log::info!(
                        "Filled gap at block {} for {}/{}",
                        filled_gap.block_height,
                        account_id,
                        token_id
                    );
                    filled.push(filled_gap);
                }
                Err(e) => {
                    log::error!(
                        "Failed to fill gap [{}-{}] for {}/{}: {}",
                        gap.start_block,
                        gap.end_block,
                        account_id,
                        token_id,
                        e
                    );
                    // Continue with other gaps
                }
            }
        }
    }

    Ok(filled)
}

/// Seed the initial balance record when no data exists for an account/token
///
/// This function bootstraps the balance tracking by:
/// 1. Querying the current balance at the latest block
/// 2. Using binary search to find when the balance became that value
/// 3. Inserting the initial balance change record
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR network configuration (archival RPC)
/// * `account_id` - Account to seed
/// * `token_id` - Token to seed
/// * `current_block` - Current block height to start from
/// * `lookback_blocks` - How many blocks to search back (default ~30 days worth)
///
/// # Returns
/// The seeded record, or None if the balance has been 0 throughout the search range
pub async fn seed_initial_balance(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    current_block: u64,
    lookback_blocks: Option<u64>,
) -> Result<Option<FilledGap>, GapFillerError> {
    // Check if there are already records for this account/token
    let existing_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM balance_changes WHERE account_id = $1 AND token_id = $2",
    )
    .bind(account_id)
    .bind(token_id)
    .fetch_one(pool)
    .await?;

    if existing_count.0 > 0 {
        log::info!(
            "Records already exist for {}/{}, skipping seed",
            account_id,
            token_id
        );
        return Ok(None);
    }

    // Get current balance
    let current_balance =
        balance::get_balance_at_block(network, account_id, token_id, current_block)
            .await
            .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    log::info!(
        "Current balance for {}/{} at block {}: {}",
        account_id,
        token_id,
        current_block,
        current_balance
    );

    // If balance is 0, nothing to seed
    if current_balance == "0" {
        log::info!("Balance is 0, nothing to seed");
        return Ok(None);
    }

    // Default lookback: ~30 days worth of blocks (1 block/sec * 86400 sec/day * 30 days)
    let lookback = lookback_blocks.unwrap_or(2_592_000);
    let start_block = current_block.saturating_sub(lookback);

    log::info!(
        "Searching for balance change from block {} to {}",
        start_block,
        current_block
    );

    // Binary search to find when the balance became the current value
    let change_block = binary_search::find_balance_change_block(
        network,
        account_id,
        token_id,
        start_block,
        current_block,
        &current_balance,
    )
    .await
    .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    let block_height = match change_block {
        Some(block) => block,
        None => {
            log::info!(
                "Balance {} existed before block {}, cannot find origin in search range",
                current_balance,
                start_block
            );
            return Ok(None);
        }
    };

    log::info!(
        "Found balance change at block {} for {}/{}",
        block_height,
        account_id,
        token_id
    );

    // Use the shared insert helper
    let result = insert_balance_change_record(pool, network, account_id, token_id, block_height).await?;
    
    if let Some(filled_gap) = &result {
        log::info!(
            "Seeded initial balance record at block {} for {}/{}: {} -> {}",
            filled_gap.block_height,
            account_id,
            token_id,
            filled_gap.balance_before,
            filled_gap.balance_after
        );
    }
    
    Ok(result)
}

/// Fill gap between the latest record and current balance (virtual end boundary)
///
/// If the current balance at up_to_block differs from the latest record's balance_after,
/// there's a gap to fill.
async fn fill_gap_to_present(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    up_to_block: u64,
) -> Result<Option<FilledGap>, GapFillerError> {
    // Get the latest record
    let latest_record = sqlx::query!(
        r#"
        SELECT block_height, balance_after::TEXT as "balance_after!"
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height DESC
        LIMIT 1
        "#,
        account_id,
        token_id
    )
    .fetch_optional(pool)
    .await?;

    let Some(latest) = latest_record else {
        return Ok(None); // No records exist
    };

    // Get current balance at up_to_block
    let current_balance = balance::get_balance_at_block(network, account_id, token_id, up_to_block)
        .await
        .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    // If balance hasn't changed, no gap
    if current_balance == latest.balance_after {
        log::info!(
            "No gap to present: balance unchanged at {} for {}/{}",
            current_balance,
            account_id,
            token_id
        );
        return Ok(None);
    }

    log::info!(
        "Gap to present detected: {} -> {} for {}/{}, searching blocks {}-{}",
        latest.balance_after,
        current_balance,
        account_id,
        token_id,
        latest.block_height,
        up_to_block
    );

    // Binary search to find when the balance changed
    let change_block = binary_search::find_balance_change_block(
        network,
        account_id,
        token_id,
        (latest.block_height + 1) as u64, // Start after the latest record
        up_to_block,
        &current_balance,
    )
    .await
    .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    let Some(block_height) = change_block else {
        log::warn!(
            "Could not find balance change block for gap to present: {}/{} [{}-{}]",
            account_id,
            token_id,
            latest.block_height + 1,
            up_to_block
        );
        return Ok(None);
    };

    // Insert the new record
    insert_balance_change_record(pool, network, account_id, token_id, block_height).await
}

/// Fill gap between the earliest record and zero balance (virtual start boundary)
///
/// If the earliest record's balance_before is not 0, there was an earlier change
/// that brought the balance from 0 to that value.
async fn fill_gap_to_past(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
) -> Result<Option<FilledGap>, GapFillerError> {
    // Get the earliest record
    let earliest_record = sqlx::query!(
        r#"
        SELECT block_height, balance_before::TEXT as "balance_before!"
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height ASC
        LIMIT 1
        "#,
        account_id,
        token_id
    )
    .fetch_optional(pool)
    .await?;

    let Some(earliest) = earliest_record else {
        return Ok(None); // No records exist
    };

    // If balance_before is 0, we've reached the beginning
    if earliest.balance_before == "0" {
        log::info!(
            "No gap to past: earliest record at block {} starts from 0 for {}/{}",
            earliest.block_height,
            account_id,
            token_id
        );
        return Ok(None);
    }

    log::info!(
        "Gap to past detected: balance_before={} at block {} for {}/{}",
        earliest.balance_before,
        earliest.block_height,
        account_id,
        token_id
    );

    // Search backwards - we need to find when balance became earliest.balance_before
    // Use a reasonable lookback (about 7 days to avoid hitting too-old blocks)
    let lookback_blocks: u64 = 600_000; // ~7 days
    let start_block = (earliest.block_height as u64).saturating_sub(lookback_blocks);

    log::info!(
        "Searching for gap to past for {}/{}: {}-{} with balance {}",
        account_id,
        token_id,
        start_block,
        (earliest.block_height - 1) as u64,
        &earliest.balance_before
    );
    // Binary search to find when the balance became balance_before
    // If this fails (e.g., RPC can't find old blocks), we gracefully give up
    let change_block = match binary_search::find_balance_change_block(
        network,
        account_id,
        token_id,
        start_block,
        (earliest.block_height - 1) as u64, // Search before the earliest record
        &earliest.balance_before,
    )
    .await
    {
        Ok(block) => block,
        Err(e) => {
            log::warn!(
                "Error searching for gap to past for {}/{}: {} - will retry on next call",
                account_id,
                token_id,
                e
            );
            return Ok(None);
        }
    };

    let Some(block_height) = change_block else {
        log::info!(
            "Balance {} existed before block {} - may need larger lookback for {}/{}",
            earliest.balance_before,
            start_block,
            account_id,
            token_id
        );
        return Ok(None);
    };

    // Insert the new record
    insert_balance_change_record(pool, network, account_id, token_id, block_height).await
}

/// Helper to insert a balance change record at a specific block
/// 
/// This is exposed for testing purposes to allow direct insertion of records
/// at specific blocks to verify transaction hash capture.
pub async fn insert_balance_change_record(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    block_height: u64,
) -> Result<Option<FilledGap>, GapFillerError> {
    // Get balance before and after at the change block
    let (balance_before, balance_after) =
        balance::get_balance_change_at_block(network, account_id, token_id, block_height)
            .await
            .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    // Get block timestamp
    let block_timestamp = block_info::get_block_timestamp(network, block_height, None)
        .await
        .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    // Calculate amount
    let before_bd = BigDecimal::from_str(&balance_before)?;
    let after_bd = BigDecimal::from_str(&balance_after)?;
    let amount = &after_bd - &before_bd;

    // Get account changes to find the transaction hash that caused this balance change
    let account_changes = block_info::get_account_changes(network, account_id, block_height).await
        .map_err(|e| -> GapFillerError { e.to_string().into() })?;
    
    // Extract transaction hash and other details from account changes
    let (transaction_hashes, raw_data) = if let Some(change) = account_changes.first() {
        use near_primitives::views::StateChangeCauseView;
        
        let tx_hashes = match &change.cause {
            StateChangeCauseView::TransactionProcessing { tx_hash } => vec![tx_hash.to_string()],
            _ => vec![],
        };
        
        let raw_data = serde_json::to_value(change).unwrap_or_else(|_| serde_json::json!({}));
        (tx_hashes, raw_data)
    } else {
        (vec![], serde_json::json!({}))
    };
    
    // Get receipt data for additional context (if available)
    let block_data = block_info::get_block_data(network, account_id, block_height).await
        .map_err(|e| -> GapFillerError { e.to_string().into() })?;
    
    // Build receipt_ids array from block data
    let receipt_ids: Vec<String> = block_data.receipts.iter()
        .map(|r| r.receipt_id.to_string())
        .collect();
    
    // Extract signer/receiver/counterparty from receipts if available
    let (signer_id, receiver_id, counterparty) = if let Some(receipt) = block_data.receipts.first() {
        (
            Some(receipt.predecessor_id.to_string()),
            Some(receipt.receiver_id.to_string()),
            receipt.predecessor_id.to_string(),
        )
    } else {
        (None, None, "unknown".to_string())
    };

    // Insert the record
    sqlx::query!(
        r#"
        INSERT INTO balance_changes 
        (account_id, token_id, block_height, block_timestamp, amount, balance_before, balance_after, transaction_hashes, receipt_id, signer_id, receiver_id, counterparty, actions, raw_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (account_id, block_height, token_id) DO NOTHING
        "#,
        account_id,
        token_id,
        block_height as i64,
        block_timestamp,
        amount,
        before_bd,
        after_bd,
        &transaction_hashes[..],
        &receipt_ids[..],
        signer_id,
        receiver_id,
        counterparty,
        serde_json::json!({}),
        raw_data
    )
    .execute(pool)
    .await?;

    log::info!(
        "Inserted balance change at block {} for {}/{}: {} -> {} (tx_hashes: {:?}, receipts: {})",
        block_height,
        account_id,
        token_id,
        balance_before,
        balance_after,
        transaction_hashes,
        receipt_ids.len()
    );

    Ok(Some(FilledGap {
        account_id: account_id.to_string(),
        token_id: token_id.to_string(),
        block_height: block_height as i64,
        block_timestamp,
        balance_before,
        balance_after,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_utils::init_test_state;

    #[tokio::test]
    async fn test_fill_gap_finds_correct_block() {
        let state = init_test_state().await;

        // Create a simulated gap based on real test data
        // Block 151386339: balance changed from "6100211126630537100000000" to "11100211126630537100000000"
        let gap = BalanceGap {
            account_id: "webassemblymusic-treasury.sputnik-dao.near".to_string(),
            token_id: "NEAR".to_string(),
            start_block: 151386338,
            end_block: 151386340,
            actual_balance_after: "6100211126630537100000000".to_string(),
            expected_balance_before: "11100211126630537100000000".to_string(),
        };

        // We can't actually insert without a real DB, but we can test the binary search part
        let change_block = binary_search::find_balance_change_block(
            &state.archival_network,
            &gap.account_id,
            &gap.token_id,
            gap.start_block as u64,
            gap.end_block as u64,
            &gap.expected_balance_before,
        )
        .await
        .unwrap();

        assert_eq!(
            change_block,
            Some(151386339),
            "Should find the correct block"
        );
    }

    #[tokio::test]
    async fn test_fill_gap_intents_token() {
        let state = init_test_state().await;

        // Test with intents BTC token
        // Block 159487770: balance changed from "0" to "32868"
        let gap = BalanceGap {
            account_id: "webassemblymusic-treasury.sputnik-dao.near".to_string(),
            token_id: "intents.near:nep141:btc.omft.near".to_string(),
            start_block: 159487760,
            end_block: 159487780,
            actual_balance_after: "0".to_string(),
            expected_balance_before: "32868".to_string(),
        };

        let change_block = binary_search::find_balance_change_block(
            &state.archival_network,
            &gap.account_id,
            &gap.token_id,
            gap.start_block as u64,
            gap.end_block as u64,
            &gap.expected_balance_before,
        )
        .await
        .unwrap();

        assert_eq!(
            change_block,
            Some(159487770),
            "Should find the correct intents block"
        );
    }
}
