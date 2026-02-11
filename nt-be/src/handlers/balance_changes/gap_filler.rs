//! Gap Filler Service
//!
//! This module implements the core gap filling logic using transaction resolution and RPC.
//! It orchestrates the detection and filling of gaps in balance change chains.
//!
//! # Overview
//!
//! When a gap is detected (balance_after of record N doesn't match balance_before of record N+1),
//! this service:
//! 1. Queries external transfer hint providers for known transfer blocks
//! 2. Uses transaction hash from hints to resolve exact blocks via `experimental_tx_status`
//! 3. Verifies the balance at resolved blocks matches expected
//! 4. Falls back to binary search only if hints are unavailable
//!
//! When transfer hints are available with transaction hashes, the exact block is found using
//! only 2-3 RPC calls (tx_status + block lookups) instead of O(log n) binary search calls.

use near_api::NetworkConfig;
use sqlx::PgPool;
use sqlx::types::BigDecimal;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use crate::handlers::balance_changes::{
    balance, binary_search, block_info,
    gap_detector::{self, BalanceGap},
    transfer_hints::{TransferHint, TransferHintService, tx_resolver},
    utils::block_timestamp_to_datetime,
};

/// Statistics about hint resolution for testing and debugging
#[derive(Debug, Default, Clone)]
pub struct HintResolutionStats {
    /// Blocks that were checked for balance
    pub checked_blocks: Vec<u64>,
    /// Which strategy found the result (if any):
    /// - "fastnear_balance" - Strategy 1: FastNear's start/end balance data
    /// - "tx_status" - Strategy 2: tx_status resolution from transaction hash
    /// - "direct_verification" - Strategy 3: Direct hint block verification
    /// - "binary_search" - Fallback: Binary search (hints failed)
    /// - None - No result found
    pub strategy_used: Option<String>,
    /// Number of hints processed before finding result (or total if not found)
    pub hints_processed: usize,
    /// The block height that was found (if any)
    pub found_block: Option<u64>,
}

/// Error type for gap filler operations
pub type GapFillerError = Box<dyn std::error::Error + Send + Sync>;

/// Result from hint-based block finding, includes the verified hint if available
#[derive(Debug, Clone)]
pub struct HintBlockResult {
    /// The block height where balance changed
    pub block_height: u64,
    /// The hint that was verified (if any), contains counterparty and tx info
    pub hint: Option<TransferHint>,
}

/// Find the block where balance changed using hints with tx_status resolution
///
/// This function uses a multi-step approach to find the exact block:
/// 1. Queries the hint service for transfer blocks in the range
/// 2. For each hint, checks if FastNear's balance data shows a change at that block
/// 3. If balance unchanged at hint block, uses tx_status to find the actual block
/// 4. Verifies the balance at resolved block matches expected
/// 5. Falls back to binary search only if hints are unavailable
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR network configuration (archival RPC)
/// * `hints` - Transfer hint service to query
/// * `account_id` - Account to search transfers for
/// * `token_id` - Token identifier
/// * `from_block` - Start of search range
/// * `to_block` - End of search range
/// * `expected_balance` - Balance we're looking for
///
/// # Returns
/// `Some(HintBlockResult)` if found, `None` if not found in range
#[allow(clippy::too_many_arguments)]
async fn find_block_with_hints(
    pool: &PgPool,
    network: &NetworkConfig,
    hint_service: &TransferHintService,
    account_id: &str,
    token_id: &str,
    from_block: u64,
    to_block: u64,
    expected_balance: &BigDecimal,
) -> Result<Option<HintBlockResult>, GapFillerError> {
    find_block_with_hints_tracked(
        pool,
        network,
        hint_service,
        account_id,
        token_id,
        from_block,
        to_block,
        expected_balance,
        None,
    )
    .await
}

