//! Integration tests for swap detection
//!
//! Tests the full swap detection pipeline:
//! 1. resolve_receipt_to_transaction - traces receipts back to originating transactions
//! 2. backfill_transaction_hashes - fills in missing tx hashes from receipt data
//! 3. detect_swaps - groups multi-token balance changes from the same transaction
//!
//! Uses webassemblymusic-treasury.sputnik-dao.near with real historical swap data.

mod common;

use nt_be::handlers::balance_changes::swap_detector::{
    backfill_transaction_hashes, detect_swaps_in_range,
};
use nt_be::handlers::balance_changes::transfer_hints::tx_resolver::{
    get_all_receipt_tx_mappings, resolve_receipt_to_transaction,
};
use sqlx::PgPool;

const TEST_ACCOUNT: &str = "webassemblymusic-treasury.sputnik-dao.near";

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

/// Test swap detection with manually inserted swap data
///
/// This test simulates a swap scenario by inserting two balance changes for different
/// tokens that share the same transaction hash, then verifies swap detection groups them.
#[sqlx::test]
async fn test_detect_swap_from_shared_tx_hash(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();

    let account_id = TEST_ACCOUNT;
    let tx_hash = "SwapTestTransaction123456789";

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

    // Insert swap leg 1: USDC decreases (sent)
    let usdc_token = "intents.near:nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
    sqlx::query!(
        r#"
        INSERT INTO balance_changes
        (account_id, token_id, block_height, block_timestamp, block_time, amount,
         balance_before, balance_after, transaction_hashes, receipt_id,
         counterparty, actions, raw_data)
        VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11, $12)
        "#,
        account_id,
        usdc_token,
        171108230i64,
        1700000000000000000i64,
        sqlx::types::BigDecimal::from(-100),
        sqlx::types::BigDecimal::from(200),
        sqlx::types::BigDecimal::from(100),
        &vec![tx_hash.to_string()] as &[String],
        &vec!["receipt_usdc_leg".to_string()] as &[String],
        "solver.near",
        serde_json::json!({}),
        serde_json::json!({})
    )
    .execute(&pool)
    .await?;

    // Insert swap leg 2: Base USDC increases (received)
    let base_usdc_token =
        "intents.near:nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
    sqlx::query!(
        r#"
        INSERT INTO balance_changes
        (account_id, token_id, block_height, block_timestamp, block_time, amount,
         balance_before, balance_after, transaction_hashes, receipt_id,
         counterparty, actions, raw_data)
        VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11, $12)
        "#,
        account_id,
        base_usdc_token,
        171108241i64,
        1700000001000000000i64,
        sqlx::types::BigDecimal::from(99),
        sqlx::types::BigDecimal::from(0),
        sqlx::types::BigDecimal::from(99),
        &vec![tx_hash.to_string()] as &[String],
        &vec!["receipt_base_usdc_leg".to_string()] as &[String],
        "solver.near",
        serde_json::json!({}),
        serde_json::json!({})
    )
    .execute(&pool)
    .await?;

    println!("\n=== Swap Detection Test ===");
    println!("Account: {}", account_id);
    println!(
        "Inserted 2 balance changes with shared tx_hash: {}",
        tx_hash
    );
    println!("  Leg 1: {} at block 171108230 (amount: -100)", usdc_token);
    println!(
        "  Leg 2: {} at block 171108241 (amount: +99)",
        base_usdc_token
    );

    // Detect swaps
    let swaps = detect_swaps_in_range(&pool, account_id, 171108200, 171108300)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    println!("\nDetected {} swap(s)", swaps.len());
    for swap in &swaps {
        println!("  Swap tx: {}", swap.transaction_hash);
        for leg in &swap.legs {
            println!(
                "    {} at block {}: amount={}",
                leg.token_id, leg.block_height, leg.amount
            );
        }
    }

    // Assertions
    assert_eq!(swaps.len(), 1, "Should detect exactly 1 swap");

    let swap = &swaps[0];
    assert_eq!(swap.transaction_hash, tx_hash, "Swap tx hash should match");
    assert_eq!(swap.account_id, account_id, "Swap account should match");
    assert_eq!(swap.legs.len(), 2, "Swap should have 2 legs");

    // Verify tokens
    let leg_tokens: Vec<&str> = swap.legs.iter().map(|l| l.token_id.as_str()).collect();
    assert!(
        leg_tokens.contains(&usdc_token),
        "Swap should include USDC leg"
    );
    assert!(
        leg_tokens.contains(&base_usdc_token),
        "Swap should include Base USDC leg"
    );

    // Verify the legs have different blocks (swap legs can occur at different blocks)
    let leg_blocks: Vec<i64> = swap.legs.iter().map(|l| l.block_height).collect();
    assert!(
        leg_blocks.contains(&171108230),
        "Should include block 171108230"
    );
    assert!(
        leg_blocks.contains(&171108241),
        "Should include block 171108241"
    );

    println!("\n✓ Swap detection test passed!");

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
