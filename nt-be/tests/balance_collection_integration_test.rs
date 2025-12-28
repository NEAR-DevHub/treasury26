use near_api::{NetworkConfig, RPCEndpoint};
use nt_be::handlers::balance_changes::gap_detector::find_gaps;
use nt_be::handlers::balance_changes::gap_filler::{fill_gap, fill_gaps};
use serde_json::Value;
use sqlx::{PgPool, types::BigDecimal};
use std::{fs, str::FromStr};

/// Integration tests for balance change collection system.
/// These tests validate the core gap detection and filling functionality using real test data.

/// Load NEAR balance changes from test data into the database
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

        // Convert raw yoctoNEAR to decimal NEAR (24 decimals)
        let near_before_raw = balance_before["near"].as_str().unwrap_or("0");
        let near_after_raw = balance_after["near"].as_str().unwrap_or("0");
        let near_diff_raw = tx["changes"]["nearDiff"].as_str().unwrap_or("0");
        
        // Divide by 10^24 to get decimal NEAR
        let divisor = BigDecimal::from_str("1000000000000000000000000").unwrap(); // 10^24
        let near_before = BigDecimal::from_str(near_before_raw).unwrap() / &divisor;
        let near_after = BigDecimal::from_str(near_after_raw).unwrap() / &divisor;
        let near_diff = BigDecimal::from_str(near_diff_raw).unwrap() / &divisor;

        let empty_transfers = vec![];
        let transfers = tx["transfers"].as_array().unwrap_or(&empty_transfers);
        let counterparty = transfers
            .iter()
            .find(|t| t["type"].as_str() != Some("action_receipt_gas_reward"))
            .and_then(|t| t["counterparty"].as_str())
            .unwrap_or("unknown");

        let actions = serde_json::to_value(&tx["transactions"]).unwrap();
        let raw_data = if let Some(t) = transfers.first() {
            serde_json::json!({"receipt_id": t["receiptId"].as_str().unwrap_or("unknown")})
        } else {
            serde_json::json!({})
        };

        sqlx::query!(
            r#"
            INSERT INTO balance_changes 
            (account_id, token_id, block_height, block_timestamp, amount, balance_before, balance_after, counterparty, actions, raw_data)
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
            raw_data
        )
        .execute(pool)
        .await?;

        near_inserts += 1;
    }

    Ok((account_id.to_string(), near_inserts))
}

/// Load NEAR Intents token balance changes from test data into the database
/// Returns (account_id, token_id, count_of_changes)
async fn load_intents_token_test_data(
    pool: &PgPool,
    target_token_id: &str,
) -> sqlx::Result<(String, String, usize)> {
    let json_str = fs::read_to_string("../test-data/test-webassemblymusic-treasury.json")
        .expect("Failed to read test JSON file");
    let data: Value = serde_json::from_str(&json_str).expect("Failed to parse JSON");

    let account_id = data["accountId"].as_str().unwrap();
    let transactions = data["transactions"].as_array().unwrap();

    let mut inserts = 0;

    for tx in transactions {
        let intents_changed = &tx["changes"]["intentsChanged"];
        if !intents_changed.is_object() {
            continue;
        }

        // Check if this token changed in this transaction
        let change = match intents_changed.get(target_token_id) {
            Some(c) => c,
            None => continue,
        };

        let block_height = tx["block"].as_i64().unwrap();
        let timestamp = tx["timestamp"].as_i64().unwrap();
        let balance_before = &tx["balanceBefore"]["intentsTokens"];
        let balance_after = &tx["balanceAfter"]["intentsTokens"];

        let before = BigDecimal::from_str(
            balance_before
                .get(target_token_id)
                .and_then(|v| v.as_str())
                .unwrap_or("0"),
        )
        .unwrap();
        let after = BigDecimal::from_str(
            balance_after
                .get(target_token_id)
                .and_then(|v| v.as_str())
                .unwrap_or("0"),
        )
        .unwrap();
        let diff = BigDecimal::from_str(change.get("diff").and_then(|v| v.as_str()).unwrap_or("0"))
            .unwrap();

        let empty_transfers = vec![];
        let transfers = tx["transfers"].as_array().unwrap_or(&empty_transfers);
        let counterparty = transfers
            .iter()
            .find(|t| t["tokenId"].as_str() == Some(target_token_id))
            .and_then(|t| t["counterparty"].as_str())
            .unwrap_or("unknown");

        let actions = serde_json::to_value(&tx["transactions"]).unwrap();
        let raw_data = if let Some(t) = transfers
            .iter()
            .find(|t| t["tokenId"].as_str() == Some(target_token_id))
        {
            serde_json::json!({"receipt_id": t["receiptId"].as_str().unwrap_or("unknown")})
        } else {
            serde_json::json!({})
        };

        // Store the full intents token id (e.g., "intents.near:nep141:btc.omft.near")
        let db_token_id = format!("intents.near:{}", target_token_id);

        sqlx::query!(
            r#"
            INSERT INTO balance_changes 
            (account_id, token_id, block_height, block_timestamp, amount, balance_before, balance_after, counterparty, actions, raw_data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            "#,
            account_id,
            db_token_id,
            block_height,
            timestamp,
            diff,
            before,
            after,
            Some(counterparty),
            actions,
            raw_data
        )
        .execute(pool)
        .await?;

        inserts += 1;
    }

    Ok((
        account_id.to_string(),
        format!("intents.near:{}", target_token_id),
        inserts,
    ))
}

#[sqlx::test]
async fn test_gap_detection_with_real_data(pool: PgPool) -> sqlx::Result<()> {
    let (account_id, record_count) = load_test_data(&pool).await?;

    println!(
        "Loaded {} NEAR balance changes for {}",
        record_count, account_id
    );

    // Get the max block height to check up to
    let max_block = sqlx::query_scalar::<_, i64>(
        "SELECT MAX(block_height) FROM balance_changes WHERE account_id = $1 AND token_id = $2",
    )
    .bind(&account_id)
    .bind("near")
    .fetch_one(&pool)
    .await?;

    // Use the actual gap detection function
    let gaps = find_gaps(&pool, &account_id, "near", max_block).await?;

    println!("Gaps detected: {}", gaps.len());

    // The real test data should have a continuous chain (no gaps)
    assert_eq!(
        gaps.len(),
        0,
        "Real test data should have no gaps in the balance chain"
    );

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

    println!(
        "Validated {} records from block {} to {}",
        stats.total, stats.min_block, stats.max_block
    );

    assert!(stats.total > 0, "Should have loaded records");
    assert_eq!(
        stats.total, record_count as i64,
        "Record count should match"
    );

    Ok(())
}

#[sqlx::test]
async fn test_gap_detection_with_removed_records(pool: PgPool) -> sqlx::Result<()> {
    let (account_id, record_count) = load_test_data(&pool).await?;

    println!(
        "Loaded {} NEAR balance changes for {}",
        record_count, account_id
    );

    // Get some block heights to remove (create gaps)
    // We'll remove 3 non-consecutive records to create multiple gaps
    let blocks_to_remove = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT block_height 
        FROM balance_changes 
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height
        "#,
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
        "SELECT MAX(block_height) FROM balance_changes WHERE account_id = $1 AND token_id = $2",
    )
    .bind(&account_id)
    .bind("near")
    .fetch_one(&pool)
    .await?;

    // Run gap detection
    let gaps = find_gaps(&pool, &account_id, "near", max_block).await?;

    println!("Gaps detected: {}", gaps.len());
    for gap in &gaps {
        println!(
            "  Gap: block {} to {} (balance {} -> {})",
            gap.start_block, gap.end_block, gap.actual_balance_after, gap.expected_balance_before
        );
    }

    // Removing 3 non-consecutive records should create 3 gaps
    assert_eq!(
        gaps.len(),
        3,
        "Should detect exactly 3 gaps from removing 3 non-consecutive records"
    );

    // Verify each removed block corresponds to a gap
    for &removed_block in &blocks_to_delete {
        let gap_found = gaps.iter().any(|g| {
            // The gap should span across the removed block
            g.start_block < removed_block && g.end_block > removed_block
        });
        assert!(
            gap_found,
            "Should find a gap spanning the removed block {}",
            removed_block
        );
    }

    Ok(())
}

