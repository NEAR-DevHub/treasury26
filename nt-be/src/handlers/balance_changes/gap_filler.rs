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

use crate::handlers::balance_changes::{
    balance, binary_search, block_info,
    gap_detector::{self, BalanceGap},
    utils::block_timestamp_to_datetime,
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
    pub balance_before: bigdecimal::BigDecimal,
    pub balance_after: bigdecimal::BigDecimal,
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
        pool,
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

    // Try to insert the balance change record with receipts
    match insert_balance_change_record(pool, network, &gap.account_id, &gap.token_id, block_height)
        .await
    {
        Ok(Some(result)) => Ok(result),
        Ok(None) => Err(format!(
            "Failed to insert balance change for gap: {} {} at block {}",
            gap.account_id, gap.token_id, block_height
        )
        .into()),
        Err(e) if e.to_string().contains("No receipt found") => {
            // Balance changed but no receipts found
            // Try to insert SNAPSHOT (for cases where balance existed before but didn't change at this block)
            log::warn!(
                "No receipts found at block {} for {}/{} - attempting to insert SNAPSHOT or UNKNOWN record",
                block_height,
                gap.account_id,
                gap.token_id
            );

            match insert_snapshot_record(
                pool,
                network,
                &gap.account_id,
                &gap.token_id,
                block_height,
            )
            .await
            {
                Ok(Some(snapshot)) => {
                    log::info!(
                        "Inserted SNAPSHOT at block {} for {}/{} (balance existed but didn't change)",
                        block_height,
                        gap.account_id,
                        gap.token_id
                    );
                    Ok(snapshot)
                }
                Ok(None) | Err(_) => {
                    // SNAPSHOT insertion failed because balance actually changed
                    // Insert a record with UNKNOWN counterparty instead
                    log::warn!(
                        "Balance changed at block {} for {}/{} but no receipts found - inserting UNKNOWN counterparty record",
                        block_height,
                        gap.account_id,
                        gap.token_id
                    );
                    insert_unknown_counterparty_record(
                        pool,
                        network,
                        &gap.account_id,
                        &gap.token_id,
                        block_height,
                    )
                    .await
                }
            }
        }
        Err(e) => Err(e),
    }
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
            let filled_gap = fill_gap(pool, network, gap).await?;
            log::info!(
                "Filled gap at block {} for {}/{}",
                filled_gap.block_height,
                account_id,
                token_id
            );
            filled.push(filled_gap);
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
        balance::get_balance_at_block(pool, network, account_id, token_id, current_block)
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
    if current_balance == BigDecimal::from(0) {
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
        pool,
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
    let result =
        insert_balance_change_record(pool, network, account_id, token_id, block_height).await?;

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
    let current_balance =
        balance::get_balance_at_block(pool, network, account_id, token_id, up_to_block)
            .await
            .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    // If balance hasn't changed, no gap
    if current_balance.to_string() == latest.balance_after {
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
        pool,
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
/// If the earliest record's balance_before is not 0, OR if querying an earlier block
/// shows a non-zero balance, there was an earlier change that needs to be recorded.
///
/// This handles two cases:
/// 1. Earliest record has non-zero balance_before (obvious gap)
/// 2. Earliest record is a SNAPSHOT with 0 balance, but actual historical balance was non-zero
async fn fill_gap_to_past(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
) -> Result<Option<FilledGap>, GapFillerError> {
    // Get the earliest record
    let earliest_record = sqlx::query!(
        r#"
        SELECT block_height, balance_before::TEXT as "balance_before!", counterparty as "counterparty!"
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

    // Case 1: If balance_before is non-zero, we definitely have a gap
    let has_obvious_gap = earliest.balance_before != "0";

    // Case 2: Even if balance_before is 0, if this is a SNAPSHOT, we should check if there was
    // a non-zero balance before the lookback window (SNAPSHOT may have missed earlier history)
    let should_check_history =
        earliest.counterparty == "SNAPSHOT" && earliest.balance_before == "0";

    if !has_obvious_gap && !should_check_history {
        log::info!(
            "No gap to past: earliest record at block {} starts from 0 for {}/{} (not a SNAPSHOT)",
            earliest.block_height,
            account_id,
            token_id
        );
        return Ok(None);
    }

    // Search backwards - use a reasonable lookback (about 7 days to avoid hitting too-old blocks)
    let lookback_blocks: u64 = 600_000; // ~7 days
    let start_block = (earliest.block_height as u64).saturating_sub(lookback_blocks);

    // Check actual balance at the lookback boundary
    let balance_at_start =
        match balance::get_balance_at_block(pool, network, account_id, token_id, start_block).await
        {
            Ok(balance) => balance,
            Err(e) => {
                log::warn!(
                    "Could not query balance at block {} for {}/{}: {} - skipping gap to past",
                    start_block,
                    account_id,
                    token_id,
                    e
                );
                return Ok(None);
            }
        };

    // Always use the actual balance at lookback boundary as our target
    // Even if it's 0, we'll insert a SNAPSHOT at the boundary to mark we've checked back to this point
    // This prevents repeated expensive lookback searches on subsequent runs
    let target_balance = balance_at_start.clone();

    log::info!(
        "Gap to past detected: balance was {} at block {} but earliest record is at block {} with balance_before={} for {}/{}",
        balance_at_start,
        start_block,
        earliest.block_height,
        earliest.balance_before,
        account_id,
        token_id
    );

    log::info!(
        "Searching for gap to past for {}/{}: target balance '{}' at lookback boundary block {}",
        account_id,
        token_id,
        target_balance,
        start_block
    );

    // Binary search to find when the balance became target_balance
    // If this fails (e.g., RPC can't find old blocks), we gracefully give up
    let change_block = match binary_search::find_balance_change_block(
        pool,
        network,
        account_id,
        token_id,
        start_block,
        (earliest.block_height - 1) as u64, // Search before the earliest record
        &target_balance,
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
        log::warn!(
            "Balance {} existed before block {} - cannot find origin within lookback window for {}/{}. Consider inserting SNAPSHOT at boundary.",
            target_balance,
            start_block,
            account_id,
            token_id
        );

        // Insert a SNAPSHOT at the lookback boundary to record that balance existed there
        // This prevents repeated searches in future runs
        match insert_snapshot_record(pool, network, account_id, token_id, start_block).await {
            Ok(Some(snapshot)) => {
                log::info!(
                    "Inserted SNAPSHOT at lookback boundary block {} for {}/{} with balance {}",
                    start_block,
                    account_id,
                    token_id,
                    balance_at_start
                );
                return Ok(Some(snapshot));
            }
            Ok(None) => {
                log::warn!(
                    "Could not insert SNAPSHOT at block {} - balance may have changed",
                    start_block
                );
                return Ok(None);
            }
            Err(e) => {
                log::error!("Error inserting SNAPSHOT at block {}: {}", start_block, e);
                return Ok(None);
            }
        }
    };

    // Try to insert the new record
    // If it fails with "No receipt found", insert a SNAPSHOT instead at the lookback boundary
    match insert_balance_change_record(pool, network, account_id, token_id, block_height).await {
        Ok(result) => Ok(result),
        Err(e) if e.to_string().contains("No receipt found") => {
            log::info!(
                "No receipts found at block {} - balance existed before search range. Inserting SNAPSHOT at lookback boundary.",
                block_height
            );

            // Insert SNAPSHOT at the lookback boundary to mark where our search stopped
            insert_snapshot_record(pool, network, account_id, token_id, start_block).await
        }
        Err(e) => Err(e),
    }
}

/// Helper to insert a SNAPSHOT record at a specific block
///
/// This is used when the balance existed before our search range (e.g., lookback window).
/// Instead of trying to insert a transactional record (which would fail with "No receipt found"),
/// we insert a SNAPSHOT to mark the boundary of our search.
///
/// Verifies that no balance change occurred at this block by querying balance before and after.
pub async fn insert_snapshot_record(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    block_height: u64,
) -> Result<Option<FilledGap>, GapFillerError> {
    // Get balance before (at block N-1) and after (at block N) to verify no change occurred
    let (balance_before, balance_after) =
        balance::get_balance_change_at_block(pool, network, account_id, token_id, block_height)
            .await
            .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    // Get block timestamp
    let block_timestamp = block_info::get_block_timestamp(network, block_height, None)
        .await
        .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    let amount = &balance_after - &balance_before;

    // Verify this is actually a snapshot (no balance change)
    if amount != BigDecimal::from(0) {
        log::warn!(
            "Block {} has balance change {} -> {} (amount: {}), not inserting as SNAPSHOT",
            block_height,
            balance_before,
            balance_after,
            amount
        );
        return Err(format!(
            "Cannot insert SNAPSHOT at block {} - balance changed from {} to {}",
            block_height, balance_before, balance_after
        )
        .into());
    }

    // Insert SNAPSHOT: balance_before = balance_after (no change at this block)
    let block_time = block_timestamp_to_datetime(block_timestamp);

    sqlx::query!(
        r#"
        INSERT INTO balance_changes 
        (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, transaction_hashes, receipt_id, signer_id, receiver_id, counterparty, actions, raw_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (account_id, block_height, token_id) DO NOTHING
        "#,
        account_id,
        token_id,
        block_height as i64,
        block_timestamp,
        block_time,
        amount,           // amount = 0 for SNAPSHOT
        balance_before,   // balance_before = balance at (block_height - 1)
        balance_after,    // balance_after = balance at block_height
        &Vec::<String>::new(),
        &Vec::<String>::new(),
        None::<String>,
        None::<String>,
        "SNAPSHOT",
        serde_json::json!({}),
        serde_json::json!({})
    )
    .execute(pool)
    .await?;

    log::info!(
        "Inserted SNAPSHOT at block {} for {}/{}: {} -> {} (lookback boundary)",
        block_height,
        account_id,
        token_id,
        balance_before,
        balance_after
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

/// Helper to insert a balance change record with UNKNOWN counterparty
///
/// Used when a balance change is detected but no receipts can be found to determine
/// the actual counterparty. This ensures the balance change chain remains complete
/// even when full transaction details are unavailable.
///
/// The counterparty can be resolved later through third-party APIs or manual investigation.
pub async fn insert_unknown_counterparty_record(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    block_height: u64,
) -> Result<FilledGap, GapFillerError> {
    // Get the actual balance change at this block
    let (balance_before, balance_after) =
        balance::get_balance_change_at_block(pool, network, account_id, token_id, block_height)
            .await
            .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    let amount = &balance_after - &balance_before;

    // Get block timestamp
    let block_timestamp = block_info::get_block_timestamp(network, block_height, None)
        .await
        .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    log::info!(
        "Inserting UNKNOWN counterparty record at block {} for {}/{}: {} -> {} (amount: {})",
        block_height,
        account_id,
        token_id,
        balance_before,
        balance_after,
        amount
    );

    // Insert record with UNKNOWN counterparty
    let block_time = block_timestamp_to_datetime(block_timestamp);

    sqlx::query!(
        r#"
        INSERT INTO balance_changes 
        (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, transaction_hashes, receipt_id, signer_id, receiver_id, counterparty, actions, raw_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (account_id, block_height, token_id) DO NOTHING
        "#,
        account_id,
        token_id,
        block_height as i64,
        block_timestamp,
        block_time,
        amount,
        balance_before,
        balance_after,
        &Vec::<String>::new(),  // No transaction hashes available
        &Vec::<String>::new(),  // No receipt IDs available
        None::<String>,         // No signer known
        None::<String>,         // No receiver known
        "UNKNOWN",              // Special counterparty value
        serde_json::json!({}),  // No actions available
        serde_json::json!({})   // No raw data available
    )
    .execute(pool)
    .await?;

    log::warn!(
        "Inserted UNKNOWN counterparty record at block {} for {}/{} - counterparty should be resolved later",
        block_height,
        account_id,
        token_id
    );

    Ok(FilledGap {
        account_id: account_id.to_string(),
        token_id: token_id.to_string(),
        block_height: block_height as i64,
        block_timestamp,
        balance_before,
        balance_after,
    })
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
        balance::get_balance_change_at_block(pool, network, account_id, token_id, block_height)
            .await
            .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    // Get block timestamp
    let block_timestamp = block_info::get_block_timestamp(network, block_height, None)
        .await
        .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    // Calculate amount
    let amount = &balance_after - &balance_before;

    // Get account changes to find the transaction hash that caused this balance change
    let account_changes = block_info::get_account_changes(network, account_id, block_height)
        .await
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

    // If we have a transaction hash, query the full transaction to get signer and receiver
    let (signer_id, receiver_id, counterparty) = if let Some(tx_hash) = transaction_hashes.first() {
        match block_info::get_transaction(network, tx_hash, account_id).await {
            Ok(tx_response) => {
                if let Some(ref final_outcome) = tx_response.final_execution_outcome {
                    // final_outcome is FinalExecutionOutcomeViewEnum
                    // Need to extract transaction from it
                    use near_primitives::views::FinalExecutionOutcomeViewEnum;
                    match final_outcome {
                        FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(outcome) => {
                            let tx = &outcome.transaction;
                            let signer = tx.signer_id.to_string();
                            let receiver = tx.receiver_id.to_string();

                            // Counterparty is the receiver when account is signer, or signer when account is receiver
                            let counterparty = if signer == account_id {
                                receiver.clone()
                            } else {
                                signer.clone()
                            };

                            (Some(signer), Some(receiver), counterparty)
                        }
                        FinalExecutionOutcomeViewEnum::FinalExecutionOutcomeWithReceipt(
                            outcome,
                        ) => {
                            let tx = &outcome.final_outcome.transaction;
                            let signer = tx.signer_id.to_string();
                            let receiver = tx.receiver_id.to_string();

                            let counterparty = if signer == account_id {
                                receiver.clone()
                            } else {
                                signer.clone()
                            };

                            (Some(signer), Some(receiver), counterparty)
                        }
                    }
                } else {
                    log::warn!("Transaction response has no final_execution_outcome");
                    (None, None, String::new())
                }
            }
            Err(e) => {
                log::warn!(
                    "Failed to query transaction {}: {} - will try receipts",
                    tx_hash,
                    e
                );
                // Fall back to receipt-based logic below
                (None, None, String::new())
            }
        }
    } else {
        (None, None, String::new())
    };

    // Get receipt data for additional context (if available)
    // Only use this if we don't have signer/receiver from transaction
    let (final_signer, final_receiver, final_counterparty) = if signer_id.is_some() {
        (signer_id, receiver_id, counterparty)
    } else {
        let block_data = block_info::get_block_data(network, account_id, block_height)
            .await
            .map_err(|e| -> GapFillerError { e.to_string().into() })?;

        if let Some(receipt) = block_data.receipts.first() {
            (
                Some(receipt.predecessor_id.to_string()),
                Some(receipt.receiver_id.to_string()),
                receipt.predecessor_id.to_string(),
            )
        } else {
            // If no receipt found, we cannot determine counterparty - this is an error condition
            return Err(format!(
                "No receipt found for block {} - cannot determine counterparty",
                block_height
            )
            .into());
        }
    };

    // Always get receipt data for receipt_ids
    let block_data = block_info::get_block_data(network, account_id, block_height)
        .await
        .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    // Build receipt_ids array from block data
    let receipt_ids: Vec<String> = block_data
        .receipts
        .iter()
        .map(|r| r.receipt_id.to_string())
        .collect();

    // Insert the record
    let block_time = block_timestamp_to_datetime(block_timestamp);

    sqlx::query!(
        r#"
        INSERT INTO balance_changes 
        (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, transaction_hashes, receipt_id, signer_id, receiver_id, counterparty, actions, raw_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (account_id, block_height, token_id) DO NOTHING
        "#,
        account_id,
        token_id,
        block_height as i64,
        block_timestamp,
        block_time,
        amount,
        balance_before,
        balance_after,
        &transaction_hashes[..],
        &receipt_ids[..],
        final_signer,
        final_receiver,
        final_counterparty,
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
        // Block 151386339: balance changed from "6.1002111266305371" to "11.1002111266305371" NEAR
        use std::str::FromStr;
        let gap = BalanceGap {
            account_id: "webassemblymusic-treasury.sputnik-dao.near".to_string(),
            token_id: "NEAR".to_string(),
            start_block: 151386300,
            end_block: 151386400,
            actual_balance_after: BigDecimal::from_str("6.1002111266305371").unwrap(),
            expected_balance_before: BigDecimal::from_str("11.1002111266305371").unwrap(),
        };

        // We can't actually insert without a real DB, but we can test the binary search part
        let change_block = binary_search::find_balance_change_block(
            &state.db_pool,
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
        // Block 159487770: balance changed from "0" to "0.00032868" (32868 raw with 8 decimals)
        use std::str::FromStr;
        let gap = BalanceGap {
            account_id: "webassemblymusic-treasury.sputnik-dao.near".to_string(),
            token_id: "intents.near:nep141:btc.omft.near".to_string(),
            start_block: 159487760,
            end_block: 159487780,
            actual_balance_after: BigDecimal::from_str("0").unwrap(),
            expected_balance_before: BigDecimal::from_str("0.00032868").unwrap(),
        };

        let change_block = binary_search::find_balance_change_block(
            &state.db_pool,
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
