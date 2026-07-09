//! Integration test for swap detection on testing-astradao.sputnik-dao.near
//!
//! Focuses on a specific USDC→USDt swap at blocks 185177656–185177657:
//!   - Block 185177656: intents.near:nep141:17208628f84f... +0.00001 (intents token change)
//!   - Block 185177657: usdt.tether-token.near +0.099845 from intents.near (USDT receive)
//!
//! The test reproduces the full gap-filler pipeline:
//!   1. Insert SNAPSHOT boundary records around the swap via archival RPC
//!   2. Detect gaps between the snapshots
//!   3. Binary-search to find the exact balance-change blocks
//!   4. Examine what counterparty / receipt_id / transaction_hash data the gap filler discovers
//!   5. Run the swap detector against the Intents Explorer API

mod common;

use nt_be::handlers::balance_changes::gap_detector::find_gaps;
use nt_be::handlers::balance_changes::gap_filler::{fill_gap, insert_snapshot_record};
use nt_be::handlers::balance_changes::swap_detector::detect_swaps_from_api;
use sqlx::PgPool;

const ACCOUNT_ID: &str = "testing-astradao.sputnik-dao.near";

/// The USDC intents token involved in the swap
const INTENTS_USDC_TOKEN: &str =
    "intents.near:nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/// The USDT token received as the swap fulfillment
const USDT_TOKEN: &str = "usdt.tether-token.near";

/// Boundary blocks: snapshots where the balance did NOT change,
/// bracketing the swap that happened at blocks 185177656–185177657.
const SNAPSHOT_BEFORE: u64 = 185177600;
const SNAPSHOT_AFTER: u64 = 185177700;