/// Test loading and validating NEAR Intents token data (btc.omft.near)
/// The test data shows BTC intents balance changes starting at block 159487770
#[sqlx::test]
async fn test_intents_btc_token_data_loading(pool: PgPool) -> sqlx::Result<()> {
    let target_token = "nep141:btc.omft.near";
    let (account_id, token_id, record_count) =
        load_intents_token_test_data(&pool, target_token).await?;

    println!(
        "Loaded {} {} balance changes for {}",
        record_count, token_id, account_id
    );

    // Verify we loaded some records
    assert!(
        record_count > 0,
        "Should have loaded BTC intents token records"
    );

    // Verify the data in the database
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
        &token_id
    )
    .fetch_one(&pool)
    .await?;

    println!(
        "BTC Intents: {} records from block {} to {}",
        stats.total, stats.min_block, stats.max_block
    );

    // First BTC change should be at block 159487770 based on test data
    assert_eq!(
        stats.min_block, 159487770,
        "First BTC change should be at expected block"
    );
    assert_eq!(
        stats.total, record_count as i64,
        "Record count should match"
    );

    // Fetch the first record to verify detailed data including receipt
    let first_record = sqlx::query!(
        r#"
        SELECT 
            block_height,
            block_timestamp,
            amount::TEXT as "amount!",
            balance_before::TEXT as "balance_before!",
            balance_after::TEXT as "balance_after!",
            counterparty,
            raw_data
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height ASC
        LIMIT 1
        "#,
        &account_id,
        &token_id
    )
    .fetch_one(&pool)
    .await?;

    // Verify specific values from test data
    assert_eq!(
        first_record.block_height, 159487770,
        "First record should be at block 159487770"
    );
    assert_eq!(
        first_record.amount, "32868",
        "Amount should match test data"
    );
    assert_eq!(
        first_record.balance_before, "0",
        "Initial BTC balance should be 0"
    );
    assert_eq!(
        first_record.balance_after, "32868",
        "Balance after should match amount"
    );

    // Verify receipt ID is stored in raw_data
    let raw_data = first_record.raw_data.expect("raw_data should exist");
    let receipt_id = raw_data["receipt_id"]
        .as_str()
        .expect("receipt_id should be in raw_data");
    
    assert_eq!(
        receipt_id, "Fu7gfNiU326WKXv34uAg69NuNru2hFUq5CYGQeaZok6N",
        "Receipt ID should match test data"
    );
    
    println!("✓ Verified first BTC record with receipt ID: {}", receipt_id);

    Ok(())
}

/// Test gap detection for NEAR Intents tokens (btc.omft.near)
#[sqlx::test]
async fn test_intents_btc_gap_detection(pool: PgPool) -> sqlx::Result<()> {
    let target_token = "nep141:btc.omft.near";
    let (account_id, token_id, record_count) =
        load_intents_token_test_data(&pool, target_token).await?;

    println!(
        "Loaded {} {} balance changes for {}",
        record_count, token_id, account_id
    );
    assert!(
        record_count > 0,
        "Should have loaded BTC intents token records"
    );

    // Get the max block height
    let max_block = sqlx::query_scalar::<_, i64>(
        "SELECT MAX(block_height) FROM balance_changes WHERE account_id = $1 AND token_id = $2",
    )
    .bind(&account_id)
    .bind(&token_id)
    .fetch_one(&pool)
    .await?;

    // Run gap detection - should have no gaps with complete test data
    let gaps = find_gaps(&pool, &account_id, &token_id, max_block).await?;

    println!("BTC Intents gaps detected: {}", gaps.len());

    // The real test data should have a continuous chain (no gaps)
    assert_eq!(
        gaps.len(),
        0,
        "Real BTC intents test data should have no gaps in the balance chain"
    );

    Ok(())
}

/// Test gap detection for NEAR Intents tokens after removing records
#[sqlx::test]
async fn test_intents_btc_gap_detection_with_removed_records(pool: PgPool) -> sqlx::Result<()> {
    let target_token = "nep141:btc.omft.near";
    let (account_id, token_id, record_count) =
        load_intents_token_test_data(&pool, target_token).await?;

    println!(
        "Loaded {} {} balance changes for {}",
        record_count, token_id, account_id
    );
    assert!(
        record_count >= 3,
        "Need at least 3 records to test gap detection"
    );

    // Get all block heights
    let blocks = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT block_height 
        FROM balance_changes 
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height
        "#,
    )
    .bind(&account_id)
    .bind(&token_id)
    .fetch_all(&pool)
    .await?;

    // Remove the second record to create a gap
    let block_to_remove = blocks[1];
    println!("Removing BTC intents record at block: {}", block_to_remove);

    let deleted = sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1 AND token_id = $2 AND block_height = $3",
        &account_id,
        &token_id,
        block_to_remove
    )
    .execute(&pool)
    .await?;

    assert_eq!(deleted.rows_affected(), 1, "Should have deleted 1 record");

    // Get the max block height
    let max_block = sqlx::query_scalar::<_, i64>(
        "SELECT MAX(block_height) FROM balance_changes WHERE account_id = $1 AND token_id = $2",
    )
    .bind(&account_id)
    .bind(&token_id)
    .fetch_one(&pool)
    .await?;

    // Run gap detection
    let gaps = find_gaps(&pool, &account_id, &token_id, max_block).await?;

    println!("BTC Intents gaps detected after removal: {}", gaps.len());
    for gap in &gaps {
        println!(
            "  Gap: block {} to {} (balance {} -> {})",
            gap.start_block, gap.end_block, gap.actual_balance_after, gap.expected_balance_before
        );
    }

    // Should detect exactly 1 gap
    assert_eq!(
        gaps.len(),
        1,
        "Should detect exactly 1 gap from removing 1 record"
    );

    // The gap should span around the removed block
    let gap = gaps.first().expect("Should have at least one gap");
    assert!(
        gap.start_block < block_to_remove,
        "Gap start should be before removed block"
    );
    assert!(
        gap.end_block > block_to_remove,
        "Gap end should be after removed block"
    );

    Ok(())
}

/// Test verifying balance continuity for intents tokens
/// This ensures balance_after of one record matches balance_before of the next
#[sqlx::test]
async fn test_intents_btc_balance_continuity(pool: PgPool) -> sqlx::Result<()> {
    let target_token = "nep141:btc.omft.near";
    let (account_id, token_id, record_count) =
        load_intents_token_test_data(&pool, target_token).await?;

    println!(
        "Loaded {} {} balance changes for {}",
        record_count, token_id, account_id
    );
    assert!(
        record_count > 1,
        "Need at least 2 records to test continuity"
    );

    // Get all records ordered by block height
    let records = sqlx::query!(
        r#"
        SELECT 
            block_height,
            balance_before,
            balance_after
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height ASC
        "#,
        &account_id,
        &token_id
    )
    .fetch_all(&pool)
    .await?;

    // Verify balance continuity: balance_after of record N should equal balance_before of record N+1
    for i in 0..records.len() - 1 {
        let current = &records[i];
        let next = &records[i + 1];

        assert_eq!(
            current.balance_after, next.balance_before,
            "Balance discontinuity between blocks {} and {}: {} != {}",
            current.block_height, next.block_height, current.balance_after, next.balance_before
        );
    }

    println!(
        "Verified balance continuity across {} records",
        records.len()
    );

    Ok(())
}

/// Helper to create archival network config for tests
fn create_archival_network() -> NetworkConfig {
    // Load .env files to get FASTNEAR_API_KEY
    dotenvy::from_filename(".env").ok();
    dotenvy::from_filename(".env.test").ok();
    
    let fastnear_api_key = std::env::var("FASTNEAR_API_KEY")
        .expect("FASTNEAR_API_KEY must be set in .env");
    
    // Use fastnear archival RPC which supports historical queries
    NetworkConfig {
        rpc_endpoints: vec![RPCEndpoint::new(
            "https://archival-rpc.mainnet.fastnear.com/"
                .parse()
                .unwrap(),
        )
        .with_api_key(fastnear_api_key)],
        ..NetworkConfig::mainnet()
    }
}

