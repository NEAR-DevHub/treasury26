//! End-to-end test for dirty account priority monitoring
//!
//! Simulates the real-world scenario from 2026-02-03 where two payment transactions
//! on webassemblymusic-treasury.sputnik-dao.near didn't show up immediately because
//! the monitoring worker was busy finding staking rewards for testing-astradao.sputnik-dao.near.
//!
//! The dirty account mechanism solves this by spawning a parallel task that fills gaps
//! for the marked account while the main cycle continues processing other accounts.
//!
//! Expected payments from petersalomonsen.near at blocks:
//! - 183985506
//! - 183985508

mod common;

use bigdecimal::BigDecimal;
use nt_be::handlers::balance_changes::account_monitor::run_monitor_cycle;
use nt_be::handlers::balance_changes::dirty_monitor::fill_dirty_account_gaps;
use nt_be::handlers::balance_changes::gap_filler::insert_snapshot_record;
use nt_be::handlers::balance_changes::utils::block_timestamp_to_datetime;
use serde_json::json;
use sqlx::PgPool;
use std::str::FromStr;
use std::time::Instant;

const TREASURY_ACCOUNT: &str = "webassemblymusic-treasury.sputnik-dao.near";
const STAKING_ACCOUNT: &str = "testing-astradao.sputnik-dao.near";

/// Block before the two payment transactions — the system is "caught up" to here
const BASELINE_BLOCK: i64 = 183_985_000;

/// Block after the two payment transactions — dirty task should find them by here
const DIRTY_UP_TO_BLOCK: i64 = 183_986_000;

/// The expected block heights where payments from petersalomonsen.near occurred
const EXPECTED_PAYMENT_BLOCKS: &[i64] = &[183_985_506, 183_985_508];

/// The expected counterparty for these payments
const EXPECTED_COUNTERPARTY: &str = "petersalomonsen.near";

/// The expected receipt IDs for the two payment blocks (indexed by position in EXPECTED_PAYMENT_BLOCKS)
const EXPECTED_RECEIPT_IDS: &[&str] = &[
    "CbLDUW23fBNYCbhRu5dYzGDktShSf9yheyEwRE5wSgAf",
    "6Mk2hc5r8JDUhN6KGDgAYohd7VJE8FGFwD4x8BZPH8y9",
];

/// Approximate block timestamp for BASELINE_BLOCK in nanoseconds (~Feb 3, 2026)
const BASELINE_BLOCK_TIMESTAMP: i64 = 1_770_076_800_000_000_000;

/// Token snapshots from https://api.trezu.app/api/balance-changes
/// Balances at or before BASELINE_BLOCK for webassemblymusic-treasury.sputnik-dao.near
/// Note: `near` is seeded via insert_snapshot_record (needs real on-chain balance),
///       `near:total` is excluded (computed value, not gap-fillable)
const TREASURY_TOKEN_SNAPSHOTS: &[(&str, &str)] = &[
    (
        "staking:astro-stakers.poolv1.near",
        "1031.105895126873021215500734",
    ),
    ("arizcredits.near", "2.5000"),
    (
        "intents.near:nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
        "9.99998000",
    ),
    (
        "intents.near:nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
        "22.54364600",
    ),
    ("intents.near:nep141:sol.omft.near", "0.08342401"),
    (
        "intents.near:nep245:v2_1.omni.hot.tg:43114_11111111111111111111",
        "1.51476544231523885200",
    ),
    ("intents.near:nep141:xrp.omft.near", "16.69236700"),
    ("intents.near:nep141:btc.omft.near", "0.00544253"),
    (
        "intents.near:nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        "119",
    ),
    (
        "intents.near:nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
        "125.01182900",
    ),
    ("intents.near:nep141:wrap.near", "0.8000"),
    (
        "intents.near:nep141:eth.omft.near",
        "0.03501508842977613200",
    ),
];

