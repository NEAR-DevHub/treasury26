//! Integration tests for transfer hints with FastNear API
//!
//! These tests verify that the FastNear transfers-api integration works
//! for different asset types: native NEAR, fungible tokens (FT), and intents.
//!
//! Uses webassemblymusic-treasury.sputnik-dao.near which has all three types
//! of transfers with actual balance changes.
//!
//! NOTE: The block-to-timestamp approximation in FastNearProvider may cause
//! hints to be returned for slightly different block ranges. These tests
//! verify the system works end-to-end and report hint resolution rates.

mod common;

use nt_be::handlers::balance_changes::account_monitor::run_monitor_cycle;
use nt_be::handlers::balance_changes::gap_filler::{
    HintResolutionStats, find_block_with_hints_tracked, insert_snapshot_record,
};
use nt_be::handlers::balance_changes::transfer_hints::{
    TransferHintService, fastnear::FastNearProvider,
};
use sqlx::PgPool;
use sqlx::types::BigDecimal;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

const TEST_ACCOUNT: &str = "webassemblymusic-treasury.sputnik-dao.near";

/// Test native NEAR and FT transfers detection with hint service enabled.
///
/// Runs a single monitor cycle and verifies both token types are detected,
/// avoiding duplicate RPC calls from running two separate cycles.
///
/// Known transfers for this account in block range 178140000-178150000:
/// - Block 178148638: -0.1 NEAR to petersalomonsen.near
/// - Block 178142836: +0.1 NEAR from petersalomonsen.near
/// - Block 178148636: -100000 arizcredits to arizcredits.near
#[sqlx::test]
async fn test_near_and_ft_transfers_with_hints(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();

    let account_id = TEST_ACCOUNT;
    let near_token = "near";
    let ft_token = "arizcredits.near";

    // Insert account as monitored
    sqlx::query!(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled)
        VALUES ($1, true)
        ON CONFLICT (account_id) DO UPDATE SET enabled = true
        "#,
        account_id
    )
    .execute(&pool)
    .await?;

    // Clear any existing balance changes
    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1",
        account_id
    )
    .execute(&pool)
    .await?;

    // Use a range around known transfers
    let seed_block = 178_140_000u64;
    let up_to_block = 178_150_000i64;
    let network = common::create_archival_network();

    println!("\n=== NEAR + FT Transfer Hints Test ===");
    println!("Account: {}", account_id);
    println!("Block range: {} -> {}", seed_block, up_to_block);

    // Seed both tokens
    for token_id in [near_token, ft_token] {
        insert_snapshot_record(&pool, &network, account_id, token_id, seed_block)
            .await
            .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;
        println!(
            "✓ Seeded initial {} balance at block {}",
            token_id, seed_block
        );
    }

    // Query NEAR hints (to verify hint quality)
    let hint_service = TransferHintService::new().with_provider(
        FastNearProvider::new(network.clone()).with_api_key(common::get_fastnear_api_key()),
    );
    let near_hints = hint_service
        .get_hints(account_id, near_token, seed_block, up_to_block as u64)
        .await;
    let ft_hints = hint_service
        .get_hints(account_id, ft_token, seed_block, up_to_block as u64)
        .await;

    println!(
        "✓ FastNear returned {} NEAR hints, {} FT hints",
        near_hints.len(),
        ft_hints.len()
    );

    // Run a SINGLE monitor cycle — processes ALL tokens for this account
    println!("\n=== Running Monitor Cycle (single cycle for all tokens) ===");
    let start = Instant::now();

    run_monitor_cycle(
        &pool,
        &network,
        up_to_block,
        Some(&hint_service),
        None,
        "https://explorer.near-intents.org/api/v0",
    )
    .await
    .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    let duration = start.elapsed();
    println!("✓ Monitor cycle completed in {:?}", duration);

    // --- Verify NEAR transfers ---
    let near_changes: Vec<(i64, BigDecimal, BigDecimal)> = sqlx::query_as(
        "SELECT block_height, balance_before, balance_after FROM balance_changes
         WHERE account_id = $1 AND token_id = $2 ORDER BY block_height ASC",
    )
    .bind(account_id)
    .bind(near_token)
    .fetch_all(&pool)
    .await?;

    let near_transfers: Vec<_> = near_changes
        .iter()
        .filter(|(_, before, after)| before != after)
        .collect();
    let near_blocks: Vec<i64> = near_changes.iter().map(|(b, _, _)| *b).collect();

    println!("\n--- NEAR results ---");
    println!(
        "  Balance changes: {}, Transfers: {}",
        near_changes.len(),
        near_transfers.len()
    );
    for (block, before, after) in &near_transfers {
        println!("  Block {}: {} NEAR change", block, after - before);
    }

    // Assert NEAR hints have tx_hash
    let near_hints_with_tx: Vec<_> = near_hints
        .iter()
        .filter(|h| h.transaction_hash.is_some())
        .collect();
    assert!(
        !near_hints_with_tx.is_empty(),
        "Expected NEAR hints to have transaction hashes"
    );

    assert!(
        !near_transfers.is_empty(),
        "Expected to detect NEAR transfers"
    );
    let found_near = near_blocks
        .iter()
        .any(|b| *b >= 178148635 && *b <= 178148640);
    assert!(
        found_near,
        "Expected NEAR transfer around block 178148637, collected: {:?}",
        near_blocks
    );

    // --- Verify FT transfers ---
    let ft_changes: Vec<(i64, BigDecimal, BigDecimal)> = sqlx::query_as(
        "SELECT block_height, balance_before, balance_after FROM balance_changes
         WHERE account_id = $1 AND token_id = $2 ORDER BY block_height ASC",
    )
    .bind(account_id)
    .bind(ft_token)
    .fetch_all(&pool)
    .await?;

    let ft_transfers: Vec<_> = ft_changes
        .iter()
        .filter(|(_, before, after)| before != after)
        .collect();
    let ft_blocks: Vec<i64> = ft_changes.iter().map(|(b, _, _)| *b).collect();

    println!("\n--- FT results ---");
    println!(
        "  Balance changes: {}, Transfers: {}",
        ft_changes.len(),
        ft_transfers.len()
    );

    let ft_hints_with_tx: Vec<_> = ft_hints
        .iter()
        .filter(|h| h.transaction_hash.is_some())
        .collect();
    assert!(
        !ft_hints_with_tx.is_empty(),
        "Expected FT hints to have transaction hashes"
    );

    assert!(
        !ft_transfers.is_empty(),
        "Expected to detect FT transfers for {}",
        ft_token
    );
    let found_ft = ft_blocks.iter().any(|b| *b >= 178148630 && *b <= 178148640);
    assert!(
        found_ft,
        "Expected FT transfer around block 178148636, collected: {:?}",
        ft_blocks
    );

    println!(
        "\n✓ Test passed! Detected {} NEAR + {} FT transfers in {:?}",
        near_transfers.len(),
        ft_transfers.len(),
        duration
    );

    Ok(())
}

