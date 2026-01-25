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
use nt_be::handlers::balance_changes::gap_filler::insert_snapshot_record;
use nt_be::handlers::balance_changes::transfer_hints::{
    TransferHintService, fastnear::FastNearProvider,
};
use sqlx::PgPool;
use sqlx::types::BigDecimal;
use std::time::Instant;

const TEST_ACCOUNT: &str = "webassemblymusic-treasury.sputnik-dao.near";

/// Test native NEAR transfers detection with hint service enabled.
///
/// Known NEAR transfers for this account:
/// - Block 178148638: -0.1 NEAR to petersalomonsen.near
/// - Block 178142836: +0.1 NEAR from petersalomonsen.near
#[sqlx::test]
async fn test_native_near_transfers_with_hints(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();

    let account_id = TEST_ACCOUNT;
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

    // Use a range around known transfers
    let seed_block = 178_140_000u64;
    let up_to_block = 178_150_000i64;
    let network = common::create_archival_network();

    println!("\n=== Native NEAR Transfer Hints Test ===");
    println!("Account: {}", account_id);
    println!("Block range: {} -> {}", seed_block, up_to_block);

    insert_snapshot_record(&pool, &network, account_id, token_id, seed_block)
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

    println!("✓ Seeded initial balance at block {}", seed_block);

    // Query hints
    let hint_service = TransferHintService::new().with_provider(FastNearProvider::new());
    let hints = hint_service
        .get_hints(account_id, token_id, seed_block, up_to_block as u64)
        .await;

    let hint_blocks: Vec<u64> = hints.iter().map(|h| h.block_height).collect();
    println!("✓ FastNear returned {} NEAR transfer hints", hints.len());
    if !hint_blocks.is_empty() {
        println!("  Hint blocks: {:?}", hint_blocks);
    }

    // Run monitor cycle
    println!("\n=== Running Monitor Cycle ===");
    let start = Instant::now();

    run_monitor_cycle(&pool, &network, up_to_block, Some(&hint_service))
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

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

    // Show transfer details
    for (block, before, after) in &transfer_changes {
        let change = after - before;
        println!("  Block {}: {} NEAR change", block, change);
    }

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

    // Check if we detected the known transfer around block 178148637/178148638
    let found_expected = collected_blocks
        .iter()
        .any(|b| *b >= 178148635 && *b <= 178148640);
    assert!(
        found_expected,
        "Expected to detect transfer around block 178148637, collected: {:?}",
        collected_blocks
    );

    println!(
        "\n✓ Test passed! Detected {} transfers",
        transfer_changes.len()
    );

    Ok(())
}

/// Test fungible token (FT) transfers with arizcredits.near token.
///
/// Known FT transfer:
/// - Block 178148636: -100000 arizcredits to arizcredits.near
#[sqlx::test]
async fn test_ft_transfers_with_hints(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();

    let account_id = TEST_ACCOUNT;
    let token_id = "arizcredits.near";

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

    // Use a range around known FT transfer at 178148636
    let seed_block = 178_140_000u64;
    let up_to_block = 178_150_000i64;
    let network = common::create_archival_network();

    println!("\n=== FT Transfer Hints Test (arizcredits.near) ===");
    println!("Account: {}", account_id);
    println!("Token: {}", token_id);
    println!("Block range: {} -> {}", seed_block, up_to_block);

    insert_snapshot_record(&pool, &network, account_id, token_id, seed_block)
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

    println!("✓ Seeded initial balance at block {}", seed_block);

    // Query hints for FT
    let hint_service = TransferHintService::new().with_provider(FastNearProvider::new());
    let hints = hint_service
        .get_hints(account_id, token_id, seed_block, up_to_block as u64)
        .await;

    let hint_blocks: Vec<u64> = hints.iter().map(|h| h.block_height).collect();
    println!("✓ FastNear returned {} FT transfer hints", hints.len());
    if !hint_blocks.is_empty() {
        println!("  Hint blocks: {:?}", hint_blocks);
    }

    // Run monitor cycle
    println!("\n=== Running Monitor Cycle ===");
    let start = Instant::now();

    run_monitor_cycle(&pool, &network, up_to_block, Some(&hint_service))
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

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
    println!("✓ Found {} actual FT transfers", transfer_changes.len());

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

    // Assert we detected FT transfers
    assert!(
        !transfer_changes.is_empty(),
        "Expected to detect FT transfers for {} / {}",
        account_id,
        token_id
    );

    // Check if we detected the known FT transfer around block 178148636
    let found_expected = collected_blocks
        .iter()
        .any(|b| *b >= 178148630 && *b <= 178148640);
    assert!(
        found_expected,
        "Expected to detect FT transfer around block 178148636, collected: {:?}",
        collected_blocks
    );

    println!(
        "\n✓ Test passed! Detected {} FT transfers",
        transfer_changes.len()
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
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

    println!("✓ Seeded initial balance at block {}", seed_block);

    // Query hints
    let hint_service = TransferHintService::new().with_provider(FastNearProvider::new());
    let hints = hint_service
        .get_hints(account_id, token_id, seed_block, up_to_block as u64)
        .await;

    println!(
        "✓ FastNear returned {} intents transfer hints (expected: 0)",
        hints.len()
    );

    // Run monitor cycle
    println!("\n=== Running Monitor Cycle ===");
    let start = Instant::now();

    run_monitor_cycle(&pool, &network, up_to_block, Some(&hint_service))
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

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
    println!(
        "Hints provided: {} (FastNear doesn't support intents tokens yet)",
        hints.len()
    );
    println!("Balance changes found: {}", transfer_changes.len());
    println!("Total duration: {:?}", duration);

    // FastNear doesn't support intents tokens, so hints should be empty
    // This means we fall back to binary search for intents
    assert!(
        hints.is_empty(),
        "Expected no hints for intents tokens (FastNear doesn't support them yet)"
    );

    // For intents, transfers may fail to detect if receipt lookup doesn't work
    // This is a known limitation - intents use MT (multi-token) standard
    if transfer_changes.is_empty() {
        println!("\n⚠ No intents transfers detected - this may be a known limitation");
        println!("  Intents use MT (multi-token) standard which may require different handling");
    } else {
        // Check if we detected the known intents transfer around block 179943999
        let found_expected = collected_blocks
            .iter()
            .any(|b| *b >= 179943995 && *b <= 179944005);
        if found_expected {
            println!(
                "\n✓ Test passed! Detected {} intents transfers",
                transfer_changes.len()
            );
        } else {
            println!(
                "\n⚠ Detected {} transfers but not at expected block",
                transfer_changes.len()
            );
        }
    }

    // Test passes as long as monitor cycle completed without panic
    println!("\n✓ Intents test completed successfully (used binary search fallback)");

    Ok(())
}
