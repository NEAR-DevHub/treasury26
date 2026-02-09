//! Integration tests for swap detection
//!
//! Tests the swap detection pipeline which uses the Intents Explorer API
//! to identify swaps and matches them to balance_changes records.

mod common;

use nt_be::handlers::balance_changes::swap_detector::store_detected_swaps;
use sqlx::PgPool;

const TEST_ACCOUNT: &str = "webassemblymusic-treasury.sputnik-dao.near";

/// Test storing detected swaps in the database
#[sqlx::test]
async fn test_store_detected_swaps(pool: PgPool) -> sqlx::Result<()> {
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

    // Clear existing detected swaps
    sqlx::query!(
        "DELETE FROM detected_swaps WHERE account_id = $1",
        account_id
    )
    .execute(&pool)
    .await?;

    // Insert a balance change record to satisfy the FK constraint
    sqlx::query!(
        r#"
        INSERT INTO balance_changes
        (account_id, token_id, block_height, block_timestamp, block_time, amount,
         balance_before, balance_after, transaction_hashes, receipt_id,
         counterparty, actions, raw_data)
        VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (account_id, block_height, token_id) DO NOTHING
        "#,
        account_id,
        "intents.near:nep141:base-usdc.near",
        171108241i64,
        1730666957002i64,
        sqlx::types::BigDecimal::from(10),
        sqlx::types::BigDecimal::from(0),
        sqlx::types::BigDecimal::from(10),
        &vec!["6LLejN4izEV5qu8xYHZPGbzY6i5yQCGSscPzNyiezt6r".to_string()] as &[String],
        &vec!["8k8oSLc2fzQUgnrefNGkmX9Nrwmg4szzuTBg5xm7QtfD".to_string()] as &[String],
        "solver-multichain-asset.near",
        serde_json::json!({}),
        serde_json::json!({})
    )
    .execute(&pool)
    .await?;

    // Get the balance change ID
    let bc_id: (i64,) = sqlx::query_as(
        "SELECT id FROM balance_changes WHERE account_id = $1 AND block_height = $2",
    )
    .bind(account_id)
    .bind(171108241i64)
    .fetch_one(&pool)
    .await?;

    // Create a DetectedSwap manually
    let swap = nt_be::handlers::balance_changes::swap_detector::DetectedSwap {
        solver_transaction_hash: "6LLejN4izEV5qu8xYHZPGbzY6i5yQCGSscPzNyiezt6r".to_string(),
        solver_account_id: Some("solver-multichain-asset.near".to_string()),
        account_id: account_id.to_string(),
        sent_token_id: Some("intents.near:nep141:usdc.near".to_string()),
        sent_amount: Some(sqlx::types::BigDecimal::from(-10)),
        deposit_block_height: Some(171108230),
        deposit_balance_change_id: None,
        deposit_receipt_id: Some("deposit_receipt".to_string()),
        received_token_id: "intents.near:nep141:base-usdc.near".to_string(),
        received_amount: sqlx::types::BigDecimal::from(10),
        fulfillment_block_height: 171108241,
        fulfillment_balance_change_id: bc_id.0,
        fulfillment_receipt_id: "8k8oSLc2fzQUgnrefNGkmX9Nrwmg4szzuTBg5xm7QtfD".to_string(),
    };

    println!("\n=== Store Detected Swaps Test ===");

    // Store the swap
    let stored = store_detected_swaps(&pool, &[swap.clone()])
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    println!("Stored {} swap(s)", stored);
    assert_eq!(stored, 1, "Should have stored 1 swap");

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

    // Test idempotency - storing again should not create duplicates in the database
    // (ON CONFLICT DO UPDATE reports rows_affected=1, but no new row is created)
    store_detected_swaps(&pool, &[swap])
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::other(e.to_string())))?;

    let db_swaps_after: Vec<(String,)> = sqlx::query_as(
        "SELECT solver_transaction_hash FROM detected_swaps WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_all(&pool)
    .await?;

    assert_eq!(
        db_swaps_after.len(),
        1,
        "Should still have exactly 1 swap after re-insert (no duplicates)"
    );

    println!("\n✓ Store detected swaps test passed!");

    Ok(())
}