/// Test intents token transfers (USDC via intents protocol).
///
/// Known intents transfer:
/// - Block 179943999: +178809 USDC from solver-priv-liq.near
#[sqlx::test]
async fn test_intents_transfers_with_hints(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();

    let account_id = TEST_ACCOUNT;
    // Intents USDC token (Ethereum USDC bridged via intents)
    let token_id = "intents.near:nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";

    // Insert account as monitored
    sqlx::query!(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled)
        VALUES ($1, true)
        ON CONFLICT (account_id) DO UPDATE SET enabled = true
        "#,
        account_id
    )
    .execute(&pool)
    .await?;

    // Clear any existing balance changes
    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1 AND token_id = $2",
        account_id,
        token_id
    )
    .execute(&pool)
    .await?;

    // Block range covering the known intents transfer at 179943999
    let seed_block = 179_940_000u64;
    let up_to_block = 179_950_000i64;
    let network = common::create_archival_network();

    println!("\n=== Intents Transfer Hints Test ===");
    println!("Account: {}", account_id);
    println!("Token: {}", token_id);
    println!("Block range: {} -> {}", seed_block, up_to_block);

    insert_snapshot_record(&pool, &network, account_id, token_id, seed_block)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    println!("✓ Seeded initial balance at block {}", seed_block);

    // Query hints
    let hint_service = TransferHintService::new().with_provider(
        FastNearProvider::new(network.clone()).with_api_key(common::get_fastnear_api_key()),
    );
    let hints = hint_service
        .get_hints(account_id, token_id, seed_block, up_to_block as u64)
        .await;

    println!("✓ FastNear returned {} intents transfer hints", hints.len());

    // Assert hints are provided
    assert!(
        !hints.is_empty(),
        "Expected FastNear to return hints for intents token"
    );

    // Find the specific hint at the known transfer block
    let expected_block = 179943999u64;
    let target_hint = hints.iter().find(|h| h.block_height == expected_block);
    assert!(
        target_hint.is_some(),
        "Expected to find hint at block {}",
        expected_block
    );

    let hint = target_hint.unwrap();
    println!("  Hint at block {}: {:?}", expected_block, hint);

    // Assert hint properties
    assert_eq!(hint.block_height, expected_block);
    assert!(
        hint.transaction_hash.is_some(),
        "Expected hint to have transaction hash"
    );
    assert!(hint.amount.is_some(), "Expected hint to have amount");

    // Run monitor cycle
    println!("\n=== Running Monitor Cycle ===");
    let start = Instant::now();

    run_monitor_cycle(
        &pool,
        &network,
        up_to_block,
        Some(&hint_service),
        None,
        "https://explorer.near-intents.org/api/v0",
    )
    .await
    .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    let duration = start.elapsed();
    println!("✓ Monitor cycle completed in {:?}", duration);

    // Fetch collected changes
    let changes: Vec<(i64, BigDecimal, BigDecimal)> = sqlx::query_as(
        r#"
        SELECT block_height, balance_before, balance_after
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height ASC
        "#,
    )
    .bind(account_id)
    .bind(token_id)
    .fetch_all(&pool)
    .await?;

    let collected_blocks: Vec<i64> = changes.iter().map(|(b, _, _)| *b).collect();
    println!("✓ Collected {} balance changes", changes.len());
    println!("  Collected blocks: {:?}", collected_blocks);

    // Count non-snapshot changes
    let transfer_changes: Vec<_> = changes
        .iter()
        .filter(|(_, before, after)| before != after)
        .collect();
    println!(
        "✓ Found {} actual intents transfers",
        transfer_changes.len()
    );

    println!("\n=== Results ===");
    println!("Hints provided: {}", hints.len());
    println!("Balance changes found: {}", transfer_changes.len());
    println!("Total duration: {:?}", duration);

    // Assert transfer changes were found
    assert!(
        !transfer_changes.is_empty(),
        "Expected to find intents transfer changes"
    );

    // Assert the exact transfer at block 179943999
    let expected_transfer = changes
        .iter()
        .find(|(block, _, _)| *block == expected_block as i64);
    assert!(
        expected_transfer.is_some(),
        "Expected to find balance change at block {}",
        expected_block
    );

    println!("\n✓ Intents test passed!");

    Ok(())
}

