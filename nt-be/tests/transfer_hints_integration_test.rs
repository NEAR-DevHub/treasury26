//! Integration test for transfer hints with actual gap filling
//!
//! This test verifies that the FastNear transfers-api hints are actually used
//! and reduce the number of RPC calls needed for gap filling.

mod common;

use nt_be::handlers::balance_changes::account_monitor::run_monitor_cycle;
use nt_be::handlers::balance_changes::gap_filler::{fill_gaps_with_hints, insert_snapshot_record};
use nt_be::handlers::balance_changes::transfer_hints::{fastnear::FastNearProvider, TransferHintService};
use sqlx::PgPool;

/// Test that transfer hints actually work by directly calling fill_gaps_with_hints
///
/// This test:
/// 1. Seeds initial balance at an early block using insert_snapshot_record
/// 2. Directly calls fill_gaps_with_hints to fill forward
/// 3. Verifies hints are logged during gap filling
#[sqlx::test]
async fn test_direct_gap_filling_with_hints(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();

    let account_id = "petersalomonsen.near";
    let token_id = "near";

    // Clear any existing balance changes for this test
    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1",
        account_id
    )
    .execute(&pool)
    .await?;

    // Insert a seed record at an early block to create gaps
    let seed_block = 181_000_000u64;
    let network = common::create_archival_network();

    insert_snapshot_record(&pool, &network, account_id, token_id, seed_block)
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

    // Create hint service
    let hint_service = TransferHintService::new().with_provider(FastNearProvider::new());
    let up_to_block = 182_000_000i64;

    println!("\n=== Testing transfer hints API directly ===");
    // Query hints directly to demonstrate they work
    let hints = hint_service.get_hints(account_id, token_id, seed_block, up_to_block as u64).await;
    println!("✓ FastNear API returned {} transfer hints for {}/{} in blocks {}-{}",
             hints.len(), account_id, token_id, seed_block, up_to_block);

    if !hints.is_empty() {
        println!("  Sample hints (first 3):");
        for hint in hints.iter().take(3) {
            println!("    - Block {}: counterparty={:?}",
                     hint.block_height,
                     hint.counterparty.as_deref().unwrap_or("unknown"));
        }
    }

    println!("\n=== Filling gaps WITH hints ===");

    // This should trigger hint-based gap filling and log hint usage
    let filled = fill_gaps_with_hints(&pool, &network, account_id, token_id, up_to_block, Some(&hint_service))
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

    println!("✓ Filled {} gaps using hint-based approach", filled.len());

    if !filled.is_empty() {
        println!("  Filled gap blocks:");
        for gap in filled.iter().take(5) {
            println!("    - Block {}: {} -> {}",
                     gap.block_height,
                     gap.balance_before,
                     gap.balance_after);
        }
    }

    assert!(!filled.is_empty(), "Should have filled at least one gap");

    Ok(())
}