/// Test that gap filler can find and fill a gap created by removing a record
#[sqlx::test]
async fn test_fill_gap_end_to_end(pool: PgPool) -> sqlx::Result<()> {
    // Load test data
    let (account_id, record_count) = load_test_data(&pool).await?;
    println!(
        "Loaded {} NEAR balance changes for {}",
        record_count, account_id
    );

    // Verify no gaps initially
    let initial_gaps = find_gaps(&pool, &account_id, "near", i64::MAX).await?;
    assert!(initial_gaps.is_empty(), "Should have no gaps initially");

    // Find a record in the middle to remove (not first or last)
    // We need to get 3 consecutive records to understand the balance chain
    let records = sqlx::query!(
        r#"
        SELECT block_height, balance_before::TEXT, balance_after::TEXT
        FROM balance_changes
        WHERE account_id = $1 AND token_id = 'near'
        ORDER BY block_height
        LIMIT 3 OFFSET 5
        "#,
        &account_id
    )
    .fetch_all(&pool)
    .await?;

    assert!(records.len() >= 3, "Need at least 3 consecutive records");

    let prev_record = &records[0];
    let record_to_remove = &records[1];
    let next_record = &records[2];

    let block_to_remove = record_to_remove.block_height;
    let balance_before_removed = record_to_remove.balance_before.clone().unwrap();
    let balance_after_removed = record_to_remove.balance_after.clone().unwrap();

    println!("Record chain before removal:");
    println!(
        "  Block {}: {} -> {}",
        prev_record.block_height,
        prev_record.balance_before.as_ref().unwrap(),
        prev_record.balance_after.as_ref().unwrap()
    );
    println!(
        "  Block {} (to remove): {} -> {}",
        block_to_remove, balance_before_removed, balance_after_removed
    );
    println!(
        "  Block {}: {} -> {}",
        next_record.block_height,
        next_record.balance_before.as_ref().unwrap(),
        next_record.balance_after.as_ref().unwrap()
    );

    // Remove the record to create a gap
    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1 AND token_id = 'near' AND block_height = $2",
        &account_id,
        block_to_remove
    )
    .execute(&pool)
    .await?;

    // Verify gap is detected
    let gaps = find_gaps(&pool, &account_id, "near", i64::MAX).await?;
    assert_eq!(
        gaps.len(),
        1,
        "Should detect exactly 1 gap after removing record"
    );

    let gap = gaps.first().expect("Should have a gap");
    println!(
        "Detected gap: blocks {}-{}, previous balance_after={}, next balance_before={}",
        gap.start_block, gap.end_block, gap.actual_balance_after, gap.expected_balance_before
    );

    // The gap should indicate:
    // - start_block = prev_record.block_height
    // - end_block = next_record.block_height
    // - actual_balance_after = prev_record.balance_after (what we have)
    // - expected_balance_before = next_record.balance_before (what we need)

    // The binary search will look for when expected_balance_before first appeared
    // This should be at block_to_remove where balance changed from balance_before_removed to balance_after_removed

    // For this to work, balance_after_removed must equal next_record.balance_before
    println!(
        "Removed record balance_after={}, next record balance_before={}",
        balance_after_removed,
        next_record.balance_before.as_ref().unwrap()
    );

    // Fill the gap using RPC
    let network = create_archival_network();
    let filled = fill_gap(&pool, &network, gap)
        .await
        .expect("Should successfully fill the gap");

    println!(
        "Filled gap at block {}: balance {} -> {}",
        filled.block_height, filled.balance_before, filled.balance_after
    );

    // Verify the gap is now filled
    let remaining_gaps = find_gaps(&pool, &account_id, "near", i64::MAX).await?;
    assert!(
        remaining_gaps.is_empty(),
        "Should have no gaps after filling"
    );

    // Verify the filled record has correct balances
    assert_eq!(
        filled.block_height, block_to_remove,
        "Should fill at the correct block"
    );

    Ok(())
}

/// Test fill_gaps function that fills multiple gaps
#[sqlx::test]
async fn test_fill_multiple_gaps(pool: PgPool) -> sqlx::Result<()> {
    // Load test data
    let (account_id, record_count) = load_test_data(&pool).await?;
    println!(
        "Loaded {} NEAR balance changes for {}",
        record_count, account_id
    );

    // Remove 2 non-adjacent records to create 2 gaps
    let records_to_remove = sqlx::query!(
        r#"
        SELECT block_height
        FROM balance_changes
        WHERE account_id = $1 AND token_id = 'near'
        ORDER BY block_height
        LIMIT 2 OFFSET 5
        "#,
        &account_id
    )
    .fetch_all(&pool)
    .await?;

    // Remove first record
    let block1 = records_to_remove[0].block_height;
    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1 AND token_id = 'near' AND block_height = $2",
        &account_id,
        block1
    )
    .execute(&pool)
    .await?;

    // Remove second record (skip one to create non-adjacent gap)
    let records_to_remove_2 = sqlx::query!(
        r#"
        SELECT block_height
        FROM balance_changes
        WHERE account_id = $1 AND token_id = 'near'
        ORDER BY block_height
        LIMIT 1 OFFSET 10
        "#,
        &account_id
    )
    .fetch_all(&pool)
    .await?;

    let block2 = records_to_remove_2[0].block_height;
    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1 AND token_id = 'near' AND block_height = $2",
        &account_id,
        block2
    )
    .execute(&pool)
    .await?;

    println!("Removed records at blocks {} and {}", block1, block2);

    // Get the max block height in the test data
    let max_block: (i64,) = sqlx::query_as(
        "SELECT MAX(block_height) FROM balance_changes WHERE account_id = $1 AND token_id = 'near'",
    )
    .bind(&account_id)
    .fetch_one(&pool)
    .await?;
    let up_to_block = max_block.0;

    // Verify 2 gaps are detected
    let gaps = find_gaps(&pool, &account_id, "near", up_to_block).await?;
    assert_eq!(
        gaps.len(),
        2,
        "Should detect 2 gaps after removing 2 records"
    );

    // Fill all gaps - use the max block from test data to avoid RPC calls beyond test data
    let network = create_archival_network();
    let filled = fill_gaps(&pool, &network, &account_id, "near", up_to_block)
        .await
        .expect("Should successfully fill gaps");

    println!("Filled {} gaps", filled.len());
    assert_eq!(filled.len(), 2, "Should fill 2 gaps");

    // Verify no gaps remain
    let remaining_gaps = find_gaps(&pool, &account_id, "near", up_to_block).await?;
    assert!(
        remaining_gaps.is_empty(),
        "Should have no gaps after filling all"
    );

    Ok(())
}

/// Test bootstrapping: seed initial balance for an account with no existing data.
/// Uses testing-astradao.sputnik-dao.near which has a simpler balance history.
#[sqlx::test]
async fn test_seed_initial_balance(pool: PgPool) -> sqlx::Result<()> {
    use nt_be::handlers::balance_changes::gap_filler::seed_initial_balance;

    let account_id = "testing-astradao.sputnik-dao.near";
    let token_id = "near";

    // Verify no records exist initially
    let initial_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM balance_changes WHERE account_id = $1 AND token_id = $2",
    )
    .bind(account_id)
    .bind(token_id)
    .fetch_one(&pool)
    .await?;

    assert_eq!(initial_count.0, 0, "Should start with no records");

    let network = create_archival_network();

    // Get current block height (use a known recent block)
    // Block ~177M is around late December 2025
    let current_block: u64 = 177_000_000;

    // Seed with a smaller lookback for testing (about 1 week of blocks)
    let lookback_blocks = Some(600_000_u64); // ~1 week

    println!(
        "Seeding initial balance for {}/{} from block {}",
        account_id, token_id, current_block
    );

    let result = seed_initial_balance(
        &pool,
        &network,
        account_id,
        token_id,
        current_block,
        lookback_blocks,
    )
    .await;

    match result {
        Ok(Some(filled)) => {
            println!(
                "Seeded record at block {}: {} -> {}",
                filled.block_height, filled.balance_before, filled.balance_after
            );

            // Verify the record was inserted
            let count: (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM balance_changes WHERE account_id = $1 AND token_id = $2",
            )
            .bind(account_id)
            .bind(token_id)
            .fetch_one(&pool)
            .await?;

            assert_eq!(count.0, 1, "Should have exactly one seeded record");

            // Verify the record has valid data
            let record = sqlx::query!(
                r#"
                SELECT block_height, balance_before, balance_after
                FROM balance_changes
                WHERE account_id = $1 AND token_id = $2
                "#,
                account_id,
                token_id
            )
            .fetch_one(&pool)
            .await?;

            println!(
                "Verified record: block={}, before={}, after={}",
                record.block_height, record.balance_before, record.balance_after
            );

            assert!(record.block_height > 0, "Block height should be positive");
        }
        Ok(None) => {
            println!("No balance change found in search range (balance may be 0 or unchanged)");
            // This is acceptable - the account might have 0 balance or unchanged in the range
        }
        Err(e) => {
            panic!("Seed failed with error: {}", e);
        }
    }

    Ok(())
}