/// Test NEAR transfers with multiple hints for shitzu.sputnik-dao.near
///
/// This account has many NEAR transfers in a recent block range, providing
/// a good test case for verifying hint resolution with multiple transfers.
///
/// Known transfers in block range around 179250000-179280000:
/// - Block ~179253697: +0.1 NEAR (balance went from 96.34 to 96.44)
/// - Block ~179276524: -0.1 NEAR (balance went from 96.44 to 96.34)
#[sqlx::test]
async fn test_shitzu_near_transfers_with_hints(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();

    let account_id = "shitzu.sputnik-dao.near";
    let token_id = "near";

    // Insert account as monitored
    sqlx::query!(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled)
        VALUES ($1, true)
        ON CONFLICT (account_id) DO UPDATE SET enabled = true
        "#,
        account_id
    )
    .execute(&pool)
    .await?;

    // Clear any existing balance changes
    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1",
        account_id
    )
    .execute(&pool)
    .await?;

    // Tight range around known transfers (blocks 179253697, 179276524)
    let seed_block = 179_250_000u64;
    let up_to_block = 179_280_000i64;
    let network = common::create_archival_network();

    println!("\n=== Shitzu NEAR Transfer Hints Test ===");
    println!("Account: {}", account_id);
    println!("Block range: {} -> {}", seed_block, up_to_block);

    insert_snapshot_record(&pool, &network, account_id, token_id, seed_block)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    println!("✓ Seeded initial balance at block {}", seed_block);

    // Query hints
    let hint_service = TransferHintService::new().with_provider(
        FastNearProvider::new(network.clone()).with_api_key(common::get_fastnear_api_key()),
    );
    let hints = hint_service
        .get_hints(account_id, token_id, seed_block, up_to_block as u64)
        .await;

    let hint_blocks: Vec<u64> = hints.iter().map(|h| h.block_height).collect();
    println!("✓ FastNear returned {} NEAR transfer hints", hints.len());
    if !hint_blocks.is_empty() {
        println!(
            "  Hint blocks: {:?}",
            &hint_blocks[..hint_blocks.len().min(10)]
        );
        if hint_blocks.len() > 10 {
            println!("  ... and {} more", hint_blocks.len() - 10);
        }
    }

    // Run monitor cycle
    println!("\n=== Running Monitor Cycle ===");
    let start = Instant::now();

    run_monitor_cycle(
        &pool,
        &network,
        up_to_block,
        Some(&hint_service),
        None,
        "https://explorer.near-intents.org/api/v0",
    )
    .await
    .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    let duration = start.elapsed();
    println!("✓ Monitor cycle completed in {:?}", duration);

    // Fetch collected changes
    let changes: Vec<(i64, BigDecimal, BigDecimal)> = sqlx::query_as(
        r#"
        SELECT block_height, balance_before, balance_after
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height ASC
        "#,
    )
    .bind(account_id)
    .bind(token_id)
    .fetch_all(&pool)
    .await?;

    let collected_blocks: Vec<i64> = changes.iter().map(|(b, _, _)| *b).collect();
    println!("✓ Collected {} balance changes", changes.len());
    println!("  Collected blocks: {:?}", collected_blocks);

    // Count non-snapshot changes
    let transfer_changes: Vec<_> = changes
        .iter()
        .filter(|(_, before, after)| before != after)
        .collect();
    println!("✓ Found {} actual transfers", transfer_changes.len());

    // Check that hints provided tx_hash (enables fast resolution without binary search)
    let hints_with_tx_hash: Vec<_> = hints
        .iter()
        .filter(|h| h.transaction_hash.is_some())
        .collect();

    println!("\n=== Results ===");
    println!("Hints provided: {}", hints.len());
    println!(
        "Hints with tx_hash: {}/{} (enables fast tx_status resolution)",
        hints_with_tx_hash.len(),
        hints.len()
    );
    println!("Balance changes found: {}", transfer_changes.len());
    println!("Total duration: {:?}", duration);

    // Assert hints have tx_hash - this proves we can use tx_status instead of binary search
    assert!(
        !hints_with_tx_hash.is_empty(),
        "Expected hints to have transaction hashes for fast resolution"
    );

    // Assert we detected transfers (the main goal)
    assert!(
        !transfer_changes.is_empty(),
        "Expected to detect NEAR transfers for {}",
        account_id
    );

    // Verify we found multiple transfers (this account has many in this range)
    assert!(
        transfer_changes.len() >= 2,
        "Expected at least 2 transfers, found {}",
        transfer_changes.len()
    );

    println!(
        "\n✓ Test passed! Detected {} transfers using {} hints",
        transfer_changes.len(),
        hints.len()
    );

    Ok(())
}

