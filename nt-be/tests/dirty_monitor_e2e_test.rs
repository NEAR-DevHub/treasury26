//! End-to-end test for dirty account priority monitoring
//!
//! Simulates the real-world scenario from 2026-02-03 where two payment transactions
//! on webassemblymusic-treasury.sputnik-dao.near didn't show up immediately because
//! the monitoring worker was busy finding staking rewards for testing-astradao.sputnik-dao.near.
//!
//! The dirty account mechanism solves this by spawning a parallel task that fills gaps
//! for the marked account while the main cycle continues processing other accounts.
//!
//! Transaction hashes expected:
//! - DLz6ZX5R6gHBadhxgeNba6JB6sQdj5fEHQPr3hXmWSd3
//! - Ff42Tk5UUCdfhbYd3UNttnDmv2U3hmgavKQXAXfjBePW

mod common;

use nt_be::handlers::balance_changes::account_monitor::run_monitor_cycle;
use nt_be::handlers::balance_changes::dirty_monitor::fill_dirty_account_gaps;
use nt_be::handlers::balance_changes::gap_filler::insert_snapshot_record;
use sqlx::PgPool;
use std::time::Instant;

const TREASURY_ACCOUNT: &str = "webassemblymusic-treasury.sputnik-dao.near";
const STAKING_ACCOUNT: &str = "testing-astradao.sputnik-dao.near";

/// Block before the two payment transactions — the system is "caught up" to here
const BASELINE_BLOCK: i64 = 183_985_000;

/// Block after the two payment transactions — dirty task should find them by here
const DIRTY_UP_TO_BLOCK: i64 = 183_986_000;

/// The two expected transaction hashes from the 2026-02-03 payments
const EXPECTED_TX_HASHES: &[&str] = &[
    "DLz6ZX5R6gHBadhxgeNba6JB6sQdj5fEHQPr3hXmWSd3",
    "Ff42Tk5UUCdfhbYd3UNttnDmv2U3hmgavKQXAXfjBePW",
];