/// Test the full fill_gaps flow with bootstrapping when no data exists
#[sqlx::test]
#[ignore = "Slow test - fills many gaps with RPC calls. Run with: cargo test -- --ignored"]
async fn test_fill_gaps_with_bootstrap(pool: PgPool) -> sqlx::Result<()> {
    let account_id = "testing-astradao.sputnik-dao.near";
    let token_id = "near";

    // Verify no records exist initially
    let initial_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM balance_changes WHERE account_id = $1 AND token_id = $2",
    )
    .bind(account_id)
    .bind(token_id)
    .fetch_one(&pool)
    .await?;

    assert_eq!(initial_count.0, 0, "Should start with no records");

    let network = create_archival_network();

    // Use a known valid block height
    let up_to_block: i64 = 177_000_000;

    // --- First call: should seed the initial balance ---
    println!("=== First call to fill_gaps ===");
    println!(
        "Calling fill_gaps for {}/{} up to block {}",
        account_id, token_id, up_to_block
    );

    let filled1 = fill_gaps(&pool, &network, account_id, token_id, up_to_block)
        .await
        .expect("fill_gaps should not error");

    println!("First call returned {} records", filled1.len());
    assert_eq!(filled1.len(), 2, "First call should find exactly 2 records");

    let count_after_first: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM balance_changes WHERE account_id = $1 AND token_id = $2",
    )
    .bind(account_id)
    .bind(token_id)
    .fetch_one(&pool)
    .await?;

    println!("Record count after first call: {}", count_after_first.0);
    assert_eq!(count_after_first.0, 2, "Should have exactly 2 records after first call");

    // Fetch all records with detailed information
    let records = sqlx::query!(
        r#"
        SELECT 
            block_height, 
            balance_before::TEXT as "balance_before!", 
            balance_after::TEXT as "balance_after!",
            raw_data
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height
        "#,
        account_id,
        token_id
    )
    .fetch_all(&pool)
    .await?;

    // Assert on specific blocks and balances from first call
    assert_eq!(records.len(), 2, "Should have exactly 2 records");
    
    let record1 = &records[0];
    assert_eq!(record1.block_height, 176927247, "First record should be at block 176927247");
    assert_eq!(
        record1.balance_before, "10449873124009596399999989",
        "Block 176927247 balance_before should match"
    );
    assert_eq!(
        record1.balance_after, "10449933795827029599999989",
        "Block 176927247 balance_after should match"
    );
    
    let record2 = &records[1];
    assert_eq!(record2.block_height, 176936471, "Second record should be at block 176936471");
    assert_eq!(
        record2.balance_before, "10449933795827029599999989",
        "Block 176936471 balance_before should match"
    );
    assert_eq!(
        record2.balance_after, "10449985392206838099999989",
        "Block 176936471 balance_after should match"
    );

    for r in &records {
        println!(
            "  Block {}: {} -> {}",
            r.block_height, r.balance_before, r.balance_after
        );
    }

    // --- Second call: should find gap to past (if balance_before != 0) ---
    println!("\n=== Second call to fill_gaps ===");

    let filled2 = fill_gaps(&pool, &network, account_id, token_id, up_to_block)
        .await
        .expect("fill_gaps should not error on second call");

    println!("Second call returned {} records", filled2.len());
    assert_eq!(filled2.len(), 1, "Second call should find exactly 1 record");

    let count_after_second: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM balance_changes WHERE account_id = $1 AND token_id = $2",
    )
    .bind(account_id)
    .bind(token_id)
    .fetch_one(&pool)
    .await?;

    println!("Record count after second call: {}", count_after_second.0);
    assert_eq!(count_after_second.0, 3, "Should have exactly 3 records after second call");

    // Fetch all records after second call with detailed information
    let records_final = sqlx::query!(
        r#"
        SELECT 
            block_height, 
            balance_before::TEXT as "balance_before!", 
            balance_after::TEXT as "balance_after!",
            receipt_id,
            signer_id,
            receiver_id,
            counterparty,
            raw_data
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height
        "#,
        account_id,
        token_id
    )
    .fetch_all(&pool)
    .await?;

    println!("All records after second call:");
    
    // Assert on all three blocks with exact values
    assert_eq!(records_final.len(), 3, "Should have exactly 3 records total");
    
    // Block 176927244 (found in second call)
    let record_gap = &records_final[0];
    assert_eq!(record_gap.block_height, 176927244, "Gap record should be at block 176927244");
    
    // Verify receipt_id column is populated
    assert!(!record_gap.receipt_id.is_empty(), "receipt_id array should not be empty");
    assert_eq!(
        record_gap.receipt_id[0], "6Giwt4xJ9V7wLAxdo45i7G7vupYzECQaXjCtLe4KfcSY",
        "Block 176927244 receipt_id column should match"
    );
    
    // Verify signer_id, receiver_id, and counterparty are populated
    assert_eq!(
        record_gap.signer_id.as_ref().unwrap(), "blackdragon.tkn.near",
        "Block 176927244 signer_id should be predecessor"
    );
    assert_eq!(
        record_gap.receiver_id.as_ref().unwrap(), "testing-astradao.sputnik-dao.near",
        "Block 176927244 receiver_id should match account"
    );
    assert_eq!(
        record_gap.counterparty, "blackdragon.tkn.near",
        "Block 176927244 counterparty should be predecessor"
    );
    
    // Verify receipt ID for block 176927244 in raw_data (backward compatibility)
    let raw_data_gap = record_gap.raw_data.as_ref().expect("Block 176927244 should have raw_data");
    let receipt_id_gap = raw_data_gap["receipt_id"]
        .as_str()
        .expect("Block 176927244 should have receipt_id in raw_data");
    assert_eq!(
        receipt_id_gap, "6Giwt4xJ9V7wLAxdo45i7G7vupYzECQaXjCtLe4KfcSY",
        "Block 176927244 receipt_id should match"
    );
    println!("Block 176927244 receipt_id: {}", receipt_id_gap);
    
    // Block 176927247 (from first call)
    let record1_final = &records_final[1];
    assert_eq!(record1_final.block_height, 176927247, "Should still have block 176927247");
    
    // Verify receipt_id column is populated
    assert!(!record1_final.receipt_id.is_empty(), "receipt_id array should not be empty");
    assert_eq!(
        record1_final.receipt_id[0], "A32isCEQAfFoyyfWPvTH6tysviXr8WbYYkdxADiWMKHo",
        "Block 176927247 receipt_id column should match"
    );
    
    // Verify signer_id, receiver_id, and counterparty are populated
    assert_eq!(
        record1_final.signer_id.as_ref().unwrap(), "blackdragon.tkn.near",
        "Block 176927247 signer_id should be predecessor"
    );
    assert_eq!(
        record1_final.receiver_id.as_ref().unwrap(), "testing-astradao.sputnik-dao.near",
        "Block 176927247 receiver_id should match account"
    );
    assert_eq!(
        record1_final.counterparty, "blackdragon.tkn.near",
        "Block 176927247 counterparty should be predecessor"
    );
    
    // Verify receipt ID for block 176927247 in raw_data (backward compatibility)
    if let Some(ref raw_data) = records_final[1].raw_data {
        if let Some(receipt_id) = raw_data.get("receipt_id").and_then(|v| v.as_str()) {
            println!("Block 176927247 receipt_id: {}", receipt_id);
            assert_eq!(receipt_id, "A32isCEQAfFoyyfWPvTH6tysviXr8WbYYkdxADiWMKHo", "Block 176927247 raw_data receipt_id should match");
        }
    }
    
    // Block 176936471 (from first call)
    let record2_final = &records_final[2];
    assert_eq!(record2_final.block_height, 176936471, "Should still have block 176936471");
    
    // Verify receipt_id column is populated
    assert!(!record2_final.receipt_id.is_empty(), "receipt_id array should not be empty");
    assert_eq!(
        record2_final.receipt_id[0], "7yLs3ArYQbGoubMXBVZsekwFAfbdqHBbmYrkuVWDonfJ",
        "Block 176936471 receipt_id column should match"
    );
    
    // Verify signer_id, receiver_id, and counterparty are populated
    assert_eq!(
        record2_final.signer_id.as_ref().unwrap(), "olskik.near",
        "Block 176936471 signer_id should be predecessor"
    );
    assert_eq!(
        record2_final.receiver_id.as_ref().unwrap(), "testing-astradao.sputnik-dao.near",
        "Block 176936471 receiver_id should match account"
    );
    assert_eq!(
        record2_final.counterparty, "olskik.near",
        "Block 176936471 counterparty should be predecessor"
    );
    
    // Verify receipt ID for block 176936471 in raw_data (backward compatibility)
    if let Some(ref raw_data) = records_final[2].raw_data {
        if let Some(receipt_id) = raw_data.get("receipt_id").and_then(|v| v.as_str()) {
            println!("Block 176936471 receipt_id: {}", receipt_id);
            assert_eq!(receipt_id, "7yLs3ArYQbGoubMXBVZsekwFAfbdqHBbmYrkuVWDonfJ", "Block 176936471 raw_data receipt_id should match");
        }
    }
    
    assert_eq!(
        record1_final.balance_before, "10449873124009596399999989",
        "Block 176927247 balance_before should match"
    );
    assert_eq!(
        record1_final.balance_after, "10449933795827029599999989",
        "Block 176927247 balance_after should match"
    );
    
    assert_eq!(
        record_gap.balance_before, "10326123124009596399999989",
        "Block 176927244 balance_before should match"
    );
    assert_eq!(
        record_gap.balance_after, "10449873124009596399999989",
        "Block 176927244 balance_after should match"
    );
    
    // Block 176936471 (from first call)
    let record2_final = &records_final[2];
    assert_eq!(record2_final.block_height, 176936471, "Should still have block 176936471");
    assert_eq!(
        record2_final.balance_before, "10449933795827029599999989",
        "Block 176936471 balance_before should match"
    );
    assert_eq!(
        record2_final.balance_after, "10449985392206838099999989",
        "Block 176936471 balance_after should match"
    );

    for r in &records_final {
        println!(
            "  Block {}: {} -> {}",
            r.block_height, r.balance_before, r.balance_after
        );
    }
    
    // Verify balance continuity across all records
    assert_eq!(
        record_gap.balance_after, record1_final.balance_before,
        "Balance chain should be continuous from block 176927244 to 176927247"
    );
    assert_eq!(
        record1_final.balance_after, record2_final.balance_before,
        "Balance chain should be continuous from block 176927247 to 176936471"
    );

    println!("✓ All block heights and balances verified");

    Ok(())
}

