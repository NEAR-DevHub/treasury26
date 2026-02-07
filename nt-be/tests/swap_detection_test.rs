//! Integration tests for swap detection
//!
//! Tests the full swap detection pipeline:
//! 1. resolve_receipt_to_transaction - traces receipts back to originating transactions
//! 2. backfill_transaction_hashes - fills in missing tx hashes from receipt data
//! 3. detect_swaps - groups multi-token balance changes from the same transaction
//!    AND detects intents swaps via time-proximity matching
//!
//! Uses webassemblymusic-treasury.sputnik-dao.near with real historical swap data.

mod common;

use nt_be::handlers::balance_changes::swap_detector::{
    backfill_transaction_hashes, detect_swaps_in_range,
};
use nt_be::handlers::balance_changes::transfer_hints::tx_resolver::{
    get_all_receipt_tx_mappings, resolve_receipt_to_transaction,
};
use serde::Deserialize;
use sqlx::PgPool;

const TEST_ACCOUNT: &str = "webassemblymusic-treasury.sputnik-dao.near";

/// Fixture record matching the JSON structure in webassemblymusic_sample.json
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureRecord {
    account_id: String,
    block_height: i64,
    block_time: String,
    token_id: String,
    receipt_id: Vec<String>,
    transaction_hashes: Vec<String>,
    counterparty: String,
    amount: String,
    balance_before: String,
    balance_after: String,
}

/// Load test fixture data and insert into the database
async fn load_fixture_data(pool: &PgPool, account_id: &str) -> sqlx::Result<usize> {
    let fixture_path = "tests/test_data/balance_changes/webassemblymusic_sample.json";
    let data = std::fs::read_to_string(fixture_path)
        .unwrap_or_else(|_| panic!("Failed to read fixture file: {}", fixture_path));

    let records: Vec<FixtureRecord> =
        serde_json::from_str(&data).expect("Failed to parse fixture JSON");

    // Insert monitored account
    sqlx::query!(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled)
        VALUES ($1, true)
        ON CONFLICT (account_id) DO UPDATE SET enabled = true
        "#,
        account_id
    )
    .execute(pool)
    .await?;

    // Clear existing balance changes for this account
    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1",
        account_id
    )
    .execute(pool)
    .await?;

    let mut count = 0;
    for record in &records {
        if record.account_id != account_id {
            continue;
        }

        let block_time: chrono::DateTime<chrono::Utc> = record
            .block_time
            .parse()
            .expect("Failed to parse block_time");

        let block_timestamp = block_time.timestamp_nanos_opt().unwrap_or(0);

        let amount: sqlx::types::BigDecimal = record
            .amount
            .parse()
            .expect("Failed to parse amount");
        let balance_before: sqlx::types::BigDecimal = record
            .balance_before
            .parse()
            .expect("Failed to parse balance_before");
        let balance_after: sqlx::types::BigDecimal = record
            .balance_after
            .parse()
            .expect("Failed to parse balance_after");

        sqlx::query!(
            r#"
            INSERT INTO balance_changes
            (account_id, token_id, block_height, block_timestamp, block_time, amount,
             balance_before, balance_after, transaction_hashes, receipt_id,
             counterparty, actions, raw_data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (account_id, block_height, token_id) DO NOTHING
            "#,
            account_id,
            record.token_id,
            record.block_height,
            block_timestamp,
            block_time,
            amount,
            balance_before,
            balance_after,
            &record.transaction_hashes as &[String],
            &record.receipt_id as &[String],
            record.counterparty,
            serde_json::json!({}),
            serde_json::json!({})
        )
        .execute(pool)
        .await?;

        count += 1;
    }

    Ok(count)
}

/// Test resolve_receipt_to_transaction with a known receipt
///
/// Receipt 4k8fzeY5VkQmRsseapsPBA2mNReroXdjQVpvHkhWURt1 belongs to
/// transaction CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5
/// and executed at block 178148635
#[sqlx::test]
async fn test_resolve_receipt_to_transaction(_pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
    let network = common::create_archival_network();

    let receipt_id = "4k8fzeY5VkQmRsseapsPBA2mNReroXdjQVpvHkhWURt1";
    let block_height = 178148635u64;

    println!("\n=== Resolve Receipt to Transaction Test ===");
    println!("Receipt: {}", receipt_id);
    println!("Block: {}", block_height);

    let result = resolve_receipt_to_transaction(&network, receipt_id, block_height)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    println!("Result: {:?}", result);

    assert_eq!(result.receipt_id, receipt_id, "Receipt ID should match");
    assert_eq!(
        result.transaction_hash, "CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5",
        "Should resolve to the correct originating transaction"
    );

    println!("\n✓ Successfully resolved receipt to transaction");

    Ok(())
}