/// Find block with hints and optionally track resolution statistics
///
/// This is the instrumented version that can track which blocks are checked.
/// Used for testing to verify no duplicate block checks occur.
#[allow(clippy::too_many_arguments)]
pub async fn find_block_with_hints_tracked(
    pool: &PgPool,
    network: &NetworkConfig,
    hint_service: &TransferHintService,
    account_id: &str,
    token_id: &str,
    from_block: u64,
    to_block: u64,
    expected_balance: &BigDecimal,
    stats: Option<Arc<Mutex<HintResolutionStats>>>,
) -> Result<Option<HintBlockResult>, GapFillerError> {
    // Track blocks we've already checked to avoid duplicate RPC calls
    let mut already_checked: HashSet<u64> = HashSet::new();
    let mut hints_processed: usize = 0;

    // Helper to record a checked block (for stats tracking)
    let record_check = |block: u64| {
        if let Some(ref stats) = stats
            && let Ok(mut s) = stats.lock()
        {
            s.checked_blocks.push(block);
        }
    };

    // Helper to record the final result
    let record_result = |strategy: &str, block: u64, hints_count: usize| {
        if let Some(ref stats) = stats
            && let Ok(mut s) = stats.lock()
        {
            s.strategy_used = Some(strategy.to_string());
            s.found_block = Some(block);
            s.hints_processed = hints_count;
        }
    };

    // Check if hints are available for this token type
    if !hint_service.supports_token(token_id) {
        log::debug!(
            "No hint providers support token {} - using binary search",
            token_id
        );
        return binary_search::find_balance_change_block(
            pool,
            network,
            account_id,
            token_id,
            from_block,
            to_block,
            expected_balance,
        )
        .await
        .map(|opt| {
            opt.map(|block| HintBlockResult {
                block_height: block,
                hint: None,
            })
        })
        .map_err(|e| e.to_string().into());
    }

    // Get hints from providers
    let hints = hint_service
        .get_hints(account_id, token_id, from_block, to_block)
        .await;

    if hints.is_empty() {
        log::debug!(
            "No hints found for {}/{} in blocks {}-{} - using binary search",
            account_id,
            token_id,
            from_block,
            to_block
        );
        return binary_search::find_balance_change_block(
            pool,
            network,
            account_id,
            token_id,
            from_block,
            to_block,
            expected_balance,
        )
        .await
        .map(|opt| {
            opt.map(|block| HintBlockResult {
                block_height: block,
                hint: None,
            })
        })
        .map_err(|e| e.to_string().into());
    }

    log::info!(
        "Got {} hints for {}/{} in blocks {}-{}, resolving exact blocks",
        hints.len(),
        account_id,
        token_id,
        from_block,
        to_block
    );

    // Try each hint
    for hint in &hints {
        hints_processed += 1;

        // Strategy 1: Check if FastNear's balance data shows a change at this block
        // If start_of_block_balance != end_of_block_balance, the change happened here
        if let (Some(start_balance), Some(end_balance)) =
            (&hint.start_of_block_balance, &hint.end_of_block_balance)
            && start_balance != end_balance
            && !already_checked.contains(&hint.block_height)
        {
            // Balance changed at this exact block - verify with RPC
            already_checked.insert(hint.block_height);
            record_check(hint.block_height);
            let balance_at_hint = match balance::get_balance_at_block(
                pool,
                network,
                account_id,
                token_id,
                hint.block_height,
            )
            .await
            {
                Ok(b) => b,
                Err(e) => {
                    log::warn!(
                        "Failed to verify hint at block {}: {} - trying tx_status",
                        hint.block_height,
                        e
                    );
                    // Continue to tx_status resolution below
                    BigDecimal::from(0)
                }
            };

            if &balance_at_hint == expected_balance {
                log::info!(
                    "Hint verified via FastNear balance data: block {} for {}/{}",
                    hint.block_height,
                    account_id,
                    token_id
                );
                record_result("fastnear_balance", hint.block_height, hints_processed);
                return Ok(Some(HintBlockResult {
                    block_height: hint.block_height,
                    hint: Some(hint.clone()),
                }));
            }
        }

        // Strategy 2: Use tx_status to find exact block from transaction hash
        if let Some(tx_hash) = &hint.transaction_hash {
            log::debug!(
                "Using tx_status to resolve transaction {} for {}/{}",
                tx_hash,
                account_id,
                token_id
            );

            // Find blocks where receipts executed on our account
            // The caller verifies actual balance changes using get_balance_at_block
            let resolved_blocks =
                match tx_resolver::find_balance_change_blocks(network, tx_hash, account_id).await {
                    Ok(blocks) => blocks,
                    Err(e) => {
                        log::warn!(
                            "Failed to resolve tx {}: {} - trying direct verification",
                            tx_hash,
                            e
                        );
                        vec![]
                    }
                };

            if !resolved_blocks.is_empty() {
                log::debug!(
                    "tx_status resolved {} blocks for tx {}: {:?}",
                    resolved_blocks.len(),
                    tx_hash,
                    resolved_blocks
                );

                // Check each resolved block for matching balance
                for block_height in resolved_blocks {
                    if block_height < from_block || block_height > to_block {
                        continue; // Skip blocks outside our search range
                    }

                    // Skip if we've already checked this block
                    if already_checked.contains(&block_height) {
                        log::debug!(
                            "Skipping already-checked block {} in tx_status resolution",
                            block_height
                        );
                        continue;
                    }

                    already_checked.insert(block_height);
                    record_check(block_height);
                    let balance_at_block = match balance::get_balance_at_block(
                        pool,
                        network,
                        account_id,
                        token_id,
                        block_height,
                    )
                    .await
                    {
                        Ok(b) => b,
                        Err(e) => {
                            log::warn!(
                                "Failed to verify balance at resolved block {}: {}",
                                block_height,
                                e
                            );
                            continue;
                        }
                    };

                    if &balance_at_block == expected_balance {
                        log::info!(
                            "tx_status resolved exact block {} for {}/{} (tx: {})",
                            block_height,
                            account_id,
                            token_id,
                            tx_hash
                        );
                        record_result("tx_status", block_height, hints_processed);
                        return Ok(Some(HintBlockResult {
                            block_height,
                            hint: Some(hint.clone()),
                        }));
                    }
                }
            }
        }

        // Strategy 3: Direct verification at hint block (original logic)
        // Skip if we've already checked this block in Strategy 1 or 2
        if already_checked.contains(&hint.block_height) {
            log::debug!(
                "Skipping already-checked hint block {} in Strategy 3",
                hint.block_height
            );
            continue;
        }

        already_checked.insert(hint.block_height);
        record_check(hint.block_height);
        let balance_at_hint = match balance::get_balance_at_block(
            pool,
            network,
            account_id,
            token_id,
            hint.block_height,
        )
        .await
        {
            Ok(b) => b,
            Err(e) => {
                log::warn!(
                    "Failed to verify hint at block {}: {} - trying next hint",
                    hint.block_height,
                    e
                );
                continue;
            }
        };

        if &balance_at_hint == expected_balance {
            // Verify this is the FIRST block with this balance
            if hint.block_height > from_block {
                let prev_block = hint.block_height - 1;
                // Only check if we haven't already checked this block
                if already_checked.contains(&prev_block) {
                    // Already checked this block, assume it's valid
                    log::debug!(
                        "Skipping already-checked prev block {} - accepting hint",
                        prev_block
                    );
                    record_result("direct_verification", hint.block_height, hints_processed);
                    return Ok(Some(HintBlockResult {
                        block_height: hint.block_height,
                        hint: Some(hint.clone()),
                    }));
                }
                already_checked.insert(prev_block);
                record_check(prev_block);
                let balance_before = match balance::get_balance_at_block(
                    pool,
                    network,
                    account_id,
                    token_id,
                    hint.block_height - 1,
                )
                .await
                {
                    Ok(b) => b,
                    Err(e) => {
                        log::warn!(
                            "Failed to check balance before hint block {}: {} - accepting hint",
                            hint.block_height,
                            e
                        );
                        record_result("direct_verification", hint.block_height, hints_processed);
                        return Ok(Some(HintBlockResult {
                            block_height: hint.block_height,
                            hint: Some(hint.clone()),
                        }));
                    }
                };

                if &balance_before != expected_balance {
                    log::info!(
                        "Hint verified: balance changed at block {} for {}/{}",
                        hint.block_height,
                        account_id,
                        token_id
                    );
                    record_result("direct_verification", hint.block_height, hints_processed);
                    return Ok(Some(HintBlockResult {
                        block_height: hint.block_height,
                        hint: Some(hint.clone()),
                    }));
                }
            } else {
                record_result("direct_verification", hint.block_height, hints_processed);
                return Ok(Some(HintBlockResult {
                    block_height: hint.block_height,
                    hint: Some(hint.clone()),
                }));
            }
        }
    }

    // No valid hints found, fall back to binary search
    log::info!(
        "No valid hints resolved for {}/{} - falling back to binary search",
        account_id,
        token_id
    );

    // Record that we're falling back to binary search
    if let Some(ref stats) = stats
        && let Ok(mut s) = stats.lock()
    {
        s.hints_processed = hints_processed;
    }

    let result = binary_search::find_balance_change_block(
        pool,
        network,
        account_id,
        token_id,
        from_block,
        to_block,
        expected_balance,
    )
    .await
    .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    // Record binary search result
    if let Some(block) = result {
        record_result("binary_search", block, hints_processed);
    }

    Ok(result.map(|block| HintBlockResult {
        block_height: block,
        hint: None,
    }))
}

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
    fill_gap_with_hints(pool, network, gap, None).await
}