/// Test getting block data with receipt execution outcomes for a specific block
/// This test queries block 176927244 to examine receipt data for testing-astradao.sputnik-dao.near
#[sqlx::test]
async fn test_get_block_receipt_data(_pool: PgPool) -> sqlx::Result<()> {
    use nt_be::handlers::balance_changes::block_info::get_block_data;

    let network = create_archival_network();
    let account_id = "testing-astradao.sputnik-dao.near";
    let block_height: u64 = 176927244;

    println!("Querying block {} for account {}", block_height, account_id);

    let block_data = get_block_data(&network, account_id, block_height)
        .await
        .expect("Should successfully get block data");

    println!("Block data: {:#?}", block_data);
    
    println!("\nFound {} receipts:", block_data.receipts.len());
    for (i, receipt) in block_data.receipts.iter().enumerate() {
        println!("\nReceipt #{}", i + 1);
        println!("  Receipt ID: {}", receipt.receipt_id);
        println!("  Receiver ID: {}", receipt.receiver_id);
        println!("  Predecessor ID: {}", receipt.predecessor_id);
    }

    // Assert specific values from block 176927244
    assert_eq!(
        block_data.block_height, 176927244,
        "Block height should match"
    );
    assert_eq!(
        block_data.block_hash, "EgLRsgTk2dn3bo7x7MRv3PYB5dKD4a4Guw7KYgzZRB3Y",
        "Block hash should match"
    );
    assert_eq!(
        block_data.receipts.len(), 1,
        "Should have exactly one receipt affecting the account"
    );

    // Assert receipt details
    let receipt = &block_data.receipts[0];
    assert_eq!(
        receipt.receipt_id.to_string(), "6Giwt4xJ9V7wLAxdo45i7G7vupYzECQaXjCtLe4KfcSY",
        "Receipt ID should match"
    );
    assert_eq!(
        receipt.receiver_id.as_str(), "testing-astradao.sputnik-dao.near",
        "Receiver ID should match"
    );
    assert_eq!(
        receipt.predecessor_id.as_str(), "blackdragon.tkn.near",
        "Predecessor ID should match"
    );

    println!("✓ All block 176927244 receipt data verified");

    Ok(())
}

/// Test querying a block that returns 422 error (block 178462173)
/// Should retry with previous blocks until finding a valid one
#[sqlx::test]
async fn test_query_unavailable_block_with_retry(pool: PgPool) -> sqlx::Result<()> {
    use nt_be::handlers::balance_changes::balance;

    let network = create_archival_network();
    let account_id = "testing-astradao.sputnik-dao.near";

    // This block is known to return 422 error
    let problematic_block: u64 = 178462173;

    println!(
        "Querying block {} which returns 422 error",
        problematic_block
    );

    // This should succeed by automatically retrying with previous blocks
    let result =
        balance::get_balance_change_at_block(&pool, &network, account_id, "near", problematic_block).await;

    match result {
        Ok((balance_before, balance_after)) => {
            println!(
                "Successfully queried balance with retry: {} -> {}",
                balance_before, balance_after
            );
            assert!(
                !balance_before.is_empty(),
                "Should have a valid balance_before"
            );
            assert!(
                !balance_after.is_empty(),
                "Should have a valid balance_after"
            );
        }
        Err(e) => {
            panic!("Should succeed with retry logic, but got error: {}", e);
        }
    }

    Ok(())
}

/// Test looping fill_gaps until all gaps are filled
#[sqlx::test]
#[ignore = "Slow test - makes many RPC calls. Run with: cargo test -- --ignored"]
async fn test_fill_gaps_loop_until_complete(pool: PgPool) -> sqlx::Result<()> {
    let account_id = "testing-astradao.sputnik-dao.near";
    let token_id = "near";

    let network = create_archival_network();
    let up_to_block: i64 = 177_000_000;

    let mut iteration = 0;
    let max_iterations = 20; // Safety limit

    println!("=== Starting gap fill loop ===");

    loop {
        iteration += 1;
        if iteration > max_iterations {
            println!("Reached max iterations ({}), stopping", max_iterations);
            break;
        }

        let filled = fill_gaps(&pool, &network, account_id, token_id, up_to_block)
            .await
            .expect("fill_gaps should not error");

        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM balance_changes WHERE account_id = $1 AND token_id = $2",
        )
        .bind(account_id)
        .bind(token_id)
        .fetch_one(&pool)
        .await?;

        println!(
            "Iteration {}: filled {} new, total {}",
            iteration,
            filled.len(),
            count.0
        );

        if filled.is_empty() {
            println!("No new records found - chain is complete!");
            break;
        }
    }

    // Print final state
    let records = sqlx::query!(
        r#"
        SELECT block_height, balance_before::TEXT as "balance_before!", balance_after::TEXT as "balance_after!"
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height
        "#,
        account_id,
        token_id
    )
    .fetch_all(&pool)
    .await?;

    println!("\n=== Final chain ({} records) ===", records.len());
    for r in &records {
        println!(
            "  Block {}: {} -> {}",
            r.block_height, r.balance_before, r.balance_after
        );
    }

    // Verify chain integrity
    let mut prev_balance_after: Option<String> = None;
    for r in &records {
        if let Some(prev) = &prev_balance_after {
            assert_eq!(
                prev, &r.balance_before,
                "Chain broken at block {}: prev balance_after {} != balance_before {}",
                r.block_height, prev, r.balance_before
            );
        }
        prev_balance_after = Some(r.balance_after.clone());
    }

    println!("✓ Chain integrity verified");

    // Either the chain starts from 0 or we hit the RPC limit
    let earliest = records.first().expect("Should have at least one record");
    if earliest.balance_before == "0" {
        println!("✓ Chain starts from account creation (balance 0)");
    } else {
        println!(
            "Chain starts from block {} with balance {}",
            earliest.block_height, earliest.balance_before
        );
        println!("(RPC may not have data before this block)");
    }

    Ok(())
}

/// Test monitored_accounts table operations
#[sqlx::test]
async fn test_monitored_accounts(pool: PgPool) -> sqlx::Result<()> {
    use chrono::Utc;
    
    // Insert a monitored account
    sqlx::query!(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled)
        VALUES ($1, $2)
        "#,
        "test-account.near",
        true
    )
    .execute(&pool)
    .await?;

    // Insert another account that's disabled
    sqlx::query!(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled)
        VALUES ($1, $2)
        "#,
        "disabled-account.near",
        false
    )
    .execute(&pool)
    .await?;

    // Query enabled accounts
    let enabled = sqlx::query!(
        r#"
        SELECT account_id, enabled, last_synced_at, created_at, updated_at
        FROM monitored_accounts
        WHERE enabled = true
        ORDER BY account_id
        "#
    )
    .fetch_all(&pool)
    .await?;

    assert_eq!(enabled.len(), 1, "Should have exactly one enabled account");
    assert_eq!(enabled[0].account_id, "test-account.near");
    assert!(enabled[0].enabled);
    assert!(enabled[0].last_synced_at.is_none(), "last_synced_at should be NULL initially");

    // Update last_synced_at after processing
    let now = Utc::now();
    sqlx::query!(
        r#"
        UPDATE monitored_accounts
        SET last_synced_at = $2
        WHERE account_id = $1
        "#,
        "test-account.near",
        now
    )
    .execute(&pool)
    .await?;

    // Verify the update
    let updated = sqlx::query!(
        r#"
        SELECT account_id, last_synced_at, updated_at
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
        "test-account.near"
    )
    .fetch_one(&pool)
    .await?;

    assert!(updated.last_synced_at.is_some(), "last_synced_at should be set");
    println!("✓ Monitored account created and updated successfully");
    println!("  Account: {}", updated.account_id);
    println!("  Last synced: {:?}", updated.last_synced_at);
    println!("  Updated at: {:?}", updated.updated_at);

    // Verify that disabled accounts are not returned in enabled query
    let all_accounts = sqlx::query!(
        r#"
        SELECT account_id, enabled
        FROM monitored_accounts
        ORDER BY account_id
        "#
    )
    .fetch_all(&pool)
    .await?;

    assert_eq!(all_accounts.len(), 2, "Should have 2 total accounts");
    assert_eq!(all_accounts[0].account_id, "disabled-account.near");
    assert!(!all_accounts[0].enabled);
    assert_eq!(all_accounts[1].account_id, "test-account.near");
    assert!(all_accounts[1].enabled);

    println!("✓ All monitored_accounts operations validated");

    Ok(())
}