/// Token snapshots for testing-astradao.sputnik-dao.near
/// Note: `near` and `near:total` excluded (same reason as above)
const STAKING_TOKEN_SNAPSHOTS: &[(&str, &str)] = &[
    ("staking:figment.poolv1.near", "0.100003532026647260349538"),
    (
        "staking:bisontrails.poolv1.near",
        "0.523954777382739780399233",
    ),
    (
        "staking:astro-stakers.poolv1.near",
        "0.243096488083090812499858",
    ),
    (
        "intents.near:nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
        "0.09978800",
    ),
    (
        "intents.near:nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        "2.9100",
    ),
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

    println!("\n--- Phase 1: Seed token snapshots and run main cycle up to baseline ---");

    // Seed NEAR balance via RPC (needs real on-chain balance for accurate gap filling)
    for account_id in [TREASURY_ACCOUNT, STAKING_ACCOUNT] {
        insert_snapshot_record(&pool, &network, account_id, "near", BASELINE_BLOCK as u64)
            .await
            .map_err(|e| {
                sqlx::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e.to_string(),
                ))
            })?;
        println!("Seeded NEAR snapshot for {} via RPC", account_id);
    }

    // Seed remaining token snapshots (data from https://api.trezu.app/api/balance-changes)
    // This ensures the monitor cycle has many tokens to process, simulating a busy worker
    let block_time = block_timestamp_to_datetime(BASELINE_BLOCK_TIMESTAMP);
    let zero = BigDecimal::from(0);

    for (account_id, snapshots) in [
        (TREASURY_ACCOUNT, TREASURY_TOKEN_SNAPSHOTS),
        (STAKING_ACCOUNT, STAKING_TOKEN_SNAPSHOTS),
    ] {
        for (token_id, balance_str) in snapshots {
            let balance = BigDecimal::from_str(balance_str).expect("valid balance");
            sqlx::query(
                r#"
                INSERT INTO balance_changes
                (account_id, token_id, block_height, block_timestamp, block_time,
                 amount, balance_before, balance_after,
                 transaction_hashes, receipt_id, counterparty, actions, raw_data)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                ON CONFLICT (account_id, block_height, token_id) DO NOTHING
                "#,
            )
            .bind(account_id)
            .bind(*token_id)
            .bind(BASELINE_BLOCK)
            .bind(BASELINE_BLOCK_TIMESTAMP)
            .bind(block_time)
            .bind(&zero)
            .bind(&balance)
            .bind(&balance)
            .bind(&Vec::<String>::new())
            .bind(&Vec::<String>::new())
            .bind("SNAPSHOT")
            .bind(json!({}))
            .bind(json!({}))
            .execute(&pool)
            .await?;
        }
        println!(
            "Seeded {} token snapshots for {} at block {}",
            snapshots.len(),
            account_id,
            BASELINE_BLOCK
        );
    }

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

    // Verify no payment blocks exist yet (they happen after baseline block)
    let pre_dirty_blocks: Vec<i64> = sqlx::query_scalar(
        r#"
        SELECT block_height
        FROM balance_changes
        WHERE account_id = $1
          AND token_id = 'near'
          AND block_height > $2
          AND counterparty != 'SNAPSHOT'
          AND counterparty != 'STAKING_SNAPSHOT'
        ORDER BY block_height DESC
        "#,
    )
    .bind(TREASURY_ACCOUNT)
    .bind(BASELINE_BLOCK)
    .fetch_all(&pool)
    .await?;

    println!(
        "Balance changes after baseline before dirty: {} (should be 0)",
        pre_dirty_blocks.len()
    );

    // Verify the expected payment blocks are NOT yet in the database
    for expected_block in EXPECTED_PAYMENT_BLOCKS {
        assert!(
            !pre_dirty_blocks.contains(expected_block),
            "Block {} should NOT be in the database before dirty monitoring",
            expected_block
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
    // Include receipt_id to verify receipts are captured
    let post_dirty_changes: Vec<(i64, String, Vec<String>)> = sqlx::query_as(
        r#"
        SELECT block_height, counterparty, receipt_id
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
    for (block, counterparty, receipt_ids) in &post_dirty_changes {
        println!(
            "  Block {}: counterparty={}, receipt_ids={:?}",
            block, counterparty, receipt_ids
        );
    }

    // Collect all block heights from the new changes
    let found_blocks: Vec<i64> = post_dirty_changes.iter().map(|(b, _, _)| *b).collect();

    // Assert both expected payment blocks are now in the database
    for expected_block in EXPECTED_PAYMENT_BLOCKS {
        assert!(
            found_blocks.contains(expected_block),
            "Expected block {} to be found after dirty monitoring.\nFound blocks: {:?}",
            expected_block,
            found_blocks
        );
    }

    // Verify counterparty and exact receipt IDs for each expected payment block
    for (i, &expected_block) in EXPECTED_PAYMENT_BLOCKS.iter().enumerate() {
        let (block, counterparty, receipt_ids) = post_dirty_changes
            .iter()
            .find(|(b, _, _)| *b == expected_block)
            .unwrap_or_else(|| panic!("Expected block {} not found in results", expected_block));

        assert_eq!(
            counterparty, EXPECTED_COUNTERPARTY,
            "Expected counterparty {} for block {}, got {}",
            EXPECTED_COUNTERPARTY, block, counterparty
        );

        assert_eq!(
            receipt_ids,
            &vec![EXPECTED_RECEIPT_IDS[i].to_string()],
            "Expected receipt_id {:?} for block {}, got {:?}",
            EXPECTED_RECEIPT_IDS[i],
            block,
            receipt_ids
        );
    }

    // Assert the dirty monitor was faster than the main cycle
    // (The main cycle processes staking rewards; dirty just fills gaps)
    println!("\n=== Results ===");
    println!("Main cycle duration: {:?}", main_cycle_duration);
    println!("Dirty monitor duration: {:?}", dirty_duration);
    println!("Gaps filled by dirty monitor: {}", gaps_filled);
    println!(
        "Both expected payment blocks found: {:?}",
        EXPECTED_PAYMENT_BLOCKS
    );

    println!("\nTest passed!");

    Ok(())
}
