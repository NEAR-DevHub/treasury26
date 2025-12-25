use nf_be::services::gap_detector::find_gaps;
use sqlx::{PgPool, types::BigDecimal};
use std::{str::FromStr, fs};
use serde_json::Value;

/// Integration tests for balance change collection system.
/// These tests validate the core gap detection and filling functionality using real test data.

/// Load balance changes from test data into the database
async fn load_test_data(pool: &PgPool) -> sqlx::Result<(String, usize)> {
    let json_str = fs::read_to_string("../test-data/test-webassemblymusic-treasury.json")
        .expect("Failed to read test JSON file");
    let data: Value = serde_json::from_str(&json_str).expect("Failed to parse JSON");

    let account_id = data["accountId"].as_str().unwrap();
    let transactions = data["transactions"].as_array().unwrap();

    let mut near_inserts = 0;

    for tx in transactions {
        if !tx["changes"]["nearChanged"].as_bool().unwrap_or(false) {
            continue;
        }

        let block_height = tx["block"].as_i64().unwrap();
        let timestamp = tx["timestamp"].as_i64().unwrap();
        let balance_before = &tx["balanceBefore"];
        let balance_after = &tx["balanceAfter"];
        
        let near_before = BigDecimal::from_str(balance_before["near"].as_str().unwrap_or("0")).unwrap();
        let near_after = BigDecimal::from_str(balance_after["near"].as_str().unwrap_or("0")).unwrap();
        let near_diff = BigDecimal::from_str(tx["changes"]["nearDiff"].as_str().unwrap_or("0")).unwrap();

        let empty_transfers = vec![];
        let transfers = tx["transfers"].as_array().unwrap_or(&empty_transfers);
        let counterparty = transfers
            .iter()
            .find(|t| t["type"].as_str() != Some("action_receipt_gas_reward"))
            .and_then(|t| t["counterparty"].as_str())
            .unwrap_or("unknown");

        let actions = serde_json::to_value(&tx["transactions"]).unwrap();
        let receipt = if let Some(t) = transfers.first() {
            serde_json::json!({"receipt_id": t["receiptId"].as_str().unwrap_or("unknown")})
        } else {
            serde_json::json!({})
        };

        sqlx::query!(
            r#"
            INSERT INTO balance_changes 
            (account_id, token_id, block_height, block_timestamp, amount, balance_before, balance_after, counterparty, actions, receipt)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            "#,
            account_id,
            "near",
            block_height,
            timestamp,
            near_diff,
            near_before,
            near_after,
            Some(counterparty),
            actions,
            receipt
        )
        .execute(pool)
        .await?;

        near_inserts += 1;
    }

    Ok((account_id.to_string(), near_inserts))
}

#[sqlx::test]
async fn test_gap_detection_with_real_data(pool: PgPool) -> sqlx::Result<()> {
    let (account_id, record_count) = load_test_data(&pool).await?;
    
    println!("Loaded {} NEAR balance changes for {}", record_count, account_id);

    // Get the max block height to check up to
    let max_block = sqlx::query_scalar::<_, i64>(
        "SELECT MAX(block_height) FROM balance_changes WHERE account_id = $1 AND token_id = $2"
    )
    .bind(&account_id)
    .bind("near")
    .fetch_one(&pool)
    .await?;

    // Use the actual gap detection function
    let gaps = find_gaps(&pool, &account_id, "near", max_block).await?;

    println!("Gaps detected: {}", gaps.len());
    
    // The real test data should have a continuous chain (no gaps)
    assert_eq!(gaps.len(), 0, "Real test data should have no gaps in the balance chain");

    // Verify we loaded the expected amount of data
    let stats = sqlx::query!(
        r#"
        SELECT 
            count(*) as "total!",
            min(block_height) as "min_block!",
            max(block_height) as "max_block!"
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        "#,
        &account_id,
        "near"
    )
    .fetch_one(&pool)
    .await?;

    println!("Validated {} records from block {} to {}", 
             stats.total, stats.min_block, stats.max_block);

    assert!(stats.total > 0, "Should have loaded records");
    assert_eq!(stats.total, record_count as i64, "Record count should match");

    Ok(())
}

#[sqlx::test]
async fn test_gap_detection_with_removed_records(pool: PgPool) -> sqlx::Result<()> {
    let (account_id, record_count) = load_test_data(&pool).await?;
    
    println!("Loaded {} NEAR balance changes for {}", record_count, account_id);

    // Get some block heights to remove (create gaps)
    // We'll remove 3 non-consecutive records to create multiple gaps
    let blocks_to_remove = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT block_height 
        FROM balance_changes 
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height
        "#
    )
    .bind(&account_id)
    .bind("near")
    .fetch_all(&pool)
    .await?;

    // Take blocks at different positions to ensure they're not consecutive
    let blocks_to_delete = vec![
        blocks_to_remove[10],  // One from early in the chain
        blocks_to_remove[50],  // One from middle
        blocks_to_remove[100], // One from later
    ];

    println!("Removing records at blocks: {:?}", blocks_to_delete);

    // Delete these records to create gaps
    let deleted = sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1 AND token_id = $2 AND block_height = ANY($3)",
        &account_id,
        "near",
        &blocks_to_delete
    )
    .execute(&pool)
    .await?;

    println!("Deleted {} records", deleted.rows_affected());
    assert_eq!(deleted.rows_affected(), 3, "Should have deleted 3 records");

    // Get the max block height
    let max_block = sqlx::query_scalar::<_, i64>(
        "SELECT MAX(block_height) FROM balance_changes WHERE account_id = $1 AND token_id = $2"
    )
    .bind(&account_id)
    .bind("near")
    .fetch_one(&pool)
    .await?;

    // Run gap detection
    let gaps = find_gaps(&pool, &account_id, "near", max_block).await?;

    println!("Gaps detected: {}", gaps.len());
    for gap in &gaps {
        println!("  Gap: block {} to {} (balance {} -> {})", 
                 gap.start_block, gap.end_block, 
                 gap.actual_balance_after, gap.expected_balance_before);
    }

    // Removing 3 non-consecutive records should create 3 gaps
    assert_eq!(gaps.len(), 3, "Should detect exactly 3 gaps from removing 3 non-consecutive records");

    // Verify each removed block corresponds to a gap
    for &removed_block in &blocks_to_delete {
        let gap_found = gaps.iter().any(|g| {
            // The gap should span across the removed block
            g.start_block < removed_block && g.end_block > removed_block
        });
        assert!(gap_found, "Should find a gap spanning the removed block {}", removed_block);
    }

    Ok(())
}
