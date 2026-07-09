//! End-to-end test for account maintenance gap filling
//!
//! Simulates the real-world scenario from 2026-02-03 where two payment transactions
//! on webassemblymusic-treasury.sputnik-dao.near didn't show up immediately because
//! the monitoring worker was busy finding staking rewards for testing-astradao.sputnik-dao.near.
//!
//! The maintenance worker (which replaced the old dirty monitor) processes dirty accounts
//! independently, filling gaps for marked accounts.
//!
//! Expected payments from petersalomonsen.near at blocks:
//! - 183985506
//! - 183985508

mod common;

use bigdecimal::BigDecimal;
use nt_be::handlers::balance_changes::account_monitor::fill_account_gaps;
use nt_be::handlers::balance_changes::gap_filler::insert_snapshot_record;
use nt_be::handlers::balance_changes::utils::block_timestamp_to_datetime;
use serde_json::json;
use sqlx::PgPool;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Instant;
use tower::ServiceExt;

const TREASURY_ACCOUNT: &str = "webassemblymusic-treasury.sputnik-dao.near";

/// Block before the two payment transactions — the system is "caught up" to here
const BASELINE_BLOCK: i64 = 183_985_000;

/// Block after the two payment transactions — maintenance task should find them by here
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
/// Note: `near` is seeded via insert_snapshot_record (needs real on-chain balance)
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

/// End-to-end test: maintenance worker detects payment transactions via gap filling.
///
/// Scenario:
/// 1. Treasury account is registered and has token snapshots at BASELINE_BLOCK
/// 2. Two payment transactions happen between BASELINE_BLOCK and DIRTY_UP_TO_BLOCK
/// 3. Mark account dirty (simulating user opening the treasury)
/// 4. Run fill_account_gaps up to DIRTY_UP_TO_BLOCK
/// 5. The two transactions should now be visible in the database
#[sqlx::test]
async fn test_maintenance_detects_payments(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
    let network = common::create_archival_network();

    println!("\n=== Account Maintenance Gap Filling E2E Test ===");
    println!("Treasury account: {}", TREASURY_ACCOUNT);
    println!("Baseline block:   {} (before payments)", BASELINE_BLOCK);
    println!("Dirty up-to block: {} (after payments)", DIRTY_UP_TO_BLOCK);

    // --- Setup: register account as monitored ---

    sqlx::query(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled)
        VALUES ($1, true)
        ON CONFLICT (account_id) DO UPDATE SET enabled = true, dirty_at = NULL
        "#,
    )
    .bind(TREASURY_ACCOUNT)
    .execute(&pool)
    .await?;

    // Clear existing balance changes
    sqlx::query("DELETE FROM balance_changes WHERE account_id = $1")
        .bind(TREASURY_ACCOUNT)
        .execute(&pool)
        .await?;

    println!("\n--- Phase 1: Seed token snapshots ---");

    // Seed NEAR balance via RPC (needs real on-chain balance for accurate gap filling)
    insert_snapshot_record(
        &pool,
        &network,
        TREASURY_ACCOUNT,
        "near",
        BASELINE_BLOCK as u64,
    )
    .await
    .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;
    println!("Seeded NEAR snapshot for {} via RPC", TREASURY_ACCOUNT);

    // Seed remaining token snapshots (data from https://api.trezu.app/api/balance-changes)
    let block_time = block_timestamp_to_datetime(BASELINE_BLOCK_TIMESTAMP);
    let zero = BigDecimal::from(0);

    for (token_id, balance_str) in TREASURY_TOKEN_SNAPSHOTS {
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
        .bind(TREASURY_ACCOUNT)
        .bind(*token_id)
        .bind(BASELINE_BLOCK)
        .bind(BASELINE_BLOCK_TIMESTAMP)
        .bind(block_time)
        .bind(&zero)
        .bind(&balance)
        .bind(&balance)
        .bind(Vec::<String>::new())
        .bind(Vec::<String>::new())
        .bind("SNAPSHOT")
        .bind(json!({}))
        .bind(json!({}))
        .execute(&pool)
        .await?;
    }
    println!(
        "Seeded {} token snapshots at block {}",
        TREASURY_TOKEN_SNAPSHOTS.len(),
        BASELINE_BLOCK
    );

    println!("\n--- Phase 2: Mark account as dirty and fill gaps ---");

    // Mark the treasury account as dirty via the POST /api/monitored-accounts endpoint
    let app_state = nt_be::AppState::builder()
        .db_pool(pool.clone())
        .build()
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;
    let app = nt_be::routes::create_routes(Arc::new(app_state));

    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/monitored-accounts")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({ "accountId": TREASURY_ACCOUNT }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        axum::http::StatusCode::OK,
        "POST /api/monitored-accounts should succeed and set dirty_at"
    );

    // Verify the response includes dirty_at
    let body_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
    assert!(
        body["dirtyAt"].is_string(),
        "Response should include dirtyAt timestamp, got: {}",
        body
    );

    println!(
        "Marked {} as dirty via POST /api/monitored-accounts (dirtyAt: {})",
        TREASURY_ACCOUNT, body["dirtyAt"]
    );

    // Run gap filling up to the block after the payments
    let start = Instant::now();
    let gaps_filled = fill_account_gaps(
        &pool,
        &network,
        TREASURY_ACCOUNT,
        DIRTY_UP_TO_BLOCK,
        None,
        None,
    )
    .await
    .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;
    let duration = start.elapsed();

    println!("Gap filling filled {} gaps in {:?}", gaps_filled, duration);

    println!("\n--- Phase 3: Verify the two payment transactions are now visible ---");

    // Query all non-snapshot NEAR balance changes after the baseline
    let post_changes: Vec<(i64, String, Vec<String>)> = sqlx::query_as(
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

    println!("New balance changes: {}", post_changes.len());
    for (block, counterparty, receipt_ids) in &post_changes {
        println!(
            "  Block {}: counterparty={}, receipt_ids={:?}",
            block, counterparty, receipt_ids
        );
    }

    // Collect all block heights from the new changes
    let found_blocks: Vec<i64> = post_changes.iter().map(|(b, _, _)| *b).collect();

    // Assert both expected payment blocks are now in the database
    for expected_block in EXPECTED_PAYMENT_BLOCKS {
        assert!(
            found_blocks.contains(expected_block),
            "Expected block {} to be found after gap filling.\nFound blocks: {:?}",
            expected_block,
            found_blocks
        );
    }

    // Verify counterparty and exact receipt IDs for each expected payment block
    for (i, &expected_block) in EXPECTED_PAYMENT_BLOCKS.iter().enumerate() {
        let (block, counterparty, receipt_ids) = post_changes
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

    println!("\n=== Results ===");
    println!("Gap filling duration: {:?}", duration);
    println!("Gaps filled: {}", gaps_filled);
    println!(
        "Both expected payment blocks found: {:?}",
        EXPECTED_PAYMENT_BLOCKS
    );

    println!("\nTest passed!");

    Ok(())
}