/// Fill a single gap using transfer hints when available
///
/// This is the hint-aware version of `fill_gap`. When a `TransferHintService` is provided,
/// it first queries external providers for known transfer blocks, then verifies the hints
/// with RPC. If hints are unavailable or incorrect, falls back to binary search.
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR network configuration (archival RPC)
/// * `gap` - The gap to fill
/// * `hint_service` - Optional transfer hint service for accelerated lookups
///
/// # Returns
/// The filled gap information, or an error if filling failed
pub async fn fill_gap_with_hints(
    pool: &PgPool,
    network: &NetworkConfig,
    gap: &BalanceGap,
    hint_service: Option<&TransferHintService>,
) -> Result<FilledGap, GapFillerError> {
    // Binary search to find the exact block where balance changed
    // Note: gap.expected_balance_before is the balance_before at gap.end_block,
    // which equals the balance at the END of (gap.end_block - 1).
    // The RPC returns balance at the end of a block, so we search up to end_block - 1.
    let search_end_block = (gap.end_block - 1) as u64;

    // Try hints first if available
    let hint_result = if let Some(hints) = hint_service {
        find_block_with_hints(
            pool,
            network,
            hints,
            &gap.account_id,
            &gap.token_id,
            gap.start_block as u64,
            search_end_block,
            &gap.expected_balance_before,
        )
        .await?
    } else {
        // No hints available, use pure binary search
        binary_search::find_balance_change_block(
            pool,
            network,
            &gap.account_id,
            &gap.token_id,
            gap.start_block as u64,
            search_end_block,
            &gap.expected_balance_before,
        )
        .await
        .map(|opt| {
            opt.map(|block| HintBlockResult {
                block_height: block,
                hint: None,
            })
        })
        .map_err(|e| -> GapFillerError { e.to_string().into() })?
    };

    let hint_result = hint_result.ok_or_else(|| -> GapFillerError {
        format!(
            "Could not find balance change block for gap: {} {} [{}-{}]",
            gap.account_id, gap.token_id, gap.start_block, gap.end_block
        )
        .into()
    })?;

    let block_height = hint_result.block_height;
    let hint = hint_result.hint;

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
            // Balance changed but no receipts found on this account
            // This happens for intents tokens where receipts execute on intents.near
            log::warn!(
                "No receipts found at block {} for {}/{} - checking for hint data",
                block_height,
                gap.account_id,
                gap.token_id
            );

            // If we have a hint with counterparty, use it
            if let Some(ref hint) = hint
                && hint.counterparty.is_some()
            {
                log::info!(
                    "Using hint counterparty {} for {}/{} at block {}",
                    hint.counterparty.as_ref().unwrap(),
                    gap.account_id,
                    gap.token_id,
                    block_height
                );
                return insert_balance_change_with_hint(
                    pool,
                    network,
                    &gap.account_id,
                    &gap.token_id,
                    block_height,
                    hint,
                )
                .await;
            }

            // No hint counterparty available, try SNAPSHOT or UNKNOWN
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
                        "Balance changed at block {} for {}/{} but no receipts or hint counterparty found - inserting UNKNOWN counterparty record",
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
    fill_gaps_with_hints(pool, network, account_id, token_id, up_to_block, None).await
}