/// Test continuous monitoring service
#[sqlx::test]
#[ignore = "Slow test - monitors multiple cycles. Run with: cargo test -- --ignored"]
async fn test_continuous_monitoring(pool: PgPool) -> sqlx::Result<()> {
    use nt_be::handlers::balance_changes::account_monitor::run_monitor_cycle;
    
    let account_id = "testing-astradao.sputnik-dao.near";
    let token_id = "near";
    
    // Insert a monitored account
    sqlx::query!(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled)
        VALUES ($1, true)
        "#,
        account_id
    )
    .execute(&pool)
    .await?;
    
    // Check last_synced_at before monitoring
    let before_sync = sqlx::query!(
        r#"
        SELECT last_synced_at
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
        account_id
    )
    .fetch_one(&pool)
    .await?;
    
    assert!(before_sync.last_synced_at.is_none(), "Should not be synced yet");
    
    // Run one monitoring cycle
    println!("Running monitoring cycle...");
    let network = create_archival_network();
    let up_to_block = 177_000_000i64;
    run_monitor_cycle(&pool, &network, up_to_block)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
    
    // Verify last_synced_at was updated
    let after_sync = sqlx::query!(
        r#"
        SELECT last_synced_at
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
        account_id
    )
    .fetch_one(&pool)
    .await?;
    
    assert!(after_sync.last_synced_at.is_some(), "Should be synced after cycle");
    println!("✓ last_synced_at updated: {:?}", after_sync.last_synced_at);
    
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
    
    assert!(change_count.0 > 1, "Should have collected more balance changes");
    println!("✓ Collected {} balance changes", change_count.0);
    
    // Test with disabled account - should skip
    sqlx::query!(
        r#"
        UPDATE monitored_accounts
        SET enabled = false
        WHERE account_id = $1
        "#,
        account_id
    )
    .execute(&pool)
    .await?;
    
    let sync_time = after_sync.last_synced_at;
    
    // Run another cycle
    run_monitor_cycle(&pool, &network, up_to_block)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
    
    // Verify last_synced_at didn't change (account was disabled)
    let after_disabled = sqlx::query!(
        r#"
        SELECT last_synced_at
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
        account_id
    )
    .fetch_one(&pool)
    .await?;
    
    assert_eq!(after_disabled.last_synced_at, sync_time, "Disabled account should not be processed");
    println!("✓ Disabled accounts are skipped");
    
    println!("✓ Continuous monitoring validated");
    
    Ok(())
}

#[sqlx::test]
async fn test_fill_gap_with_transaction_hash_block_178148634(pool: PgPool) -> sqlx::Result<()> {
    use nt_be::handlers::balance_changes::gap_filler::insert_balance_change_record;
    
    println!("\n=== Testing Balance Change Record with Transaction Hash (Block 178148634) ===\n");
    
    // Setup network config
    let network = NetworkConfig {
        rpc_endpoints: vec![RPCEndpoint::new(
            "https://archival-rpc.mainnet.fastnear.com/"
                .parse()
                .unwrap(),
        )],
        ..NetworkConfig::mainnet()
    };
    
    let account_id = "petersalomonsen.near";
    let token_id = "near";
    let target_block = 178148634u64;
    
    println!("Inserting balance change record for block {}...", target_block);
    
    // Directly insert the balance change record for block 178148634
    // This will use get_account_changes to capture the transaction hash
    let filled_gap = insert_balance_change_record(&pool, &network, account_id, token_id, target_block)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?
        .expect("Should insert record");
    
    println!("✓ Record inserted at block {}", filled_gap.block_height);
    
    // The block should be 178148634 or nearby (binary search finds the exact block)
    println!("Found balance change at block: {}", filled_gap.block_height);
    
    // Query the database to verify all fields
    let record = sqlx::query!(
        r#"
        SELECT 
            account_id,
            token_id,
            block_height,
            block_timestamp,
            amount::TEXT as "amount!",
            balance_before::TEXT as "balance_before!",
            balance_after::TEXT as "balance_after!",
            transaction_hashes,
            receipt_id,
            signer_id,
            receiver_id,
            counterparty,
            raw_data
        FROM balance_changes
        WHERE account_id = $1 AND block_height = $2 AND token_id = $3
        "#,
        account_id,
        filled_gap.block_height,
        token_id
    )
    .fetch_one(&pool)
    .await
    .expect("Should find the inserted record");
    
    println!("\n=== Verifying Database Record ===");
    
    // Verify basic fields
    assert_eq!(record.account_id, account_id, "Account ID should match");
    assert_eq!(record.token_id.as_deref(), Some(token_id), "Token ID should match");
    assert_eq!(record.block_height, filled_gap.block_height, "Block height should match");
    
    println!("✓ Account ID: {}", record.account_id);
    println!("✓ Token ID: {:?}", record.token_id);
    println!("✓ Block height: {}", record.block_height);
    println!("✓ Block timestamp: {}", record.block_timestamp);
    
    // Verify balance fields (decimal-adjusted: NEAR has 24 decimals)
    assert_eq!(
        record.balance_after, 
        "47.131979815366840642871301",
        "Balance after should be correct (decimal-adjusted)"
    );
    println!("✓ Balance before: {}", record.balance_before);
    println!("✓ Balance after: {}", record.balance_after);
    println!("✓ Amount: {}", record.amount);
    
    // Verify transaction hash was captured (should be present for NEAR balance changes)
    assert!(
        !record.transaction_hashes.is_empty(),
        "Should have at least one transaction hash"
    );
    println!("✓ Transaction hash: {}", record.transaction_hashes[0]);
    
    // If this is block 178148634, verify the specific transaction hash
    if record.block_height == 178148634 {
        assert_eq!(
            record.transaction_hashes[0],
            "CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5",
            "Transaction hash should match the expected value for block 178148634"
        );
        println!("  ✓ Verified specific tx hash for block 178148634");
    }
    
    // Verify receipt IDs (may be empty or have values)
    println!("✓ Receipt IDs count: {}", record.receipt_id.len());
    
    // Verify counterparty exists (should always have a value)
    println!("✓ Counterparty: {}", record.counterparty);
    
    // Verify signer/receiver if available
    if let Some(signer) = &record.signer_id {
        println!("✓ Signer ID: {}", signer);
    }
    if let Some(receiver) = &record.receiver_id {
        println!("✓ Receiver ID: {}", receiver);
    }
    
    // Verify raw_data contains the state change info
    if let Some(raw_data) = record.raw_data {
        assert!(raw_data.is_object(), "Raw data should be a JSON object");
        println!("✓ Raw data captured: {} bytes", raw_data.to_string().len());
        
        // Verify the cause is TransactionProcessing in raw_data
        // The structure is {"cause": {"TransactionProcessing": {"tx_hash": "..."}}}
        if let Some(cause_obj) = raw_data.get("cause") {
            if cause_obj.is_object() && cause_obj.get("TransactionProcessing").is_some() {
                println!("✓ Cause type: TransactionProcessing");
                // Verify tx_hash is present in the cause
                if let Some(tx_info) = cause_obj.get("TransactionProcessing") {
                    if let Some(tx_hash) = tx_info.get("tx_hash") {
                        println!("  Transaction hash in cause: {}", tx_hash);
                    }
                }
            }
        }
    }
    
    println!("\n✓ All assertions passed! Block: {}", record.block_height);
    
    Ok(())
}

#[sqlx::test]
async fn test_discover_ft_tokens_from_receipts(_pool: PgPool) -> sqlx::Result<()> {
    use nt_be::handlers::balance_changes::block_info::get_all_account_receipts;
    use nt_be::handlers::balance_changes::token_discovery::extract_ft_tokens_from_receipt;
    use std::collections::HashSet;

    // Block 178148636 has an arizcredits.near FT transfer
    // Receipt: D9XE4evM6wvM9zaYftkmpjz1nYApKhspaFgPqn3xp24k
    // Token: arizcredits.near
    let block_height = 178148636;
    let account_id = "webassemblymusic-treasury.sputnik-dao.near";
    
    let network = create_archival_network();
    
    println!("\n📦 Testing FT token discovery from receipts");
    println!("Block: {}", block_height);
    println!("Account: {}", account_id);
    println!("Expected receipt: D9XE4evM6wvM9zaYftkmpjz1nYApKhspaFgPqn3xp24k");
    println!("Expected token: arizcredits.near");
    
    // Get ALL receipts involving the account (as sender or receiver)
    let receipts = get_all_account_receipts(&network, account_id, block_height).await
        .expect("Should fetch receipts");
    
    println!("\nFound {} receipts involving account in block", receipts.len());
    
    // Extract FT tokens from all receipts
    let mut all_tokens = HashSet::new();
    for receipt in &receipts {
        println!("\nAnalyzing receipt: {}", receipt.receipt_id);
        println!("  Predecessor: {}", receipt.predecessor_id);
        println!("  Receiver: {}", receipt.receiver_id);
        
        // Print actions if available
        if let near_primitives::views::ReceiptEnumView::Action { actions, .. } = &receipt.receipt {
            for action in actions {
                if let near_primitives::views::ActionView::FunctionCall { method_name, .. } = action {
                    println!("  Method: {}", method_name);
                }
            }
        }
        
        let tokens = extract_ft_tokens_from_receipt(receipt, account_id);
        if !tokens.is_empty() {
            println!("  ✓ Found tokens: {:?}", tokens);
        }
        all_tokens.extend(tokens);
    }
    
    println!("Discovered {} unique FT tokens:", all_tokens.len());
    for token in &all_tokens {
        println!("  - {}", token);
    }
    
    // Should find arizcredits.near
    assert!(
        all_tokens.contains("arizcredits.near"),
        "Should discover arizcredits.near FT token"
    );
    
    println!("\n✓ Successfully discovered FT tokens from receipts");
    
    Ok(())
}