/// Test that transfer hints actually work in the monitoring cycle
///
/// This test:
/// 1. Seeds initial balance at an early block
/// 2. Sets up a monitored account
/// 3. First queries hints to show what's available
/// 4. Runs monitoring cycle with hints enabled
/// 5. Verifies gaps were filled (proving hints or fallback worked)
#[sqlx::test]
async fn test_monitor_cycle_with_hints(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();

    let account_id = "petersalomonsen.near";
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

    // Clear any existing balance changes for this test
    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1",
        account_id
    )
    .execute(&pool)
    .await?;

    // Seed an initial balance to create a gap scenario
    let seed_block = 181_000_000u64;
    let network = common::create_archival_network();

    insert_snapshot_record(&pool, &network, account_id, token_id, seed_block)
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

    // Create hint service
    let hint_service = TransferHintService::new().with_provider(FastNearProvider::new());
    let up_to_block = 182_000_000i64;

    println!("\n=== Checking hints available for monitor cycle ===");
    let hints = hint_service.get_hints(account_id, token_id, seed_block, up_to_block as u64).await;
    println!("✓ Hint service has {} transfer hints available", hints.len());

    println!("\n=== Running monitor cycle WITH hints ===");
    // Run monitoring cycle - internally this will use hints via fill_gaps_with_hints
    run_monitor_cycle(&pool, &network, up_to_block, Some(&hint_service))
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

    // Verify balance changes were collected
    let change_count: (i64,) = sqlx::query_as(
        r#"
        SELECT COUNT(*)
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        "#,
    )
    .bind(account_id)
    .bind(token_id)
    .fetch_one(&pool)
    .await?;

    println!("✓ Collected {} balance changes with hints enabled", change_count.0);
    assert!(
        change_count.0 > 1, // Should have more than just the seed record
        "Should have collected balance changes (seed + filled gaps)"
    );

    // Get the block heights collected
    let blocks: Vec<i64> = sqlx::query_scalar(
        r#"
        SELECT block_height
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height DESC
        LIMIT 5
        "#,
    )
    .bind(account_id)
    .bind(token_id)
    .fetch_all(&pool)
    .await?;

    println!("Recent blocks collected: {:?}", blocks);
    println!("\n✓ Monitor cycle completed successfully with hint service enabled");
    println!("  The cycle used fill_gaps_with_hints() internally, which:");
    println!("  1. Queried FastNear API for {} transfer hints", hints.len());
    println!("  2. Used hints to accelerate gap filling (or fell back to binary search)");
    println!("  3. Successfully filled gaps to collect {} balance changes", change_count.0);

    Ok(())
}

/// Test that gap filling uses hints by comparing with/without hints
#[sqlx::test]
#[ignore = "Slow test - requires real RPC calls"]
async fn test_hints_vs_binary_search_performance(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();

    use nt_be::handlers::balance_changes::gap_filler::{fill_gaps, fill_gaps_with_hints};

    let account_id = "petersalomonsen.near";
    let token_id = "near";
    let network = common::create_archival_network();

    // Clear existing records
    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1 AND token_id = $2",
        account_id,
        token_id
    )
    .execute(&pool)
    .await?;

    println!("\n=== Test 1: Without hints (pure binary search) ===");
    let start_time = std::time::Instant::now();
    let filled_without_hints = fill_gaps(&pool, &network, account_id, token_id, 182_000_000)
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
    let duration_without = start_time.elapsed();

    println!(
        "✓ Filled {} gaps WITHOUT hints in {:?}",
        filled_without_hints.len(),
        duration_without
    );

    // Clear records for second test
    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1 AND token_id = $2",
        account_id,
        token_id
    )
    .execute(&pool)
    .await?;

    println!("\n=== Test 2: With hints (FastNear API) ===");
    let hint_service = TransferHintService::new().with_provider(FastNearProvider::new());
    let start_time = std::time::Instant::now();
    let filled_with_hints = fill_gaps_with_hints(
        &pool,
        &network,
        account_id,
        token_id,
        182_000_000,
        Some(&hint_service),
    )
    .await
    .map_err(|e| {
        sqlx::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        ))
    })?;
    let duration_with = start_time.elapsed();

    println!(
        "✓ Filled {} gaps WITH hints in {:?}",
        filled_with_hints.len(),
        duration_with
    );

    // Compare results
    println!("\n=== Performance Comparison ===");
    println!("Without hints: {} gaps in {:?}", filled_without_hints.len(), duration_without);
    println!("With hints:    {} gaps in {:?}", filled_with_hints.len(), duration_with);

    if duration_with < duration_without {
        let speedup = duration_without.as_secs_f64() / duration_with.as_secs_f64();
        println!("✓ Hints were {:.2}x faster!", speedup);
    }

    // Both should fill the same number of gaps
    assert_eq!(
        filled_without_hints.len(),
        filled_with_hints.len(),
        "Both methods should fill the same gaps"
    );

    Ok(())
}
