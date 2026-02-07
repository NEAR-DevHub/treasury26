//! Integration tests for swap detection
//!
//! Tests the full swap detection pipeline:
//! 1. resolve_receipt_to_transaction - traces receipts back to originating transactions
//! 2. backfill_transaction_hashes - fills in missing tx hashes from receipt data
//! 3. detect_swaps - identifies solver fulfillments for intents swaps
//!
//! Uses webassemblymusic-treasury.sputnik-dao.near with real historical swap data.

mod common;

use nt_be::handlers::balance_changes::swap_detector::{
    backfill_transaction_hashes, detect_swaps_in_range, store_detected_swaps,
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

    // Clear existing detected swaps for this account
    sqlx::query!(
        "DELETE FROM detected_swaps WHERE account_id = $1",
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

/// Test swap detection using solver-based identification from real fixture data
///
/// The fixture file contains a USDC → Base USDC swap:
/// - Block 171108230: intents USDC, amount=-10 (DAO deposit, no tx hash)
/// - Block 171108241: intents Base USDC, amount=+9.99998 (solver fulfillment)
///
/// The swap is detected by finding the solver fulfillment (receive from solver)
/// and linking it back to the deposit.
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
        println!("  Solver TX: {}", swap.solver_transaction_hash);
        println!(
            "    Sent: {:?} (block {:?})",
            swap.sent_token_id, swap.deposit_block_height
        );
        println!(
            "    Received: {} (block {})",
            swap.received_token_id, swap.fulfillment_block_height
        );
    }

    // Should detect the swap fulfillment
    assert_eq!(swaps.len(), 1, "Should detect exactly 1 swap fulfillment");

    let swap = &swaps[0];

    // Verify the solver transaction
    assert_eq!(
        swap.solver_transaction_hash, "6LLejN4izEV5qu8xYHZPGbzY6i5yQCGSscPzNyiezt6r",
        "Should have the correct solver transaction hash"
    );

    // Verify the solver account
    assert_eq!(
        swap.solver_account_id,
        Some("solver-multichain-asset.near".to_string()),
        "Should identify the solver account"
    );

    // Verify the received token (fulfillment)
    assert!(
        swap.received_token_id.contains("base-0x833589fcd6edb6e"),
        "Should receive Base USDC"
    );
    assert_eq!(
        swap.fulfillment_block_height, 171108241,
        "Fulfillment should be at block 171108241"
    );

    // Verify the sent token (deposit) was matched
    assert!(
        swap.sent_token_id.is_some(),
        "Should have matched the deposit leg"
    );
    assert!(
        swap.sent_token_id.as_ref().unwrap().contains("17208628f84f5d6ad"),
        "Should have sent USDC"
    );
    assert_eq!(
        swap.deposit_block_height,
        Some(171108230),
        "Deposit should be at block 171108230"
    );

    // Verify receipt IDs
    assert_eq!(
        swap.fulfillment_receipt_id, "8k8oSLc2fzQUgnrefNGkmX9Nrwmg4szzuTBg5xm7QtfD",
        "Should have the correct fulfillment receipt"
    );
    assert_eq!(
        swap.deposit_receipt_id,
        Some("6bqKjx8UVTzJZ5WgrQVikL4jZ23CRTgqJjFCLVSCdtBU".to_string()),
        "Should have the correct deposit receipt"
    );

    println!("\n✓ Intents swap detection test passed!");

    Ok(())
}

/// Test storing detected swaps in the database
#[sqlx::test]
async fn test_store_detected_swaps(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();

    let account_id = TEST_ACCOUNT;

    // Load fixture data
    let loaded = load_fixture_data(&pool, account_id).await?;
    println!(
        "\n=== Store Detected Swaps Test ===\nLoaded {} records from fixture",
        loaded
    );

    // Detect swaps
    let swaps = detect_swaps_in_range(&pool, account_id, 171108200, 171108300)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    assert!(!swaps.is_empty(), "Should have detected swaps");

    // Store the swaps
    let stored = store_detected_swaps(&pool, &swaps)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    println!("Stored {} swap(s)", stored);
    assert_eq!(stored, swaps.len(), "Should have stored all detected swaps");

    // Verify stored in database
    let db_swaps: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT account_id, solver_transaction_hash, received_token_id, sent_token_id FROM detected_swaps WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_all(&pool)
    .await?;

    assert_eq!(db_swaps.len(), 1, "Should have 1 swap in database");
    assert_eq!(
        db_swaps[0].1, "6LLejN4izEV5qu8xYHZPGbzY6i5yQCGSscPzNyiezt6r",
        "Database should have correct solver tx hash"
    );

    // Test idempotency - storing again should not create duplicates
    let stored_again = store_detected_swaps(&pool, &swaps)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    assert_eq!(stored_again, 0, "Should not store duplicates");

    println!("\n✓ Store detected swaps test passed!");

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
        "Non-intents tokens should NOT be detected as swaps"
    );

    println!("\n✓ No false positive swaps detected!");

    Ok(())
}

/// Test that receives from non-solvers are NOT detected as swaps
#[sqlx::test]
async fn test_non_solver_receive_not_swap(pool: PgPool) -> sqlx::Result<()> {
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

    // Insert an intents token receive from a non-solver (e.g., a friend)
    sqlx::query!(
        r#"
        INSERT INTO balance_changes
        (account_id, token_id, block_height, block_timestamp, block_time, amount,
         balance_before, balance_after, transaction_hashes, receipt_id,
         counterparty, actions, raw_data)
        VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11, $12)
        "#,
        account_id,
        "intents.near:nep141:usdc.near",
        178148700i64,
        1766561525716000000i64,
        sqlx::types::BigDecimal::from(10),
        sqlx::types::BigDecimal::from(0),
        sqlx::types::BigDecimal::from(10),
        &vec!["friend_tx".to_string()] as &[String],
        &vec!["receipt_from_friend".to_string()] as &[String],
        "friend.near",  // Not a solver
        serde_json::json!({}),
        serde_json::json!({})
    )
    .execute(&pool)
    .await?;

    println!("\n=== Non-Solver Receive Test ===");
    println!("Account: {}", account_id);
    println!("Inserted intents token receive from friend.near (not a solver)");

    // Detect swaps
    let swaps = detect_swaps_in_range(&pool, account_id, 178148600, 178148800)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    println!("Detected {} swap(s)", swaps.len());

    assert!(
        swaps.is_empty(),
        "Receives from non-solvers should NOT be detected as swaps"
    );

    println!("\n✓ Non-solver receive correctly not detected as swap!");

    Ok(())
}