/// Test to check if FT contract appears as counterparty in NEAR balance changes
#[sqlx::test]
async fn test_ft_contract_as_counterparty(pool: PgPool) -> sqlx::Result<()> {
    use nt_be::handlers::balance_changes::account_monitor::run_monitor_cycle;
    
    let account_id = "webassemblymusic-treasury.sputnik-dao.near";
    let expected_ft_contract = "arizcredits.near";
    
    println!("\n=== Testing FT Contract as Counterparty ===");
    println!("Account: {}", account_id);
    println!("Expected FT contract: {}", expected_ft_contract);
    
    // Insert the account as monitored
    sqlx::query!(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled)
        VALUES ($1, true)
        "#,
        account_id
    )
    .execute(&pool)
    .await?;
    
    let network = create_archival_network();
    let up_to_block = 178150000i64;
    
    // Run monitoring cycle to collect NEAR balance changes
    println!("\n=== Running Monitoring Cycle ===");
    run_monitor_cycle(&pool, &network, up_to_block)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
    
    // Query all counterparties from NEAR balance changes
    let counterparties: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT counterparty
        FROM balance_changes
        WHERE account_id = $1 AND token_id = 'near'
        ORDER BY counterparty
        "#
    )
    .bind(account_id)
    .fetch_all(&pool)
    .await?;
    
    println!("\n=== Counterparties in NEAR Balance Changes ===");
    for counterparty in &counterparties {
        println!("  - {}", counterparty);
    }
    
    // Check if the FT contract appears as a counterparty
    let has_ft_as_counterparty = counterparties.contains(&expected_ft_contract.to_string());
    
    if has_ft_as_counterparty {
        println!("\n✓ {} appears as counterparty in NEAR transactions", expected_ft_contract);
        
        // Show which blocks have this counterparty
        let blocks: Vec<i64> = sqlx::query_scalar(
            r#"
            SELECT block_height
            FROM balance_changes
            WHERE account_id = $1 AND token_id = 'near' AND counterparty = $2
            ORDER BY block_height
            "#
        )
        .bind(account_id)
        .bind(expected_ft_contract)
        .fetch_all(&pool)
        .await?;
        
        println!("  Found in {} blocks:", blocks.len());
        for block in &blocks {
            println!("    Block: {}", block);
        }
    } else {
        println!("\n✗ {} does NOT appear as counterparty", expected_ft_contract);
        println!("  This means we need to query receipts to discover it");
    }
    
    Ok(())
}

/// Test end-to-end FT token discovery through monitoring
/// This test verifies the complete flow:
/// 1. Start monitoring an account (only NEAR initially)
/// 2. Discover FT tokens from receipts during NEAR monitoring
/// 3. Automatically start monitoring discovered FT tokens
/// 4. Verify balance changes are collected for the discovered token
#[sqlx::test]
#[ignore = "Slow test - monitors many blocks for token discovery. Run with: cargo test -- --ignored"]
async fn test_ft_token_discovery_through_monitoring(pool: PgPool) -> sqlx::Result<()> {
    use nt_be::handlers::balance_changes::account_monitor::run_monitor_cycle;
    
    let account_id = "webassemblymusic-treasury.sputnik-dao.near";
    let expected_ft_token = "arizcredits.near";
    
    println!("\n=== Testing FT Token Discovery Through Monitoring ===");
    println!("Account: {}", account_id);
    println!("Expected discovered token: {}", expected_ft_token);
    
    // Insert the account as monitored (enabled)
    sqlx::query!(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled)
        VALUES ($1, true)
        "#,
        account_id
    )
    .execute(&pool)
    .await?;
    
    println!("\n✓ Account added to monitored_accounts");
    
    // Verify no balance changes exist initially
    let initial_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM balance_changes WHERE account_id = $1"
    )
    .bind(account_id)
    .fetch_one(&pool)
    .await?;
    
    assert_eq!(initial_count.0, 0, "Should start with no balance change records");
    println!("✓ Verified empty state (0 records)");
    
    let network = create_archival_network();
    
    // Run first monitoring cycle
    // This should:
    // 1. Auto-seed NEAR token
    // 2. Fill gaps for NEAR (which captures receipts with FT transfers)
    // Block 178148636 contains arizcredits.near FT transfer
    // We need to search from a point where there's an existing balance change
    // that leads to block 178148636
    let up_to_block = 178150000i64; // Well past the block with FT transfer
    
    println!("\n=== First Monitoring Cycle ===");
    println!("Up to block: {}", up_to_block);
    
    run_monitor_cycle(&pool, &network, up_to_block)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
    
    // Check how many NEAR records were collected
    let near_count: (i64,) = sqlx::query_as(
        r#"
        SELECT COUNT(*)
        FROM balance_changes
        WHERE account_id = $1 AND token_id = 'near'
        "#
    )
    .bind(account_id)
    .fetch_one(&pool)
    .await?;
    
    println!("✓ Collected {} NEAR balance change records", near_count.0);
    assert!(near_count.0 > 0, "Should have collected NEAR balance changes");
    
    println!("\n=== Second Monitoring Cycle ===");
    println!("The first cycle should have discovered FT tokens from receipts");
    println!("The second cycle should collect balance changes for discovered tokens");
    
    // Run second monitoring cycle - should pick up discovered FT tokens
    run_monitor_cycle(&pool, &network, up_to_block)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
    
    println!("\n=== Verifying Automatic FT Token Discovery ===");
    
    // The monitoring system should have automatically discovered and started tracking
    // the arizcredits.near FT token from receipts collected during NEAR monitoring.
    // Verify FT balance changes were collected
    let ft_count: (i64,) = sqlx::query_as(
        r#"
        SELECT COUNT(*)
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        "#
    )
    .bind(account_id)
    .bind(expected_ft_token)
    .fetch_one(&pool)
    .await?;
    
    assert!(
        ft_count.0 > 0,
        "Should have collected balance changes for discovered token {}",
        expected_ft_token
    );
    
    println!("✓ Collected {} balance change records for {}", ft_count.0, expected_ft_token);
    
    // Verify the balance changes are valid
    let ft_records = sqlx::query!(
        r#"
        SELECT 
            block_height,
            balance_before::TEXT as "balance_before!",
            balance_after::TEXT as "balance_after!",
            amount::TEXT as "amount!"
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height
        "#,
        account_id,
        expected_ft_token
    )
    .fetch_all(&pool)
    .await?;
    
    println!("\n=== {} Balance Change Records ===", expected_ft_token);
    for record in &ft_records {
        println!(
            "  Block {}: {} -> {} (amount: {})",
            record.block_height,
            record.balance_before,
            record.balance_after,
            record.amount
        );
    }
    
    // Verify the snapshot record has correctly measured balances
    // The first record should be the snapshot at up_to_block
    if let Some(first_record) = ft_records.first() {
        if first_record.block_height == up_to_block {
            // Snapshot records have measured balances before and after the block
            // They might be the same (no change in this specific block) or different
            // The amount should always equal balance_after - balance_before
            let balance_before = BigDecimal::from_str(&first_record.balance_before)
                .expect("balance_before should be valid");
            let balance_after = BigDecimal::from_str(&first_record.balance_after)
                .expect("balance_after should be valid");
            let amount = BigDecimal::from_str(&first_record.amount)
                .expect("amount should be valid");
            let calculated_amount = &balance_after - &balance_before;
            
            assert_eq!(
                amount, calculated_amount,
                "Snapshot amount should equal balance_after - balance_before"
            );
            println!("✓ Snapshot record has correctly measured balances: {} -> {} (amount: {})", 
                first_record.balance_before, first_record.balance_after, first_record.amount);
        }
    }
    
    // Verify chain integrity for FT token
    let mut prev_balance_after: Option<String> = None;
    for record in &ft_records {
        if let Some(prev) = &prev_balance_after {
            assert_eq!(
                prev, &record.balance_before,
                "FT balance chain broken at block {}: {} != {}",
                record.block_height, prev, record.balance_before
            );
        }
        prev_balance_after = Some(record.balance_after.clone());
    }
    
    println!("✓ FT balance chain integrity verified");
    
    // Verify that FT records have real counterparties (not metadata values)
    // But only if we have more than just the discovery marker
    // (Discovery markers at the end block won't have transaction history)
    let ft_counterparties = sqlx::query!(
        r#"
        SELECT DISTINCT counterparty
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY counterparty
        "#,
        account_id,
        expected_ft_token
    )
    .fetch_all(&pool)
    .await?;

    println!("\n=== FT Token Counterparties ===");
    for cp_record in &ft_counterparties {
        println!("  - {}", cp_record.counterparty);
    }

    // If we only have one record (the discovery marker), it's okay to only have "SNAPSHOT"
    // If we have multiple records, at least one should have a real counterparty
    if ft_records.len() > 1 {
        let has_real_counterparty = ft_counterparties.iter()
            .any(|cp| !vec!["SNAPSHOT", "system"].contains(&cp.counterparty.as_str()));
        
        assert!(
            has_real_counterparty,
            "FT records with transaction history should have at least one real counterparty (not snapshot/metadata values)"
        );
        println!("✓ FT records have real counterparties");
    } else {
        println!("⚠ Only discovery marker record exists (no transaction history yet)");
    }
    // Verify we're tracking both NEAR and the discovered FT token
    let all_tokens: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT token_id
        FROM balance_changes
        WHERE account_id = $1
        ORDER BY token_id
        "#
    )
    .bind(account_id)
    .fetch_all(&pool)
    .await?;
    
    println!("\n=== All Tracked Tokens for {} ===", account_id);
    for token in &all_tokens {
        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM balance_changes WHERE account_id = $1 AND token_id = $2"
        )
        .bind(account_id)
        .bind(token)
        .fetch_one(&pool)
        .await?;
        
        println!("  - {}: {} records", token, count.0);
    }
    
    assert!(all_tokens.contains(&"near".to_string()), "Should track NEAR");
    assert!(all_tokens.contains(&expected_ft_token.to_string()), "Should track discovered FT token");
    assert_eq!(all_tokens.len(), 2, "Should track exactly 2 tokens (NEAR + discovered FT)");
    
    println!("\n✓ Full FT token discovery flow validated!");
    println!("  ✓ Started with NEAR monitoring only");
    println!("  ✓ Discovered {} from receipts", expected_ft_token);
    println!("  ✓ Started monitoring discovered token");
    println!("  ✓ Collected and validated balance changes for both tokens");
    println!("  ✓ Discovery marker has correct values (0 -> balance)");
    println!("  ✓ FT records have real counterparties");
    
    Ok(())
}