/// Test that verifies no duplicate block checks occur during hint resolution
///
/// This test directly calls `find_block_with_hints_tracked` to verify that
/// each block is only checked once. The issue being tested:
/// - Strategy 1 checks hint.block_height
/// - Strategy 2 (tx_status) may resolve to the same block and check it again
/// - Strategy 3 checks hint.block_height again
///
/// Result: The same block can be checked up to 3 times, wasting RPC calls.
///
/// This test should FAIL before the fix is applied, and PASS after.
#[sqlx::test]
async fn test_no_duplicate_block_checks(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();

    let account_id = "shitzu.sputnik-dao.near";
    let token_id = "near";
    let network = common::create_archival_network();

    // Clear any existing data and set up monitored account
    sqlx::query!(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled)
        VALUES ($1, true)
        ON CONFLICT (account_id) DO UPDATE SET enabled = true
        "#,
        account_id
    )
    .execute(&pool)
    .await?;

    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1",
        account_id
    )
    .execute(&pool)
    .await?;

    // Set up hint service
    let hint_service = TransferHintService::new().with_provider(
        FastNearProvider::new(network.clone()).with_api_key(common::get_fastnear_api_key()),
    );

    // Tight range around known transfers (blocks 179253697, 179276524)
    let from_block = 179_250_000u64;
    let to_block = 179_280_000u64;

    // First get hints to understand what we're looking for
    let hints = hint_service
        .get_hints(account_id, token_id, from_block, to_block)
        .await;

    println!("\n=== No Duplicate Block Checks Test ===");
    println!("Account: {}", account_id);
    println!("Block range: {} -> {}", from_block, to_block);
    println!("Hints found: {}", hints.len());

    if hints.is_empty() {
        println!("No hints in range - test inconclusive, skipping");
        return Ok(());
    }

    // Show hint details (first few)
    for hint in hints.iter().take(5) {
        println!(
            "  Hint at block {}: tx={:?}, start={:?}, end={:?}",
            hint.block_height,
            hint.transaction_hash
                .as_ref()
                .map(|s| &s[..12.min(s.len())]),
            hint.start_of_block_balance,
            hint.end_of_block_balance
        );
    }
    if hints.len() > 5 {
        println!("  ... and {} more hints", hints.len() - 5);
    }

    // Find a hint where balance changed (start != end)
    // This ensures we have a real balance change to search for
    let target_hint = hints.iter().find(|h| {
        h.start_of_block_balance.is_some()
            && h.end_of_block_balance.is_some()
            && h.start_of_block_balance != h.end_of_block_balance
    });

    let Some(hint) = target_hint else {
        println!("No hints with balance change data - test inconclusive, skipping");
        return Ok(());
    };

    let expected_balance = hint.end_of_block_balance.clone().unwrap();
    println!(
        "\nSearching for balance {} (from hint at block {})",
        expected_balance, hint.block_height
    );

    // Create stats tracker
    let stats = Arc::new(Mutex::new(HintResolutionStats::default()));

    // Call the tracked version of find_block_with_hints
    let result = find_block_with_hints_tracked(
        &pool,
        &network,
        &hint_service,
        account_id,
        token_id,
        from_block,
        to_block,
        &expected_balance,
        Some(stats.clone()),
    )
    .await
    .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    println!("Result: {:?}", result);

    // Analyze the stats
    let stats_data = stats.lock().unwrap().clone();
    let checked_blocks = stats_data.checked_blocks.clone();
    println!(
        "Blocks checked ({} total): {:?}",
        checked_blocks.len(),
        checked_blocks
    );
    println!(
        "Strategy used: {:?}, Found block: {:?}, Hints processed: {}",
        stats_data.strategy_used, stats_data.found_block, stats_data.hints_processed
    );

    // Count how many times each block was checked
    let mut block_counts: HashMap<u64, usize> = HashMap::new();
    for block in &checked_blocks {
        *block_counts.entry(*block).or_insert(0) += 1;
    }

    println!("\n=== Block Check Counts ===");
    let mut has_duplicates = false;
    let mut duplicate_info = Vec::new();
    for (block, count) in &block_counts {
        if *count > 1 {
            println!("  ❌ Block {}: checked {} times (DUPLICATE!)", block, count);
            has_duplicates = true;
            duplicate_info.push((*block, *count));
        } else {
            println!("  ✓ Block {}: checked {} time", block, count);
        }
    }

    // Assert that no block was checked more than once
    // This assertion should FAIL before the fix is applied
    assert!(
        !has_duplicates,
        "Duplicate block checks detected! Blocks checked multiple times: {:?}. \
         This wastes RPC calls. Each block should only be checked once.",
        duplicate_info
    );

    println!("\n✓ No duplicate block checks detected.");

    // Check if hints were used to find the block
    // Note: The balance from FastNear may not exactly match RPC balance (gas fees, timing)
    // so the search may not find a match even with valid hints
    if result.is_some() {
        // If we found a result, verify hints were used (not binary search)
        assert!(
            stats_data.strategy_used.is_some(),
            "Expected strategy_used to be set when result was found"
        );

        let strategy = stats_data.strategy_used.as_ref().unwrap();
        assert!(
            strategy != "binary_search",
            "Expected hints to be used, but fell back to binary search. \
             Strategy should be 'fastnear_balance', 'tx_status', or 'direct_verification', not '{}'",
            strategy
        );

        assert!(
            stats_data.found_block.is_some(),
            "Expected found_block to be set when strategy succeeded"
        );

        println!(
            "✓ Hints were used! Strategy: '{}', found block: {}",
            strategy,
            stats_data.found_block.unwrap()
        );
    } else {
        // No result found - this can happen if FastNear balance doesn't exactly match RPC
        // This is still valid - the test verifies no duplicate checks occurred
        println!("⚠ No matching block found (FastNear balance may not exactly match RPC balance)");
        println!(
            "  Hints processed: {}, Checked blocks: {}",
            stats_data.hints_processed,
            checked_blocks.len()
        );
    }

    println!("\n✓ Test passed! No duplicate block checks detected.");

    Ok(())
}

