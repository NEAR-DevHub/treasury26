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

        let near_before =
            BigDecimal::from_str(balance_before["near"].as_str().unwrap_or("0")).unwrap();
        let near_after =
            BigDecimal::from_str(balance_after["near"].as_str().unwrap_or("0")).unwrap();
        let near_diff =
            BigDecimal::from_str(tx["changes"]["nearDiff"].as_str().unwrap_or("0")).unwrap();

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
async fn test_query_unavailable_block_with_retry(_pool: PgPool) -> sqlx::Result<()> {
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
        balance::get_balance_change_at_block(&network, account_id, "near", problematic_block).await;

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