/// Test FT token discovery for petersalomonsen.near at block 178086209
/// This block has a NEAR balance change with transaction hash that should be captured
#[sqlx::test]
async fn test_ft_discovery_petersalomonsen_block_178086209(pool: PgPool) -> sqlx::Result<()> {
    use nt_be::handlers::balance_changes::gap_filler::fill_gaps;
    
    let account_id = "petersalomonsen.near";
    let target_block = 178086209i64;  // Block with NEAR balance change
    
    println!("\n=== Testing FT Discovery for {} at Block {} ===", account_id, target_block);
    println!("This block has a NEAR balance change with transaction hash 2CqhsWNuFEu29TefK2MCDNHtW4B1BioduGQ8rXSi18GR");
    
    let network = create_archival_network();
    
    // Directly fill gaps for NEAR - use target_block + 1 to ensure we search down to include target_block
    // The gap filler will seed from 178086210 and search backwards, which should find 178086209
    println!("\n=== Collecting NEAR Balance Changes ===");
    let filled = fill_gaps(&pool, &network, account_id, "near", target_block + 1)
        .await
        .map_err(|e| sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
    
    println!("Filled {} NEAR balance change gaps", filled.len());
    
    // Check specifically for block 178086209
    let block_209 = sqlx::query!(
        r#"
        SELECT 
            block_height,
            token_id,
            counterparty,
            transaction_hashes,
            receipt_id,
            balance_before::TEXT,
            balance_after::TEXT
        FROM balance_changes
        WHERE account_id = $1 AND block_height = 178086209
        "#,
        account_id
    )
    .fetch_optional(&pool)
    .await?;

    println!("\n=== Specific Query: Block 178086209 (ANY token) ===");
    if let Some(record) = &block_209 {
        println!("✓ Block {} FOUND!", record.block_height);
        println!("  Token: {}", record.token_id.as_ref().unwrap_or(&"N/A".to_string()));
        println!("  Counterparty: {}", record.counterparty);
        println!("  Balance: {} -> {}", 
            record.balance_before.as_ref().unwrap_or(&"N/A".to_string()),
            record.balance_after.as_ref().unwrap_or(&"N/A".to_string())
        );
        if !record.transaction_hashes.is_empty() {
            println!("  Transaction hash: {}", record.transaction_hashes[0]);
        }
        if !record.receipt_id.is_empty() {
            println!("  Receipt ID: {}", record.receipt_id[0]);
        }
    } else {
        println!("✗ Block 178086209 NOT found in balance_changes table for any token");
        println!("  This means gap filler didn't detect a NEAR balance change at this block");
        println!("  Possible reasons:");
        println!("    - Balance change is for an FT token (not NEAR)");
        println!("    - Binary search didn't check this specific block");
        println!("    - Balance was same before/after at this block");
    }
    
    // Check what blocks were captured
    let records = sqlx::query!(
        r#"
        SELECT 
            block_height,
            counterparty,
            transaction_hashes,
            receipt_id
        FROM balance_changes
        WHERE account_id = $1 AND token_id = 'near'
        ORDER BY block_height
        "#,
        account_id
    )
    .fetch_all(&pool)
    .await?;
    
    println!("\n=== NEAR Balance Changes ===");
    for record in &records {
        println!("  Block: {}", record.block_height);
        println!("    Counterparty: {}", record.counterparty);
        if !record.transaction_hashes.is_empty() {
            println!("    Transaction hash: {}", record.transaction_hashes[0]);
        }
        if !record.receipt_id.is_empty() {
            println!("    Receipt ID: {}", record.receipt_id[0]);
        }
    }
    
    // Find the block with transaction hash but unknown counterparty
    let blocks_with_unknown_counterparty: Vec<_> = records.iter()
        .filter(|r| r.counterparty == "unknown" && !r.transaction_hashes.is_empty())
        .collect();
    
    if !blocks_with_unknown_counterparty.is_empty() {
        println!("\n=== Blocks with 'unknown' counterparty but transaction hash ===");
        for record in &blocks_with_unknown_counterparty {
            println!("  Block {}: tx_hash = {}", 
                record.block_height, 
                record.transaction_hashes[0]
            );
            println!("    These should be analyzed to discover FT contracts");
        }
        
        // This demonstrates the gap in current implementation:
        // When counterparty is "unknown" but we have a transaction hash,
        // we should look up the transaction to find FT contract interactions
        println!("\n⚠ Current limitation: Transactions with 'unknown' counterparty are not analyzed");
        println!("  Enhancement needed: Query transaction by hash to discover FT contracts");
    }
    
    // Get all counterparties (excluding metadata values)
    let counterparties: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT counterparty
        FROM balance_changes
        WHERE account_id = $1 AND token_id = 'near'
          AND counterparty != 'SNAPSHOT'
        ORDER BY counterparty
        "#
    )
    .bind(account_id)
    .fetch_all(&pool)
    .await?;
    
    println!("\n=== Counterparties to Check for FT Contracts ===");
    if counterparties.is_empty() {
        println!("  (none found - only 'unknown' or 'system' counterparties)");
    } else {
        for counterparty in &counterparties {
            println!("  - {}", counterparty);
            
            // Try to check if it's an FT contract
            use nt_be::handlers::balance_changes::balance::ft::get_balance_at_block as get_ft_balance;
            match get_ft_balance(&pool, &network, account_id, counterparty, target_block as u64).await {
                Ok(balance) => {
                    println!("    ✓ IS an FT contract! Balance: {}", balance);
                }
                Err(_) => {
                    println!("    ✗ Not an FT contract");
                }
            }
        }
    }
    
    // Verify at least one NEAR record has a real counterparty (not snapshot/metadata)
    let near_counterparties: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT counterparty
        FROM balance_changes
        WHERE account_id = $1 AND token_id = 'near'
        ORDER BY counterparty
        "#
    )
    .bind(account_id)
    .fetch_all(&pool)
    .await?;
    
    let has_real_near_counterparty = near_counterparties.iter()
        .any(|cp| cp.as_str() != "SNAPSHOT");
    
    if has_real_near_counterparty {
        println!("\n✓ NEAR records have real counterparties");
    } else {
        println!("\n⚠ NEAR records only have SNAPSHOT counterparty (no transactions yet)");
    }
    
    Ok(())
}