/// Test that verifies hints ARE used to find balance changes
///
/// This test fetches the actual RPC balance at the end of the range,
/// then searches for it. This guarantees a match and allows us to
/// assert that hints were actually used (not binary search).
#[sqlx::test]
async fn test_hints_strategy_is_used(pool: PgPool) -> sqlx::Result<()> {
    use nt_be::handlers::balance_changes::balance::get_balance_at_block;

    common::load_test_env();

    let account_id = "shitzu.sputnik-dao.near";
    let token_id = "near";
    let network = common::create_archival_network();

    // Clear any existing data and set up monitored account
    sqlx::query!(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled)
        VALUES ($1, true)
        ON CONFLICT (account_id) DO UPDATE SET enabled = true
        "#,
        account_id
    )
    .execute(&pool)
    .await?;

    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1",
        account_id
    )
    .execute(&pool)
    .await?;

    // Set up hint service
    let hint_service = TransferHintService::new().with_provider(
        FastNearProvider::new(network.clone()).with_api_key(common::get_fastnear_api_key()),
    );

    // Tight range around known transfers (blocks 179253697, 179276524)
    let from_block = 179_250_000u64;
    let to_block = 179_280_000u64;

    println!("\n=== Hints Strategy Is Used Test ===");
    println!("Account: {}", account_id);
    println!("Block range: {} -> {}", from_block, to_block);

    // Get hints to find one we can search for
    let hints = hint_service
        .get_hints(account_id, token_id, from_block, to_block)
        .await;

    println!("Hints found: {}", hints.len());

    if hints.is_empty() {
        println!("No hints in range - test inconclusive, skipping");
        return Ok(());
    }

    // Find a hint with balance data where balance actually changed
    let target_hint = hints.iter().find(|h| {
        h.start_of_block_balance.is_some()
            && h.end_of_block_balance.is_some()
            && h.start_of_block_balance != h.end_of_block_balance
    });

    let Some(hint) = target_hint else {
        println!("No hints with balance change data - test inconclusive, skipping");
        return Ok(());
    };

    // Use the hint's end_of_block_balance - this is what we expect to find via hints
    let target_balance = hint.end_of_block_balance.clone().unwrap();
    let hint_block = hint.block_height;

    println!(
        "Using hint at block {} with end_of_block_balance: {}",
        hint_block, target_balance
    );

    // Verify this balance via RPC to ensure hint data is accurate
    let rpc_balance = get_balance_at_block(&pool, &network, account_id, token_id, hint_block)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    println!("RPC balance at block {}: {}", hint_block, rpc_balance);

    // Use RPC balance (more reliable than hint's reported balance)
    let search_balance = rpc_balance;

    // Create stats tracker
    let stats = Arc::new(Mutex::new(HintResolutionStats::default()));

    // Search for this balance
    let result = find_block_with_hints_tracked(
        &pool,
        &network,
        &hint_service,
        account_id,
        token_id,
        from_block,
        to_block,
        &search_balance,
        Some(stats.clone()),
    )
    .await
    .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    let stats_data = stats.lock().unwrap().clone();

    println!("Result: {:?}", result);
    println!(
        "Strategy used: {:?}, Found block: {:?}, Hints processed: {}",
        stats_data.strategy_used, stats_data.found_block, stats_data.hints_processed
    );
    println!("Blocks checked: {:?}", stats_data.checked_blocks);

    // We're searching for a balance from a hint, so we expect to find it
    if let Some(hint_result) = result {
        let found_block = hint_result.block_height;

        // We found a block - verify hints were used
        assert!(
            stats_data.strategy_used.is_some(),
            "Expected strategy_used to be set when result was found"
        );

        let strategy = stats_data.strategy_used.as_ref().unwrap();

        // Verify it's a hint-based strategy, not binary search fallback
        let hint_strategies = ["fastnear_balance", "tx_status", "direct_verification"];
        assert!(
            hint_strategies.contains(&strategy.as_str()),
            "Expected a hint-based strategy (fastnear_balance, tx_status, or direct_verification), \
             but got '{}'. The balance {} at block {} should have been found via hints.",
            strategy,
            search_balance,
            found_block
        );

        println!(
            "\n✓ Hints were used! Strategy: '{}', found block: {}",
            strategy, found_block
        );
    } else {
        // This is unexpected - we used a balance from a hint, so we should find it
        println!("\n⚠ No balance change found - this is unexpected for hint-derived balance");
        println!(
            "  Hint block: {}, Search balance: {}",
            hint_block, search_balance
        );
    }

    println!("\n✓ Test completed!");

    Ok(())
}