/// Fill all gaps using transfer hints when available
///
/// This is the hint-aware version of `fill_gaps`. When a `TransferHintService` is provided,
/// it uses external APIs to accelerate finding transfer blocks before falling back to
/// binary search.
///
/// # Arguments
/// * `pool` - Database connection pool
/// * `network` - NEAR network configuration (archival RPC)
/// * `account_id` - Account to process
/// * `token_id` - Token to process
/// * `up_to_block` - Only process gaps up to this block height
/// * `hint_service` - Optional transfer hint service for accelerated lookups
///
/// # Returns
/// Vector of filled gaps
pub async fn fill_gaps_with_hints(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    up_to_block: i64,
    hint_service: Option<&TransferHintService>,
) -> Result<Vec<FilledGap>, GapFillerError> {
    log::info!(
        "Starting gap detection for {}/{} up to block {} (hints: {})",
        account_id,
        token_id,
        up_to_block,
        if hint_service.is_some() {
            "enabled"
        } else {
            "disabled"
        }
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
    if let Some(gap_record) = fill_gap_to_present(
        pool,
        network,
        account_id,
        token_id,
        up_to_block as u64,
        hint_service,
    )
    .await?
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
            let filled_gap = fill_gap_with_hints(pool, network, gap, hint_service).await?;
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
    if current_balance == 0 {
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

    // If block_height equals start_block, it means the balance was already at the target
    // value at the beginning of our search range. In this case, we should insert a SNAPSHOT
    // record rather than trying to find a transaction (which may not exist at this block).
    if block_height == start_block {
        log::info!(
            "Balance existed before search range, inserting SNAPSHOT at lookback boundary {}",
            start_block
        );
        return insert_snapshot_record(pool, network, account_id, token_id, start_block).await;
    }

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
    hint_service: Option<&TransferHintService>,
) -> Result<Option<FilledGap>, GapFillerError> {
    // Get the latest record
    let latest_record = sqlx::query!(
        r#"
        SELECT block_height, balance_after
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

    let from_block = (latest.block_height + 1) as u64;

    // Try hints first if available, otherwise use binary search
    let hint_result = if let Some(hints) = hint_service {
        find_block_with_hints(
            pool,
            network,
            hints,
            account_id,
            token_id,
            from_block,
            up_to_block,
            &current_balance,
        )
        .await?
    } else {
        binary_search::find_balance_change_block(
            pool,
            network,
            account_id,
            token_id,
            from_block,
            up_to_block,
            &current_balance,
        )
        .await
        .map(|opt| {
            opt.map(|block| HintBlockResult {
                block_height: block,
                hint: None,
            })
        })
        .map_err(|e| -> GapFillerError { e.to_string().into() })?
    };

    let Some(hint_result) = hint_result else {
        log::warn!(
            "Could not find balance change block for gap to present: {}/{} [{}-{}]",
            account_id,
            token_id,
            from_block,
            up_to_block
        );
        return Ok(None);
    };

    let block_height = hint_result.block_height;

    // Try to insert the balance change record with receipts
    match insert_balance_change_record(pool, network, account_id, token_id, block_height).await {
        Ok(Some(result)) => Ok(Some(result)),
        Ok(None) => Ok(None),
        Err(e) if e.to_string().contains("No receipt found") => {
            // No receipts found - check if we have hint counterparty
            if let Some(ref hint) = hint_result.hint
                && hint.counterparty.is_some()
            {
                log::info!(
                    "Using hint counterparty for gap to present at block {} for {}/{}",
                    block_height,
                    account_id,
                    token_id
                );
                return insert_balance_change_with_hint(
                    pool,
                    network,
                    account_id,
                    token_id,
                    block_height,
                    hint,
                )
                .await
                .map(Some);
            }
            // No hint counterparty, fall back to SNAPSHOT or UNKNOWN
            match insert_snapshot_record(pool, network, account_id, token_id, block_height).await {
                Ok(Some(snapshot)) => Ok(Some(snapshot)),
                Ok(None) | Err(_) => insert_unknown_counterparty_record(
                    pool,
                    network,
                    account_id,
                    token_id,
                    block_height,
                )
                .await
                .map(Some),
            }
        }
        Err(e) => Err(e),
    }
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
    if amount != 0 {
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

/// Insert a balance change record using hint data for counterparty and tx info
///
/// This is used when receipts can't be found on the user's account (e.g., for intents tokens
/// where receipts execute on intents.near), but the hint provides the counterparty and tx info.
pub async fn insert_balance_change_with_hint(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    block_height: u64,
    hint: &TransferHint,
) -> Result<FilledGap, GapFillerError> {
    // Get the actual balance change at this block
    let (balance_before, balance_after) =
        balance::get_balance_change_at_block(pool, network, account_id, token_id, block_height)
            .await
            .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    let amount = &balance_after - &balance_before;

    // Get block timestamp - prefer hint's timestamp if available
    let block_timestamp = if hint.timestamp_ms > 0 {
        (hint.timestamp_ms * 1_000_000) as i64 // Convert ms to ns
    } else {
        block_info::get_block_timestamp(network, block_height, None)
            .await
            .map_err(|e| -> GapFillerError { e.to_string().into() })?
    };

    // Use hint data
    let counterparty = hint.counterparty.as_deref().unwrap_or("UNKNOWN");
    let transaction_hashes: Vec<String> = hint
        .transaction_hash
        .as_ref()
        .map(|h| vec![h.clone()])
        .unwrap_or_default();
    let receipt_ids: Vec<String> = hint
        .receipt_id
        .as_ref()
        .map(|r| vec![r.clone()])
        .unwrap_or_default();

    log::info!(
        "Inserting balance change with hint data at block {} for {}/{}: {} -> {} (counterparty: {}, tx: {:?})",
        block_height,
        account_id,
        token_id,
        balance_before,
        balance_after,
        counterparty,
        transaction_hashes
    );

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
        None::<String>,         // Signer not available from hint
        None::<String>,         // Receiver not available from hint
        counterparty,
        serde_json::json!({}),
        serde_json::json!({"source": "transfer_hint", "hint_block": hint.block_height})
    )
    .execute(pool)
    .await?;

    log::info!(
        "Inserted balance change from hint at block {} for {}/{} with counterparty {}",
        block_height,
        account_id,
        token_id,
        counterparty
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

/// Resolve FT counterparty by querying the token contract's state changes.
///
/// For FT transfers, the receipt executes on the token contract (not the monitored account).
/// This function:
/// 1. Queries `EXPERIMENTAL_changes` (data_changes) on the token contract to find the
///    receipt that caused state changes at this block
/// 2. Uses `EXPERIMENTAL_receipt` to fetch the receipt details (predecessor, actions)
/// 3. Parses `ft_transfer`/`ft_transfer_call` args to identify the counterparty
///
/// Returns (signer, receiver, counterparty, receipt_ids) matching the format expected by
/// `insert_balance_change_record`.
async fn resolve_ft_counterparty_from_token_contract(
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    block_height: u64,
) -> Result<(Option<String>, Option<String>, String, Vec<String>), GapFillerError> {
    use crate::utils::jsonrpc::create_rpc_client;
    use base64::{Engine, engine::general_purpose};
    use near_jsonrpc_client::methods;
    use near_jsonrpc_primitives::types::receipts::ReceiptReference;
    use near_primitives::types::{BlockId, BlockReference};
    use near_primitives::views::StateChangesRequestView;

    let client =
        create_rpc_client(network).map_err(|e| -> GapFillerError { e.to_string().into() })?;

    // Step 1: Query data_changes on the token contract to find the receipt that caused changes
    let parsed_token_id: near_primitives::types::AccountId = token_id.parse().map_err(
        |e: near_primitives::account::id::ParseAccountError| -> GapFillerError {
            e.to_string().into()
        },
    )?;

    let changes_response = super::utils::with_transport_retry("ft_data_changes", || {
        let req = methods::EXPERIMENTAL_changes::RpcStateChangesInBlockByTypeRequest {
            block_reference: BlockReference::BlockId(BlockId::Height(block_height)),
            state_changes_request: StateChangesRequestView::DataChanges {
                account_ids: vec![parsed_token_id.clone()],
                key_prefix: near_primitives::types::StoreKey::from(vec![]),
            },
        };
        client.call(req)
    })
    .await
    .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    // Collect unique receipt hashes from the state changes
    let mut receipt_hashes = HashSet::new();
    for change in &changes_response.changes {
        use near_primitives::views::StateChangeCauseView;
        if let StateChangeCauseView::ReceiptProcessing { receipt_hash } = &change.cause {
            receipt_hashes.insert(receipt_hash.to_string());
        }
    }

    log::debug!(
        "FT counterparty resolution: {} data changes on {} at block {}, {} unique receipts",
        changes_response.changes.len(),
        token_id,
        block_height,
        receipt_hashes.len()
    );

    if receipt_hashes.is_empty() {
        return Err(format!(
            "No data changes found on token contract {} at block {}",
            token_id, block_height
        )
        .into());
    }

    // Step 2: For each receipt, fetch it and check if it's an ft_transfer involving our account
    for receipt_hash in &receipt_hashes {
        let parsed_receipt_id = match receipt_hash.parse() {
            Ok(id) => id,
            Err(_) => continue,
        };

        let receipt = match super::utils::with_transport_retry("ft_receipt_lookup", || {
            let req = methods::EXPERIMENTAL_receipt::RpcReceiptRequest {
                receipt_reference: ReceiptReference {
                    receipt_id: parsed_receipt_id,
                },
            };
            client.call(req)
        })
        .await
        {
            Ok(r) => r,
            Err(e) => {
                log::warn!("Failed to fetch receipt {}: {} - skipping", receipt_hash, e);
                continue;
            }
        };

        // Step 3: Check if this receipt has ft_transfer/ft_transfer_call actions

        if let near_primitives::views::ReceiptEnumView::Action { actions, .. } = &receipt.receipt {
            for action in actions {
                if let near_primitives::views::ActionView::FunctionCall { method_name, .. } = action
                {
                    if method_name != "ft_transfer" && method_name != "ft_transfer_call" {
                        continue;
                    }

                    // Parse args to find the transfer recipient.
                    // ActionView serializes as {"FunctionCall": {"args": "...", ...}}
                    let action_json = match serde_json::to_value(action) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let fc_obj = match action_json.get("FunctionCall") {
                        Some(v) => v,
                        None => continue,
                    };
                    let args_b64 = match fc_obj.get("args").and_then(|v| v.as_str()) {
                        Some(s) => s,
                        None => continue,
                    };
                    let args_bytes = match general_purpose::STANDARD.decode(args_b64) {
                        Ok(b) => b,
                        Err(_) => continue,
                    };
                    let args_json: serde_json::Value = match serde_json::from_slice(&args_bytes) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let transfer_receiver =
                        match args_json.get("receiver_id").and_then(|v| v.as_str()) {
                            Some(s) => s,
                            None => continue,
                        };

                    let predecessor = receipt.predecessor_id.to_string();
                    let receipt_id = receipt.receipt_id.to_string();

                    if transfer_receiver == account_id {
                        // Incoming transfer: someone sent FT to our account
                        log::info!(
                            "Resolved FT counterparty: {} sent {} to {} at block {}",
                            predecessor,
                            token_id,
                            account_id,
                            block_height
                        );
                        return Ok((
                            Some(predecessor.clone()),
                            Some(token_id.to_string()),
                            predecessor,
                            vec![receipt_id],
                        ));
                    } else if predecessor == account_id {
                        // Outgoing transfer: our account sent FT to someone
                        log::info!(
                            "Resolved FT counterparty: {} sent {} to {} at block {}",
                            account_id,
                            token_id,
                            transfer_receiver,
                            block_height
                        );
                        return Ok((
                            Some(account_id.to_string()),
                            Some(token_id.to_string()),
                            transfer_receiver.to_string(),
                            vec![receipt_id],
                        ));
                    }
                }
            }
        }
    }

    Err(format!(
        "No FT transfer receipt found at block {} for {}/{}",
        block_height, account_id, token_id
    )
    .into())
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
    let (final_signer, final_receiver, final_counterparty, receipt_ids) = if signer_id.is_some() {
        // We have transaction info — get receipt_ids from account's receipts
        let block_data = block_info::get_block_data(network, account_id, block_height)
            .await
            .map_err(|e| -> GapFillerError { e.to_string().into() })?;
        let receipt_ids: Vec<String> = block_data
            .receipts
            .iter()
            .map(|r| r.receipt_id.to_string())
            .collect();
        (signer_id, receiver_id, counterparty, receipt_ids)
    } else {
        let block_data = block_info::get_block_data(network, account_id, block_height)
            .await
            .map_err(|e| -> GapFillerError { e.to_string().into() })?;

        if let Some(receipt) = block_data.receipts.first() {
            let receipt_ids: Vec<String> = block_data
                .receipts
                .iter()
                .map(|r| r.receipt_id.to_string())
                .collect();
            (
                Some(receipt.predecessor_id.to_string()),
                Some(receipt.receiver_id.to_string()),
                receipt.predecessor_id.to_string(),
                receipt_ids,
            )
        } else if token_id != "near" && !token_id.starts_with("intents.near:") {
            // For FT tokens, receipts execute on the token contract, not the monitored account.
            // Look for ft_transfer/ft_transfer_call receipts on the token contract.
            // Skip intents tokens — they use a different swap mechanism and their token IDs
            // are not valid NEAR account IDs.
            resolve_ft_counterparty_from_token_contract(network, account_id, token_id, block_height)
                .await?
        } else if token_id.starts_with("intents.near:") {
            // Intents tokens use a different swap mechanism — counterparty is resolved
            // later by the swap detector. Use "UNKNOWN" as placeholder.
            log::debug!(
                "Intents token {} at block {} — counterparty will be resolved by swap detector",
                token_id,
                block_height
            );
            (None, None, "UNKNOWN".to_string(), vec![])
        } else {
            // If no receipt found for NEAR token, we cannot determine counterparty
            return Err(format!(
                "No receipt found for block {} - cannot determine counterparty",
                block_height
            )
            .into());
        }
    };

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
        // Block 151386339: balance changed from "0.688221126630537100000000" to "5.688221126630537100000000" NEAR
        use std::str::FromStr;
        let gap = BalanceGap {
            account_id: "webassemblymusic-treasury.sputnik-dao.near".to_string(),
            token_id: "NEAR".to_string(),
            start_block: 151386300,
            end_block: 151386400,
            actual_balance_after: BigDecimal::from_str("0.688221126630537100000000").unwrap(),
            expected_balance_before: BigDecimal::from_str("5.688221126630537100000000").unwrap(),
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