/// Test get_all_receipt_tx_mappings returns all receipts for a transaction
#[sqlx::test]
async fn test_get_all_receipt_tx_mappings(_pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
    let network = common::create_archival_network();

    let tx_hash = "CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5";
    let sender = TEST_ACCOUNT;

    println!("\n=== Get All Receipt TX Mappings Test ===");
    println!("Transaction: {}", tx_hash);
    println!("Sender: {}", sender);

    let mappings = get_all_receipt_tx_mappings(&network, tx_hash, sender)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    println!("Found {} receipt-tx mappings:", mappings.len());
    for (receipt_id, mapped_tx_hash) in &mappings {
        println!("  Receipt {} -> TX {}", receipt_id, mapped_tx_hash);
    }

    assert!(
        !mappings.is_empty(),
        "Should have at least one receipt mapping"
    );

    // All mappings should point to the same transaction
    for (receipt_id, mapped_tx_hash) in &mappings {
        assert_eq!(
            mapped_tx_hash, tx_hash,
            "Receipt {} should map to transaction {}",
            receipt_id, tx_hash
        );
    }

    // Should contain the known receipt
    let has_known_receipt = mappings
        .iter()
        .any(|(r, _)| r == "4k8fzeY5VkQmRsseapsPBA2mNReroXdjQVpvHkhWURt1");
    assert!(
        has_known_receipt,
        "Should contain receipt 4k8fzeY5VkQmRsseapsPBA2mNReroXdjQVpvHkhWURt1"
    );

    println!("\n✓ Successfully retrieved all receipt-tx mappings");

    Ok(())
}

/// Test backfill_transaction_hashes updates records with missing tx hashes
///
/// This test:
/// 1. Inserts a balance change record with a receipt_id but no transaction_hash
/// 2. Runs backfill_transaction_hashes
/// 3. Verifies the transaction_hash was filled in
#[sqlx::test]
async fn test_backfill_transaction_hashes(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
    let network = common::create_archival_network();

    let account_id = TEST_ACCOUNT;

    // Insert monitored account
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

    // Clear existing balance changes for this account
    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1",
        account_id
    )
    .execute(&pool)
    .await?;

    // Insert a balance change with receipt_id but empty transaction_hashes
    // Using known receipt from block 178148635
    sqlx::query!(
        r#"
        INSERT INTO balance_changes
        (account_id, token_id, block_height, block_timestamp, block_time, amount,
         balance_before, balance_after, transaction_hashes, receipt_id,
         counterparty, actions, raw_data)
        VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11, $12)
        "#,
        account_id,
        "NEAR",
        178148635i64,
        1766561525616000000i64,
        sqlx::types::BigDecimal::from(-1), // dummy amount
        sqlx::types::BigDecimal::from(10), // dummy before
        sqlx::types::BigDecimal::from(9),  // dummy after
        &Vec::<String>::new() as &[String], // empty transaction_hashes
        &vec!["4k8fzeY5VkQmRsseapsPBA2mNReroXdjQVpvHkhWURt1".to_string()] as &[String],
        "petersalomonsen.near",
        serde_json::json!({}),
        serde_json::json!({})
    )
    .execute(&pool)
    .await?;

    println!("\n=== Backfill Transaction Hashes Test ===");
    println!("Account: {}", account_id);
    println!("Inserted record with receipt_id but no transaction_hash");

    // Verify the record has empty transaction_hashes
    let before: (Vec<String>,) = sqlx::query_as(
        "SELECT transaction_hashes FROM balance_changes WHERE account_id = $1 AND block_height = $2",
    )
    .bind(account_id)
    .bind(178148635i64)
    .fetch_one(&pool)
    .await?;

    assert!(
        before.0.is_empty(),
        "transaction_hashes should be empty before backfill"
    );

    // Run backfill
    let updated = backfill_transaction_hashes(&pool, &network, account_id)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    println!("Backfilled {} records", updated);

    assert_eq!(updated, 1, "Should have updated 1 record");

    // Verify the transaction_hash was filled in
    let after: (Vec<String>,) = sqlx::query_as(
        "SELECT transaction_hashes FROM balance_changes WHERE account_id = $1 AND block_height = $2",
    )
    .bind(account_id)
    .bind(178148635i64)
    .fetch_one(&pool)
    .await?;

    assert!(
        !after.0.is_empty(),
        "transaction_hashes should be non-empty after backfill"
    );
    assert_eq!(
        after.0[0], "CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5",
        "Should have backfilled the correct transaction hash"
    );

    println!("✓ Transaction hash backfilled: {}", after.0[0]);
    println!("\n✓ Backfill test passed!");

    Ok(())
}