/// End-to-end test: insert snapshot boundaries, binary-search to discover the swap
/// balance changes, examine the populated data, then run the swap detector.
#[sqlx::test]
async fn test_swap_detection_for_usdc_to_usdt_swap(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
    let network = common::create_archival_network();

    let api_key = std::env::var("INTENTS_EXPLORER_API_KEY").ok();
    let api_url = std::env::var("INTENTS_EXPLORER_API_URL")
        .unwrap_or_else(|_| "https://explorer.near-intents.org/api/v0".to_string());

    // ── Step 1: Insert SNAPSHOT boundaries for both tokens ──────────────────
    println!("\n=== Step 1: Inserting SNAPSHOT boundaries via archival RPC ===\n");

    for (label, token_id) in [("intents USDC", INTENTS_USDC_TOKEN), ("USDT", USDT_TOKEN)] {
        for block in [SNAPSHOT_BEFORE, SNAPSHOT_AFTER] {
            let snap = insert_snapshot_record(&pool, &network, ACCOUNT_ID, token_id, block)
                .await
                .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?
                .expect("Should insert snapshot");
            println!(
                "  {} snapshot at block {}: balance = {}",
                label, block, snap.balance_after
            );
        }
    }

    // ── Step 2: Detect gaps between the snapshots ───────────────────────────
    println!("\n=== Step 2: Detecting gaps between snapshots ===\n");

    let intents_gaps =
        find_gaps(&pool, ACCOUNT_ID, INTENTS_USDC_TOKEN, SNAPSHOT_AFTER as i64).await?;
    println!(
        "  intents USDC: {} gap(s) in [{}, {}]",
        intents_gaps.len(),
        SNAPSHOT_BEFORE,
        SNAPSHOT_AFTER
    );
    for g in &intents_gaps {
        println!(
            "    blocks [{}, {}]  balance_after={} expected_before={}",
            g.start_block, g.end_block, g.actual_balance_after, g.expected_balance_before
        );
    }

    let usdt_gaps = find_gaps(&pool, ACCOUNT_ID, USDT_TOKEN, SNAPSHOT_AFTER as i64).await?;
    println!(
        "  USDT: {} gap(s) in [{}, {}]",
        usdt_gaps.len(),
        SNAPSHOT_BEFORE,
        SNAPSHOT_AFTER
    );
    for g in &usdt_gaps {
        println!(
            "    blocks [{}, {}]  balance_after={} expected_before={}",
            g.start_block, g.end_block, g.actual_balance_after, g.expected_balance_before
        );
    }

    assert!(
        !intents_gaps.is_empty(),
        "Should detect a gap for intents USDC token between the snapshots"
    );
    assert!(
        !usdt_gaps.is_empty(),
        "Should detect a gap for USDT token between the snapshots"
    );

    // ── Step 3: Binary-search to fill each gap ──────────────────────────────
    println!("\n=== Step 3: Binary search to fill gaps ===\n");

    for gap in &intents_gaps {
        let filled = fill_gap(&pool, &network, gap)
            .await
            .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;
        println!(
            "  intents USDC: found balance change at block {} ({} -> {})",
            filled.block_height, filled.balance_before, filled.balance_after
        );
    }

    for gap in &usdt_gaps {
        let filled = fill_gap(&pool, &network, gap)
            .await
            .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;
        println!(
            "  USDT: found balance change at block {} ({} -> {})",
            filled.block_height, filled.balance_before, filled.balance_after
        );
    }

    // ── Step 4: Examine what data the gap filler discovered ─────────────────
    println!("\n=== Step 4: Examining discovered records ===\n");

    let records = sqlx::query!(
        r#"
        SELECT token_id, block_height, amount::TEXT as "amount!",
               transaction_hashes, receipt_id, counterparty
        FROM balance_changes
        WHERE account_id = $1
          AND counterparty != 'SNAPSHOT'
        ORDER BY block_height
        "#,
        ACCOUNT_ID,
    )
    .fetch_all(&pool)
    .await?;

    for r in &records {
        println!(
            "  block={} token={} amount={} counterparty={} tx_hashes={:?} receipts={:?}",
            r.block_height,
            r.token_id.as_deref().unwrap_or("?"),
            r.amount,
            r.counterparty,
            r.transaction_hashes,
            r.receipt_id,
        );
    }

    // Verify the intents record
    let intents_rec = records
        .iter()
        .find(|r| r.token_id.as_deref() == Some(INTENTS_USDC_TOKEN))
        .expect("Should have intents USDC record");
    assert_eq!(
        intents_rec.counterparty, "UNKNOWN",
        "Intents tokens should have UNKNOWN counterparty (resolved later by swap detector)"
    );
    assert!(
        !intents_rec.transaction_hashes.is_empty(),
        "Intents record should have candidate tx hashes from account_changes on intents.near"
    );

    // Verify the USDT record
    let usdt_rec = records
        .iter()
        .find(|r| r.token_id.as_deref() == Some(USDT_TOKEN))
        .expect("Should have USDT record");
    assert_eq!(
        usdt_rec.counterparty, "intents.near",
        "USDT receive should have intents.near as counterparty"
    );
    assert!(
        !usdt_rec.receipt_id.is_empty(),
        "USDT record should have receipt_ids from FT counterparty resolution"
    );
    assert!(
        !usdt_rec.transaction_hashes.is_empty(),
        "USDT record should have tx hash resolved from receipt via account_changes"
    );

    println!("\n  Summary:");
    println!(
        "    intents USDC: tx_hashes={:?}, receipts={}",
        intents_rec.transaction_hashes,
        intents_rec.receipt_id.len()
    );
    println!(
        "    USDT:         tx_hashes={:?}, receipts={}",
        usdt_rec.transaction_hashes,
        usdt_rec.receipt_id.len()
    );

    // ── Step 5: Run swap detection ──────────────────────────────────────────
    println!("\n=== Step 5: Running swap detection via Intents Explorer API ===\n");

    let swaps = detect_swaps_from_api(&pool, ACCOUNT_ID, api_key.as_deref(), &api_url)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    println!("Detected {} swap(s)", swaps.len());
    for swap in &swaps {
        println!(
            "  tx={} | sent={:?} ({:?}) -> received={} ({}) | deposit_block={:?} fulfillment_block={}",
            swap.solver_transaction_hash,
            swap.sent_token_id,
            swap.sent_amount,
            swap.received_token_id,
            swap.received_amount,
            swap.deposit_block_height,
            swap.fulfillment_block_height,
        );
    }

    assert!(
        !swaps.is_empty(),
        "Expected at least one swap detected via Intents Explorer API"
    );

    let swap = &swaps[0];
    assert_eq!(swap.account_id, ACCOUNT_ID);

    // Sent side: USDC (origin asset from intents API)
    assert_eq!(
        swap.sent_token_id.as_deref(),
        Some(INTENTS_USDC_TOKEN),
        "Sent token should be intents USDC"
    );
    assert!(
        swap.sent_amount.is_some(),
        "Sent amount should be populated from API"
    );

    // Received side: the positive intents balance change from the fulfillment
    assert!(
        swap.received_token_id.starts_with("intents.near:"),
        "Received token should be an intents token, got: {}",
        swap.received_token_id
    );
    assert!(
        swap.received_amount > 0,
        "Received amount should be positive, got: {}",
        swap.received_amount
    );

    // Fulfillment should be linked to a balance change
    assert!(
        swap.fulfillment_balance_change_id > 0,
        "Fulfillment should be linked to a balance change"
    );

    println!("\n=== Results ===");
    println!("Swap detection found {} matches", swaps.len());

    Ok(())
}
