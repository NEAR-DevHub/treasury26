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
    transfer_hints::{TransferHint, TransferHintService, neardata::NeardataClient, tx_resolver},
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
        tracing::debug!(
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
        tracing::debug!(
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

    tracing::info!(
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
                    tracing::warn!(
                        "Failed to verify hint at block {}: {} - trying tx_status",
                        hint.block_height,
                        e
                    );
                    // Continue to tx_status resolution below
                    BigDecimal::from(0)
                }
            };

            if &balance_at_hint == expected_balance {
                tracing::info!(
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
            tracing::debug!(
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
                        tracing::warn!(
                            "Failed to resolve tx {}: {} - trying direct verification",
                            tx_hash,
                            e
                        );
                        vec![]
                    }
                };

            if !resolved_blocks.is_empty() {
                tracing::debug!(
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
                        tracing::debug!(
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
                            tracing::warn!(
                                "Failed to verify balance at resolved block {}: {}",
                                block_height,
                                e
                            );
                            continue;
                        }
                    };

                    if &balance_at_block == expected_balance {
                        tracing::info!(
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
            tracing::debug!(
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
                tracing::warn!(
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
                    tracing::debug!(
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
                        tracing::warn!(
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
                    tracing::info!(
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
    tracing::info!(
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
    fill_gap_with_hints(pool, network, gap, None, None).await
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
    neardata: Option<&NeardataClient>,
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
    match insert_balance_change_record(
        pool,
        network,
        &gap.account_id,
        &gap.token_id,
        block_height,
        neardata,
    )
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
            tracing::warn!(
                "No receipts found at block {} for {}/{} - checking for hint data",
                block_height,
                gap.account_id,
                gap.token_id
            );

            // If we have a hint with counterparty, use it
            if let Some(ref hint) = hint
                && hint.counterparty.is_some()
            {
                tracing::info!(
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
                    tracing::info!(
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
                    tracing::warn!(
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
    fill_gaps_with_hints(
        pool,
        network,
        account_id,
        token_id,
        up_to_block,
        None,
        None,
        None,
    )
    .await
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
#[allow(clippy::too_many_arguments)]
pub async fn fill_gaps_with_hints(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    up_to_block: i64,
    hint_service: Option<&TransferHintService>,
    creation_block: Option<i64>,
    neardata: Option<&NeardataClient>,
) -> Result<Vec<FilledGap>, GapFillerError> {
    tracing::info!(
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
        tracing::info!(
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
            creation_block,
            neardata,
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
        neardata,
    )
    .await?
    {
        filled.push(gap_record);
    }

    // --- Fill gap to past (virtual start boundary) ---
    // Check if earliest record's balance_before is not 0
    if let Some(gap_record) = fill_gap_to_past(
        pool,
        network,
        account_id,
        token_id,
        creation_block,
        neardata,
    )
    .await?
    {
        filled.push(gap_record);
    }

    // --- Fill gaps between existing records ---
    let gaps = gap_detector::find_gaps(pool, account_id, token_id, up_to_block).await?;

    if gaps.is_empty() {
        tracing::info!("No gaps between records for {}/{}", account_id, token_id);
    } else {
        tracing::info!(
            "Found {} gaps for {}/{} up to block {}",
            gaps.len(),
            account_id,
            token_id,
            up_to_block
        );

        for gap in &gaps {
            let filled_gap =
                fill_gap_with_hints(pool, network, gap, hint_service, neardata).await?;
            tracing::info!(
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
/// * `creation_block` - Account creation block (floor for lookback search)
///
/// # Returns
/// The seeded record, or None if the balance has been 0 throughout the search range
#[allow(clippy::too_many_arguments)]
pub async fn seed_initial_balance(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    current_block: u64,
    lookback_blocks: Option<u64>,
    creation_block: Option<i64>,
    neardata: Option<&NeardataClient>,
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
        tracing::info!(
            "Records already exist for {}/{}, skipping seed",
            account_id,
            token_id
        );
        return Ok(None);
    }

    // Get current balance (with fallback for unavailable blocks)
    let current_balance = balance::get_balance_at_block_with_fallback(
        pool,
        network,
        account_id,
        token_id,
        current_block,
        10,
    )
    .await
    .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    tracing::info!(
        "Current balance for {}/{} at block {}: {}",
        account_id,
        token_id,
        current_block,
        current_balance
    );

    // If balance is 0, nothing to seed
    if current_balance == 0 {
        tracing::info!("Balance is 0, nothing to seed");
        return Ok(None);
    }

    // Default lookback: ~30 days worth of blocks (1 block/sec * 86400 sec/day * 30 days)
    let lookback = lookback_blocks.unwrap_or(2_592_000);
    let mut start_block = current_block.saturating_sub(lookback);

    // If we know the account creation block, never search before it
    if let Some(creation) = creation_block {
        let creation = creation as u64;
        if creation > start_block {
            tracing::info!(
                "Clamping seed lookback from block {} to creation block {} for {}/{}",
                start_block,
                creation,
                account_id,
                token_id
            );
            start_block = creation;
        }
    }

    tracing::info!(
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
            tracing::info!(
                "Balance {} existed before block {}, cannot find origin in search range",
                current_balance,
                start_block
            );
            return Ok(None);
        }
    };

    tracing::info!(
        "Found balance change at block {} for {}/{}",
        block_height,
        account_id,
        token_id
    );

    // If block_height equals start_block, it means the balance was already at the target
    // value at the beginning of our search range. In this case, we should insert a SNAPSHOT
    // record rather than trying to find a transaction (which may not exist at this block).
    if block_height == start_block {
        tracing::info!(
            "Balance existed before search range, inserting SNAPSHOT at lookback boundary {}",
            start_block
        );
        return insert_snapshot_record(pool, network, account_id, token_id, start_block).await;
    }

    // Use the shared insert helper
    let result =
        insert_balance_change_record(pool, network, account_id, token_id, block_height, neardata)
            .await?;

    if let Some(filled_gap) = &result {
        tracing::info!(
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
    neardata: Option<&NeardataClient>,
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

    // Get current balance at up_to_block (with fallback for unavailable blocks)
    let current_balance = balance::get_balance_at_block_with_fallback(
        pool,
        network,
        account_id,
        token_id,
        up_to_block,
        10,
    )
    .await
    .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    // If balance hasn't changed, no gap
    if current_balance == latest.balance_after {
        tracing::info!(
            "No gap to present: balance unchanged at {} for {}/{}",
            current_balance,
            account_id,
            token_id
        );
        return Ok(None);
    }

    tracing::info!(
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
        tracing::warn!(
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
    match insert_balance_change_record(pool, network, account_id, token_id, block_height, neardata)
        .await
    {
        Ok(Some(result)) => Ok(Some(result)),
        Ok(None) => Ok(None),
        Err(e) if e.to_string().contains("No receipt found") => {
            // No receipts found - check if we have hint counterparty
            if let Some(ref hint) = hint_result.hint
                && hint.counterparty.is_some()
            {
                tracing::info!(
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
    creation_block: Option<i64>,
    neardata: Option<&NeardataClient>,
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
        tracing::info!(
            "No gap to past: earliest record at block {} starts from 0 for {}/{} (not a SNAPSHOT)",
            earliest.block_height,
            account_id,
            token_id
        );
        return Ok(None);
    }

    // If we know the account creation block and the earliest record is at or before it,
    // there's no history before account creation to search
    if let Some(creation) = creation_block
        && earliest.block_height <= creation
    {
        tracing::info!(
            "No gap to past: earliest record at block {} is at/before account creation block {} for {}/{}",
            earliest.block_height,
            creation,
            account_id,
            token_id
        );
        return Ok(None);
    }

    // Search backwards - use a reasonable lookback (about 7 days to avoid hitting too-old blocks)
    let lookback_blocks: u64 = 600_000; // ~7 days
    let mut start_block = (earliest.block_height as u64).saturating_sub(lookback_blocks);

    // If we know the account creation block, never search before it
    if let Some(creation) = creation_block {
        let creation = creation as u64;
        if creation > start_block {
            tracing::info!(
                "Clamping gap-to-past lookback from block {} to creation block {} for {}/{}",
                start_block,
                creation,
                account_id,
                token_id
            );
            start_block = creation;
        }
    }

    // If the clamped start_block is at or past the earliest record, nothing to search
    if start_block >= earliest.block_height as u64 {
        tracing::info!(
            "No gap to past: search range empty (start {} >= earliest {}) for {}/{}",
            start_block,
            earliest.block_height,
            account_id,
            token_id
        );
        return Ok(None);
    }

    // Check actual balance at the lookback boundary
    let balance_at_start =
        match balance::get_balance_at_block(pool, network, account_id, token_id, start_block).await
        {
            Ok(balance) => balance,
            Err(e) => {
                tracing::warn!(
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

    tracing::info!(
        "Gap to past detected: balance was {} at block {} but earliest record is at block {} with balance_before={} for {}/{}",
        balance_at_start,
        start_block,
        earliest.block_height,
        earliest.balance_before,
        account_id,
        token_id
    );

    tracing::info!(
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
            tracing::warn!(
                "Error searching for gap to past for {}/{}: {} - will retry on next call",
                account_id,
                token_id,
                e
            );
            return Ok(None);
        }
    };

    let Some(block_height) = change_block else {
        tracing::info!(
            "Balance {} existed before block {} - cannot find origin within lookback window for {}/{}. Inserting SNAPSHOT at boundary.",
            target_balance,
            start_block,
            account_id,
            token_id
        );

        // Insert a SNAPSHOT at the lookback boundary to record that balance existed there
        // This prevents repeated searches in future runs
        match insert_snapshot_record(pool, network, account_id, token_id, start_block).await {
            Ok(Some(snapshot)) => {
                tracing::info!(
                    "Inserted SNAPSHOT at lookback boundary block {} for {}/{} with balance {}",
                    start_block,
                    account_id,
                    token_id,
                    balance_at_start
                );
                return Ok(Some(snapshot));
            }
            Ok(None) => {
                tracing::warn!(
                    "Could not insert SNAPSHOT at block {} - balance may have changed",
                    start_block
                );
                return Ok(None);
            }
            Err(e) => {
                tracing::error!("Error inserting SNAPSHOT at block {}: {}", start_block, e);
                return Ok(None);
            }
        }
    };

    // Try to insert the new record
    // If it fails with "No receipt found", insert a SNAPSHOT instead at the lookback boundary
    match insert_balance_change_record(pool, network, account_id, token_id, block_height, neardata)
        .await
    {
        Ok(result) => Ok(result),
        Err(e) if e.to_string().contains("No receipt found") => {
            tracing::info!(
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
        tracing::warn!(
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
        (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, transaction_hashes, receipt_id, signer_id, receiver_id, counterparty, actions, raw_data, action_kind, method_name)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
        serde_json::json!({}),
        None::<String>,
        None::<String>
    )
    .execute(pool)
    .await?;

    tracing::info!(
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

    tracing::info!(
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
        (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, transaction_hashes, receipt_id, signer_id, receiver_id, counterparty, actions, raw_data, action_kind, method_name)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
        serde_json::json!({}),  // No raw data available
        None::<String>,         // No action_kind available
        None::<String>          // No method_name available
    )
    .execute(pool)
    .await?;

    tracing::warn!(
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

    tracing::info!(
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
        (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, transaction_hashes, receipt_id, signer_id, receiver_id, counterparty, actions, raw_data, action_kind, method_name)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
        serde_json::json!({"source": "transfer_hint", "hint_block": hint.block_height}),
        None::<String>,         // action_kind resolved later via backfill
        None::<String>          // method_name resolved later via backfill
    )
    .execute(pool)
    .await?;

    tracing::info!(
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

    tracing::debug!(
        "FT counterparty resolution: {} data changes on {} at block {}, {} unique receipts",
        changes_response.changes.len(),
        token_id,
        block_height,
        receipt_hashes.len()
    );

    if receipt_hashes.is_empty() {
        return Err(format!(
            "No receipt found - no data changes on token contract {} at block {}",
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
                tracing::warn!("Failed to fetch receipt {}: {} - skipping", receipt_hash, e);
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
                        tracing::info!(
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
                        tracing::info!(
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
        "No receipt found - no FT transfer receipt at block {} for {}/{}",
        block_height, account_id, token_id
    )
    .into())
}

/// Resolve missing transaction hashes on existing balance_changes records.
///
/// Processes one record at a time so progress is committed after each update
/// and the process can be safely interrupted and resumed.
///
/// - Records with receipt_ids: uses `resolve_receipt_to_transaction` (fetches receipt
///   via `EXPERIMENTAL_receipt` to get the on-chain signer, then traces via account_changes).
/// - Intents tokens without receipt_ids: queries `account_changes` on `intents.near`.
///
/// Returns the number of records updated.
pub async fn resolve_missing_tx_hashes(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    limit: usize,
) -> Result<usize, GapFillerError> {
    let mut resolved = 0usize;
    let mut attempted = 0usize;

    loop {
        if attempted >= limit {
            break;
        }
        // Fetch one record at a time so each update is committed before the next
        let record = sqlx::query!(
            r#"
            SELECT token_id as "token_id?", block_height, receipt_id
            FROM balance_changes
            WHERE account_id = $1
              AND transaction_hashes = '{}'
              AND counterparty NOT IN ('SNAPSHOT', 'STAKING_SNAPSHOT', 'STAKING_REWARD')
              AND amount != 0
            ORDER BY block_height DESC
            LIMIT 1
            OFFSET $2
            "#,
            account_id,
            attempted as i64,
        )
        .fetch_optional(pool)
        .await
        .map_err(|e| -> GapFillerError { e.to_string().into() })?;

        let record = match record {
            Some(r) => r,
            None => break, // No more records to resolve
        };

        let block_height = record.block_height as u64;
        let token_id = record.token_id.as_deref().unwrap_or("");

        let tx_hashes = if !record.receipt_id.is_empty() {
            // Resolve receipt → transaction via EXPERIMENTAL_receipt + account_changes
            let mut hashes = Vec::new();
            for receipt_id in &record.receipt_id {
                match tx_resolver::resolve_receipt_to_transaction(network, receipt_id, block_height)
                    .await
                {
                    Ok(result) => {
                        hashes.push(result.transaction_hash);
                        break;
                    }
                    Err(e) => {
                        tracing::debug!("Could not resolve receipt {} to tx: {}", receipt_id, e);
                    }
                }
            }
            hashes
        } else if token_id.starts_with("intents.near:") {
            // Intents tokens: query account_changes on intents.near, then filter
            // to only tx hashes whose receipt logs mention the monitored account.
            match block_info::get_account_changes(network, "intents.near", block_height).await {
                Ok(changes) => {
                    let mut candidates = Vec::new();
                    for change in &changes {
                        use near_primitives::views::StateChangeCauseView;
                        if let StateChangeCauseView::TransactionProcessing { tx_hash } =
                            &change.cause
                        {
                            let hash = tx_hash.to_string();
                            if !candidates.contains(&hash) {
                                candidates.push(hash);
                            }
                        }
                    }
                    // Single candidate must be correct; multiple need filtering.
                    if candidates.len() <= 1 {
                        candidates
                    } else {
                        let mut filtered = Vec::new();
                        for candidate in &candidates {
                            match block_info::get_transaction(network, candidate, "intents.near")
                                .await
                            {
                                Ok(tx_response) => {
                                    if tx_outcome_logs_mention_account(&tx_response, account_id) {
                                        filtered.push(candidate.clone());
                                    }
                                }
                                Err(_) => {
                                    // On error, include to avoid losing data
                                    filtered.push(candidate.clone());
                                }
                            }
                        }
                        filtered
                    }
                }
                Err(e) => {
                    tracing::debug!(
                        "Failed to query account_changes on intents.near at block {}: {}",
                        block_height,
                        e
                    );
                    vec![]
                }
            }
        } else {
            vec![]
        };

        attempted += 1;

        if !tx_hashes.is_empty() {
            sqlx::query!(
                r#"
                UPDATE balance_changes
                SET transaction_hashes = $1
                WHERE account_id = $2 AND block_height = $3 AND token_id = $4
                "#,
                &tx_hashes[..],
                account_id,
                record.block_height,
                record.token_id,
            )
            .execute(pool)
            .await
            .map_err(|e| -> GapFillerError { e.to_string().into() })?;

            resolved += 1;
            tracing::info!(
                "Resolved tx hash for {}/{} at block {}: {:?}",
                account_id,
                token_id,
                block_height,
                tx_hashes
            );
        }
    }

    Ok(resolved)
}

/// Resolve missing action_kind/method_name on existing balance_changes records.
///
/// Processes one record at a time so progress is committed after each update
/// and the process can be safely interrupted and resumed.
///
/// For each record, fetches the block's receipts for the account to determine
/// the receipt-level action (FunctionCall, Transfer, etc.).
///
/// Returns the number of records updated.
pub async fn resolve_missing_action_kind(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    limit: usize,
) -> Result<usize, GapFillerError> {
    let mut resolved = 0usize;
    let mut attempted = 0usize;

    loop {
        if attempted >= limit {
            break;
        }
        // Fetch one record at a time so each update is committed before the next
        let record = sqlx::query!(
            r#"
            SELECT block_height, token_id as "token_id?"
            FROM balance_changes
            WHERE account_id = $1
              AND action_kind IS NULL
              AND counterparty NOT IN ('SNAPSHOT', 'STAKING_SNAPSHOT', 'STAKING_REWARD')
              AND amount != 0
            ORDER BY block_height DESC
            LIMIT 1
            OFFSET $2
            "#,
            account_id,
            attempted as i64,
        )
        .fetch_optional(pool)
        .await
        .map_err(|e| -> GapFillerError { e.to_string().into() })?;

        let record = match record {
            Some(r) => r,
            None => break, // No more records to resolve
        };

        let block_height = record.block_height as u64;
        let token_id = record.token_id.as_deref().unwrap_or("");

        attempted += 1;

        // Try to get receipts at this block for the account
        let (action_kind, method_name) =
            match block_info::get_block_data(network, account_id, block_height).await {
                Ok(block_data) => extract_action_from_receipts(&block_data.receipts),
                Err(e) => {
                    tracing::debug!(
                        "Could not fetch block data for action_kind at block {}: {}",
                        block_height,
                        e
                    );
                    continue;
                }
            };

        if let Some(ref kind) = action_kind {
            sqlx::query!(
                r#"
                UPDATE balance_changes
                SET action_kind = $1, method_name = $2
                WHERE account_id = $3 AND block_height = $4 AND token_id = $5
                "#,
                kind,
                method_name,
                account_id,
                record.block_height,
                record.token_id,
            )
            .execute(pool)
            .await
            .map_err(|e| -> GapFillerError { e.to_string().into() })?;

            resolved += 1;
            tracing::info!(
                "Resolved action_kind for {}/{} at block {}: {}/{}",
                account_id,
                token_id,
                block_height,
                kind,
                method_name.as_deref().unwrap_or("-")
            );
        }
    }

    Ok(resolved)
}

/// Check whether any receipt outcome log in a transaction mentions the given account ID.
///
/// Used to filter intents.near candidate transaction hashes: since intents.near is a
/// high-traffic contract, multiple unrelated transactions may modify its state in the
/// same block. This function verifies that a transaction is actually relevant to a
/// specific account by searching its execution outcome logs.
fn tx_outcome_logs_mention_account(
    tx_response: &near_jsonrpc_client::methods::tx::RpcTransactionResponse,
    account_id: &str,
) -> bool {
    use near_primitives::views::FinalExecutionOutcomeViewEnum;

    let Some(ref final_outcome) = tx_response.final_execution_outcome else {
        return false;
    };

    let receipts_outcome = match final_outcome {
        FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(outcome) => &outcome.receipts_outcome,
        FinalExecutionOutcomeViewEnum::FinalExecutionOutcomeWithReceipt(outcome) => {
            &outcome.final_outcome.receipts_outcome
        }
    };

    for receipt_outcome in receipts_outcome {
        for log in &receipt_outcome.outcome.logs {
            if log.contains(account_id) {
                return true;
            }
        }
    }

    false
}

/// Extract (action_kind, method_name) from a list of receipts at a specific block.
///
/// Looks at the first receipt's first action to determine the action type.
/// Returns ("FunctionCall", Some(method_name)) for function calls,
/// ("Transfer", None) for transfers, etc.
fn extract_action_from_receipts(
    receipts: &[near_primitives::views::ReceiptView],
) -> (Option<String>, Option<String>) {
    use near_primitives::views::{ActionView, ReceiptEnumView};

    for receipt in receipts {
        if let ReceiptEnumView::Action { actions, .. } = &receipt.receipt
            && let Some(action) = actions.first()
        {
            let (kind, method) = match action {
                ActionView::FunctionCall { method_name, .. } => {
                    ("FunctionCall".to_string(), Some(method_name.clone()))
                }
                ActionView::Transfer { .. } => ("Transfer".to_string(), None),
                ActionView::DeployContract { .. } => ("DeployContract".to_string(), None),
                ActionView::CreateAccount => ("CreateAccount".to_string(), None),
                ActionView::DeleteAccount { .. } => ("DeleteAccount".to_string(), None),
                ActionView::AddKey { .. } => ("AddKey".to_string(), None),
                ActionView::DeleteKey { .. } => ("DeleteKey".to_string(), None),
                ActionView::Stake { .. } => ("Stake".to_string(), None),
                ActionView::Delegate { .. } => ("Delegate".to_string(), None),
                _ => ("Other".to_string(), None),
            };
            return (Some(kind), method);
        }
    }
    (None, None)
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
    neardata: Option<&NeardataClient>,
) -> Result<Option<FilledGap>, GapFillerError> {
    // Get balance before and after at the change block
    let (balance_before, balance_after) =
        balance::get_balance_change_at_block(pool, network, account_id, token_id, block_height)
            .await
            .map_err(|e| -> GapFillerError { e.to_string().into() })?;

    // Calculate amount
    let amount = &balance_after - &balance_before;

    // ── Try neardata for metadata (replaces 5-8 RPC calls with 1 HTTP call) ──
    let neardata_meta = if token_id == "near" || token_id == "NEAR" {
        if let Some(nd) = neardata {
            match nd.fetch_account_block_data(block_height, account_id).await {
                Ok(data) => {
                    tracing::debug!(
                        "Neardata resolved block {} for {}: {} receipts, {} execution_outcomes, {} transactions",
                        block_height,
                        account_id,
                        data.receipts.len(),
                        data.execution_outcomes.len(),
                        data.transactions.len(),
                    );
                    Some(data)
                }
                Err(e) => {
                    tracing::warn!(
                        "Neardata failed for block {}: {} — falling back to RPC",
                        block_height,
                        e
                    );
                    None
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    // Resolve metadata: neardata path or RPC path
    let (
        block_timestamp,
        mut transaction_hashes,
        receipt_ids,
        final_signer,
        final_receiver,
        final_counterparty,
        action_kind,
        method_name,
        raw_data,
    ) = if let Some(nd_data) = neardata_meta {
        // ── Neardata path: extract all metadata from block data ──
        let block_timestamp = nd_data.timestamp_nanos;

        let mut transaction_hashes: Vec<String> = nd_data
            .transactions
            .iter()
            .filter(|t| !t.hash.is_empty())
            .map(|t| t.hash.clone())
            .collect();

        // Collect receipt IDs from both chunk receipts and execution outcomes
        let mut receipt_ids: Vec<String> = nd_data
            .receipts
            .iter()
            .map(|r| r.receipt_id.clone())
            .collect();
        for eo in &nd_data.execution_outcomes {
            if !receipt_ids.contains(&eo.receipt_id) {
                receipt_ids.push(eo.receipt_id.clone());
            }
        }

        let (signer_id, receiver_id, counterparty, action_kind, method_name) =
            if let Some(receipt) = nd_data.receipts.first() {
                // Action receipt: predecessor_id is the account that sent the receipt
                // to the DAO — this is the correct counterparty for direct transfers
                // and function calls.
                let counterparty = receipt.predecessor_id.clone();
                (
                    Some(receipt.signer_id.clone()),
                    Some(receipt.receiver_id.clone()),
                    counterparty,
                    receipt.action_kind.clone(),
                    receipt.method_name.clone(),
                )
            } else if let Some(eo) = nd_data.execution_outcomes.first() {
                // No Action receipt in chunk (Data receipt / callback) — the DAO executed
                // as a callback from another contract.  Use tx_status to get the
                // transaction-level receiver_id, matching Goldsky enrichment Path C.
                let (tx_signer, tx_receiver, counterparty) = if let Some(tx_hash) = &eo.tx_hash {
                    match block_info::get_transaction(network, tx_hash, account_id).await {
                        Ok(tx_response) => {
                            if let Some(ref fo) = tx_response.final_execution_outcome {
                                use near_primitives::views::FinalExecutionOutcomeViewEnum;
                                let tx = match fo {
                                    FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(o) => {
                                        &o.transaction
                                    }
                                    FinalExecutionOutcomeViewEnum::FinalExecutionOutcomeWithReceipt(
                                        o,
                                    ) => &o.final_outcome.transaction,
                                };
                                let signer = tx.signer_id.to_string();
                                let receiver = tx.receiver_id.to_string();
                                // Path C: DAO executed a callback; tx.receiver_id is the
                                // economic counterparty (e.g. petersalomonsen.near).
                                // This matches Goldsky enrichment which uses outcome.receiver_id
                                // (= tx.receiver_id) for Path C events.
                                (Some(signer), Some(receiver.clone()), receiver)
                            } else {
                                (None, None, String::new())
                            }
                        }
                        Err(e) => {
                            tracing::warn!(
                                "tx_status failed for {} at block {}: {} — counterparty unknown",
                                tx_hash,
                                block_height,
                                e
                            );
                            (None, None, String::new())
                        }
                    }
                } else {
                    (None, None, String::new())
                };
                (tx_signer, tx_receiver, counterparty, None, None)
            } else {
                // No receipts and no execution outcomes
                tracing::warn!(
                    "Neardata block {} has no receipts or execution outcomes for {}",
                    block_height,
                    account_id,
                );
                if transaction_hashes.is_empty() {
                    return Err(format!(
                        "No receipt found for block {} - cannot determine counterparty",
                        block_height
                    )
                    .into());
                }
                (None, None, String::new(), None, None)
            };

        // Deduplicate tx_hashes
        transaction_hashes.dedup();

        (
            block_timestamp,
            transaction_hashes,
            receipt_ids,
            signer_id,
            receiver_id,
            counterparty,
            action_kind,
            method_name,
            serde_json::json!({}),
        )
    } else {
        // ── RPC path: existing logic ──

        // Get block timestamp
        let block_timestamp = block_info::get_block_timestamp(network, block_height, None)
            .await
            .map_err(|e| -> GapFillerError { e.to_string().into() })?;

        // Get account changes to find the transaction hash that caused this balance change
        let account_changes = block_info::get_account_changes(network, account_id, block_height)
            .await
            .map_err(|e| -> GapFillerError { e.to_string().into() })?;

        // Extract transaction hash and other details from account changes
        let (mut transaction_hashes, raw_data) = if let Some(change) = account_changes.first() {
            use near_primitives::views::StateChangeCauseView;

            let tx_hashes = match &change.cause {
                StateChangeCauseView::TransactionProcessing { tx_hash } => {
                    vec![tx_hash.to_string()]
                }
                _ => vec![],
            };

            let raw_data = serde_json::to_value(change).unwrap_or_else(|_| serde_json::json!({}));
            (tx_hashes, raw_data)
        } else {
            (vec![], serde_json::json!({}))
        };

        // If we have a transaction hash, query the full transaction to get signer and receiver
        let (signer_id, receiver_id, counterparty) =
            if let Some(tx_hash) = transaction_hashes.first() {
                match block_info::get_transaction(network, tx_hash, account_id).await {
                    Ok(tx_response) => {
                        if let Some(ref final_outcome) = tx_response.final_execution_outcome {
                            use near_primitives::views::FinalExecutionOutcomeViewEnum;
                            match final_outcome {
                                FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(outcome) => {
                                    let tx = &outcome.transaction;
                                    let signer = tx.signer_id.to_string();
                                    let receiver = tx.receiver_id.to_string();

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
                            tracing::warn!("Transaction response has no final_execution_outcome");
                            (None, None, String::new())
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            "Failed to query transaction {}: {} - will try receipts",
                            tx_hash,
                            e
                        );
                        (None, None, String::new())
                    }
                }
            } else {
                (None, None, String::new())
            };

        // Get receipt data for additional context (if available)
        let (
            final_signer,
            final_receiver,
            final_counterparty,
            receipt_ids,
            action_kind,
            method_name,
        ) = if signer_id.is_some() {
            let block_data = block_info::get_block_data(network, account_id, block_height)
                .await
                .map_err(|e| -> GapFillerError { e.to_string().into() })?;
            let receipt_ids: Vec<String> = block_data
                .receipts
                .iter()
                .map(|r| r.receipt_id.to_string())
                .collect();
            let (action_kind, method_name) = extract_action_from_receipts(&block_data.receipts);
            (
                signer_id,
                receiver_id,
                counterparty,
                receipt_ids,
                action_kind,
                method_name,
            )
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
                let (action_kind, method_name) = extract_action_from_receipts(&block_data.receipts);
                (
                    Some(receipt.predecessor_id.to_string()),
                    Some(receipt.receiver_id.to_string()),
                    receipt.predecessor_id.to_string(),
                    receipt_ids,
                    action_kind,
                    method_name,
                )
            } else if token_id != "near" && !token_id.starts_with("intents.near:") {
                let (s, r, c, rids) = resolve_ft_counterparty_from_token_contract(
                    network,
                    account_id,
                    token_id,
                    block_height,
                )
                .await?;
                (s, r, c, rids, None, None)
            } else if token_id.starts_with("intents.near:") {
                tracing::debug!(
                    "Intents token {} at block {} — counterparty will be resolved by swap detector",
                    token_id,
                    block_height
                );
                (None, None, "UNKNOWN".to_string(), vec![], None, None)
            } else {
                return Err(format!(
                    "No receipt found for block {} - cannot determine counterparty",
                    block_height
                )
                .into());
            }
        };

        // Resolve receipt → transaction hash (RPC path only)
        if transaction_hashes.is_empty() && !receipt_ids.is_empty() {
            for receipt_id in &receipt_ids {
                match tx_resolver::resolve_receipt_to_transaction(network, receipt_id, block_height)
                    .await
                {
                    Ok(result) => {
                        tracing::info!(
                            "Resolved receipt {} → tx {}",
                            receipt_id,
                            result.transaction_hash,
                        );
                        transaction_hashes.push(result.transaction_hash);
                        break;
                    }
                    Err(e) => {
                        tracing::debug!(
                            "Could not resolve receipt {} to transaction: {}",
                            receipt_id,
                            e
                        );
                    }
                }
            }
        }

        (
            block_timestamp,
            transaction_hashes,
            receipt_ids,
            final_signer,
            final_receiver,
            final_counterparty,
            action_kind,
            method_name,
            raw_data,
        )
    };

    // For intents tokens: query account_changes on intents.near to find candidate tx hashes,
    // then filter to only those whose execution outcome logs mention the monitored account.
    // intents.near is a high-traffic contract — many unrelated transactions modify its state
    // per block, so we must verify each candidate is actually relevant to this account.
    if transaction_hashes.is_empty() && token_id.starts_with("intents.near:") {
        match block_info::get_account_changes(network, "intents.near", block_height).await {
            Ok(changes) => {
                let mut candidates: Vec<String> = Vec::new();
                for change in &changes {
                    use near_primitives::views::StateChangeCauseView;
                    if let StateChangeCauseView::TransactionProcessing { tx_hash } = &change.cause {
                        let hash = tx_hash.to_string();
                        if !candidates.contains(&hash) {
                            candidates.push(hash);
                        }
                    }
                }
                tracing::debug!(
                    "Intents token at block {}: found {} candidate tx hash(es) from account_changes on intents.near",
                    block_height,
                    candidates.len()
                );

                // If there's only one candidate, it must be correct (we know the
                // balance changed at this block). Only filter when there are multiple
                // candidates to disambiguate — this avoids unnecessary RPC calls.
                if candidates.len() == 1 {
                    transaction_hashes.push(candidates.into_iter().next().unwrap());
                } else {
                    // Filter candidates: only keep tx hashes whose receipt outcome logs
                    // mention the monitored account_id.
                    for candidate in &candidates {
                        match block_info::get_transaction(network, candidate, "intents.near").await
                        {
                            Ok(tx_response) => {
                                let mentions_account =
                                    tx_outcome_logs_mention_account(&tx_response, account_id);
                                if mentions_account {
                                    tracing::debug!(
                                        "Intents tx {} confirmed relevant to {} (found in receipt logs)",
                                        candidate,
                                        account_id
                                    );
                                    transaction_hashes.push(candidate.clone());
                                } else {
                                    tracing::debug!(
                                        "Intents tx {} filtered out — no mention of {} in receipt logs",
                                        candidate,
                                        account_id
                                    );
                                }
                            }
                            Err(e) => {
                                tracing::warn!(
                                    "Failed to query transaction {} for intents filtering: {} — including as candidate",
                                    candidate,
                                    e
                                );
                                // On error, include the candidate to avoid losing data
                                transaction_hashes.push(candidate.clone());
                            }
                        }
                    }
                }
            }
            Err(e) => {
                tracing::warn!(
                    "Failed to query account_changes on intents.near at block {}: {}",
                    block_height,
                    e
                );
            }
        }
    }

    // Insert the record
    let block_time = block_timestamp_to_datetime(block_timestamp);

    let action_kind_log = action_kind.as_deref().unwrap_or("-").to_string();
    let method_name_log = method_name.as_deref().unwrap_or("-").to_string();

    sqlx::query!(
        r#"
        INSERT INTO balance_changes
        (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, transaction_hashes, receipt_id, signer_id, receiver_id, counterparty, actions, raw_data, action_kind, method_name)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
        raw_data,
        action_kind,
        method_name
    )
    .execute(pool)
    .await?;

    tracing::info!(
        "Inserted balance change at block {} for {}/{}: {} -> {} (tx_hashes: {:?}, receipts: {}, action: {}/{})",
        block_height,
        account_id,
        token_id,
        balance_before,
        balance_after,
        transaction_hashes,
        receipt_ids.len(),
        action_kind_log,
        method_name_log
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