/// Test intents swap detection via time-proximity using real fixture data
///
/// The fixture file contains a USDC → Base USDC swap across two different transactions:
/// - Block 171108230: intents USDC, amount=-10 (DAO proposal callback, no tx hash)
/// - Block 171108241: intents Base USDC, amount=+9.99998 (solver fulfillment, different tx hash)
///
/// These cannot be matched by tx-hash grouping. Time-proximity detection finds them
/// because they are intents tokens within a 20-block window with opposite signs.
#[sqlx::test]
async fn test_detect_intents_swap_from_fixture(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();

    let account_id = TEST_ACCOUNT;

    // Load real balance change data from fixture
    let loaded = load_fixture_data(&pool, account_id).await?;
    println!(
        "\n=== Intents Swap Detection Test (from fixture) ===\nLoaded {} records from fixture",
        loaded
    );

    assert!(loaded > 0, "Should have loaded fixture records");

    // Detect swaps around the known intents swap (blocks 171108200 - 171108300)
    let swaps = detect_swaps_in_range(&pool, account_id, 171108200, 171108300)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    println!("Detected {} swap(s)", swaps.len());
    for swap in &swaps {
        println!("  Swap type: {}", swap.transaction_hash);
        for leg in &swap.legs {
            println!(
                "    {} at block {}: amount={}",
                leg.token_id, leg.block_height, leg.amount
            );
        }
    }

    // Should detect the intents proximity swap
    assert_eq!(swaps.len(), 1, "Should detect exactly 1 swap");

    let swap = &swaps[0];
    assert_eq!(
        swap.transaction_hash, "intents-proximity",
        "Should be detected via time-proximity, not tx-hash grouping"
    );
    assert_eq!(swap.legs.len(), 2, "Swap should have 2 legs");

    // Verify the legs
    let leg_tokens: Vec<&str> = swap.legs.iter().map(|l| l.token_id.as_str()).collect();
    assert!(
        leg_tokens.iter().any(|t| t.contains("17208628f84f5d6ad")),
        "Swap should include the USDC (intents) leg"
    );
    assert!(
        leg_tokens.iter().any(|t| t.contains("base-0x833589fcd6edb6e")),
        "Swap should include the Base USDC (intents) leg"
    );

    // Verify block heights
    let leg_blocks: Vec<i64> = swap.legs.iter().map(|l| l.block_height).collect();
    assert!(
        leg_blocks.contains(&171108230),
        "Should include block 171108230 (USDC out)"
    );
    assert!(
        leg_blocks.contains(&171108241),
        "Should include block 171108241 (Base USDC in)"
    );

    // Verify receipt IDs from the fixture
    let all_receipts: Vec<&str> = swap
        .legs
        .iter()
        .flat_map(|l| l.receipt_ids.iter().map(|r| r.as_str()))
        .collect();
    assert!(
        all_receipts.contains(&"6bqKjx8UVTzJZ5WgrQVikL4jZ23CRTgqJjFCLVSCdtBU"),
        "Should include the USDC out receipt"
    );
    assert!(
        all_receipts.contains(&"8k8oSLc2fzQUgnrefNGkmX9Nrwmg4szzuTBg5xm7QtfD"),
        "Should include the Base USDC in receipt"
    );

    println!("\n✓ Intents swap detection test passed!");

    Ok(())
}

/// Test that single-token transactions are NOT detected as swaps
#[sqlx::test]
async fn test_no_false_positive_swaps(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();

    let account_id = TEST_ACCOUNT;

    // Insert monitored account
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

    // Clear existing balance changes
    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1",
        account_id
    )
    .execute(&pool)
    .await?;

    // Insert a simple NEAR transfer (NOT a swap)
    sqlx::query!(
        r#"
        INSERT INTO balance_changes
        (account_id, token_id, block_height, block_timestamp, block_time, amount,
         balance_before, balance_after, transaction_hashes, receipt_id,
         counterparty, actions, raw_data)
        VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11, $12)
        "#,
        account_id,
        "NEAR",
        178148635i64,
        1766561525616000000i64,
        sqlx::types::BigDecimal::from(-1),
        sqlx::types::BigDecimal::from(10),
        sqlx::types::BigDecimal::from(9),
        &vec!["single_token_tx".to_string()] as &[String],
        &vec!["receipt1".to_string()] as &[String],
        "petersalomonsen.near",
        serde_json::json!({}),
        serde_json::json!({})
    )
    .execute(&pool)
    .await?;

    // Insert another NEAR transfer with a DIFFERENT tx_hash
    sqlx::query!(
        r#"
        INSERT INTO balance_changes
        (account_id, token_id, block_height, block_timestamp, block_time, amount,
         balance_before, balance_after, transaction_hashes, receipt_id,
         counterparty, actions, raw_data)
        VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11, $12)
        "#,
        account_id,
        "NEAR",
        178148700i64,
        1766561525716000000i64,
        sqlx::types::BigDecimal::from(2),
        sqlx::types::BigDecimal::from(9),
        sqlx::types::BigDecimal::from(11),
        &vec!["different_tx".to_string()] as &[String],
        &vec!["receipt2".to_string()] as &[String],
        "alice.near",
        serde_json::json!({}),
        serde_json::json!({})
    )
    .execute(&pool)
    .await?;

    println!("\n=== No False Positive Swaps Test ===");
    println!("Account: {}", account_id);
    println!("Inserted 2 NEAR transfers with different tx_hashes");

    // Detect swaps
    let swaps = detect_swaps_in_range(&pool, account_id, 178148600, 178148800)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    println!("Detected {} swap(s)", swaps.len());

    assert!(
        swaps.is_empty(),
        "Single-token transfers should NOT be detected as swaps"
    );

    println!("\n✓ No false positive swaps detected!");

    Ok(())
}