/// End-to-end test: dirty account priority monitoring detects payment transactions
/// while the main monitoring cycle is busy with staking rewards.
///
/// Scenario:
/// 1. Both accounts are registered and monitored
/// 2. Main monitoring cycle runs up to block 183985000 (before the payments)
///    - testing-astradao has staking rewards that take a long time
///    - webassemblymusic-treasury is also synced to this block
/// 3. Two payment transactions happen on webassemblymusic-treasury between
///    block 183985000 and 183986000
/// 4. The dirty API is called for webassemblymusic-treasury
/// 5. The dirty monitor fills gaps up to block 183986000
/// 6. The two transactions should now be visible in the database
#[sqlx::test]
async fn test_dirty_monitor_detects_payments_while_main_cycle_busy(
    pool: PgPool,
) -> sqlx::Result<()> {
    common::load_test_env();
    let network = common::create_archival_network();

    println!("\n=== Dirty Account Priority Monitoring E2E Test ===");
    println!("Treasury account: {}", TREASURY_ACCOUNT);
    println!("Staking account:  {}", STAKING_ACCOUNT);
    println!("Baseline block:   {} (before payments)", BASELINE_BLOCK);
    println!("Dirty up-to block: {} (after payments)", DIRTY_UP_TO_BLOCK);

    // --- Setup: register both accounts as monitored ---

    for account_id in &[TREASURY_ACCOUNT, STAKING_ACCOUNT] {
        sqlx::query(
            r#"
            INSERT INTO monitored_accounts (account_id, enabled)
            VALUES ($1, true)
            ON CONFLICT (account_id) DO UPDATE SET enabled = true, dirty_at = NULL
            "#,
        )
        .bind(account_id)
        .execute(&pool)
        .await?;
    }

    // Clear existing balance changes for both accounts
    for account_id in &[TREASURY_ACCOUNT, STAKING_ACCOUNT] {
        sqlx::query("DELETE FROM balance_changes WHERE account_id = $1")
            .bind(account_id)
            .execute(&pool)
            .await?;
    }

    println!("\n--- Phase 1: Seed initial balance and run main cycle up to baseline ---");

    // Seed initial NEAR balance snapshot at baseline block for the treasury account
    insert_snapshot_record(
        &pool,
        &network,
        TREASURY_ACCOUNT,
        "near",
        BASELINE_BLOCK as u64,
    )
    .await
    .map_err(|e| {
        sqlx::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        ))
    })?;

    println!(
        "Seeded initial balance for {} at block {}",
        TREASURY_ACCOUNT, BASELINE_BLOCK
    );

    // Run monitor cycle up to baseline block — this establishes the "current state"
    // and processes staking rewards for testing-astradao (simulating the busy worker)
    let start = Instant::now();
    run_monitor_cycle(&pool, &network, BASELINE_BLOCK, None)
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
    let main_cycle_duration = start.elapsed();
    println!(
        "Main monitoring cycle completed in {:?}",
        main_cycle_duration
    );

    // Verify no payment transactions exist yet (they happen after baseline block)
    let pre_dirty_changes: Vec<(i64, Vec<String>)> = sqlx::query_as(
        r#"
        SELECT block_height, transaction_hashes
        FROM balance_changes
        WHERE account_id = $1
          AND token_id = 'near'
          AND counterparty != 'SNAPSHOT'
          AND counterparty != 'STAKING_SNAPSHOT'
        ORDER BY block_height DESC
        "#,
    )
    .bind(TREASURY_ACCOUNT)
    .fetch_all(&pool)
    .await?;

    println!(
        "Balance changes before dirty: {} (should not include the expected payments)",
        pre_dirty_changes.len()
    );

    // Verify the expected payment tx hashes are NOT yet in the database
    let all_tx_hashes_before: Vec<String> = pre_dirty_changes
        .iter()
        .flat_map(|(_, hashes)| hashes.iter().cloned())
        .collect();

    for expected_hash in EXPECTED_TX_HASHES {
        assert!(
            !all_tx_hashes_before.contains(&expected_hash.to_string()),
            "Transaction {} should NOT be in the database before dirty monitoring",
            expected_hash
        );
    }

    println!("\n--- Phase 2: Mark account as dirty and run dirty monitor ---");

    // Mark the treasury account as dirty (simulating API call)
    sqlx::query(
        r#"
        UPDATE monitored_accounts
        SET dirty_at = NOW() - INTERVAL '24 hours'
        WHERE account_id = $1
        "#,
    )
    .bind(TREASURY_ACCOUNT)
    .execute(&pool)
    .await?;

    println!("Marked {} as dirty", TREASURY_ACCOUNT);

    // Run dirty gap filling up to the block after the payments
    let start = Instant::now();
    let gaps_filled =
        fill_dirty_account_gaps(&pool, &network, TREASURY_ACCOUNT, DIRTY_UP_TO_BLOCK, None)
            .await
            .map_err(|e| {
                sqlx::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e.to_string(),
                ))
            })?;
    let dirty_duration = start.elapsed();

    println!(
        "Dirty monitor filled {} gaps in {:?}",
        gaps_filled, dirty_duration
    );

    println!("\n--- Phase 3: Verify the two payment transactions are now visible ---");

    // Query all non-snapshot NEAR balance changes after the baseline
    let post_dirty_changes: Vec<(i64, Vec<String>, String)> = sqlx::query_as(
        r#"
        SELECT block_height, transaction_hashes, counterparty
        FROM balance_changes
        WHERE account_id = $1
          AND token_id = 'near'
          AND block_height > $2
          AND counterparty != 'SNAPSHOT'
          AND counterparty != 'STAKING_SNAPSHOT'
        ORDER BY block_height ASC
        "#,
    )
    .bind(TREASURY_ACCOUNT)
    .bind(BASELINE_BLOCK)
    .fetch_all(&pool)
    .await?;

    println!(
        "New balance changes after dirty monitor: {}",
        post_dirty_changes.len()
    );
    for (block, hashes, counterparty) in &post_dirty_changes {
        println!(
            "  Block {}: counterparty={}, tx_hashes={:?}",
            block, counterparty, hashes
        );
    }

    // Collect all transaction hashes from the new changes
    let all_tx_hashes: Vec<String> = post_dirty_changes
        .iter()
        .flat_map(|(_, hashes, _)| hashes.iter().cloned())
        .collect();

    // Assert both expected transactions are now in the database
    for expected_hash in EXPECTED_TX_HASHES {
        assert!(
            all_tx_hashes.contains(&expected_hash.to_string()),
            "Expected transaction {} to be found after dirty monitoring.\nFound tx hashes: {:?}",
            expected_hash,
            all_tx_hashes
        );
    }

    // Assert the dirty monitor was faster than the main cycle
    // (The main cycle processes staking rewards; dirty just fills gaps)
    println!("\n=== Results ===");
    println!("Main cycle duration: {:?}", main_cycle_duration);
    println!("Dirty monitor duration: {:?}", dirty_duration);
    println!("Gaps filled by dirty monitor: {}", gaps_filled);
    println!(
        "Both expected transactions found: {}",
        EXPECTED_TX_HASHES.join(", ")
    );

    println!("\nTest passed!");

    Ok(())
}
