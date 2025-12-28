use near_api::{NetworkConfig, RPCEndpoint};
use nt_be::handlers::balance_changes::gap_filler::fill_gaps;
use nt_be::handlers::balance_changes::balance::ft::get_balance_at_block as get_ft_balance;
use nt_be::handlers::balance_changes::block_info::get_block_timestamp;
use sqlx::PgPool;
use sqlx::types::BigDecimal;
use std::str::FromStr;

/// Helper to create archival network config for tests
fn create_archival_network() -> NetworkConfig {
    dotenvy::from_filename(".env").ok();
    dotenvy::from_filename(".env.test").ok();
    
    let fastnear_api_key = std::env::var("FASTNEAR_API_KEY")
        .expect("FASTNEAR_API_KEY must be set in .env");
    
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

/// Test reproducing the exact "No receipt found" error from production monitoring
///
/// Real scenario:
/// 1. Discovery creates SNAPSHOT at block 178685501 with balance_before = balance_after = 41414178022306048887375898
/// 2. fill_gap_to_past detects gap (balance_before != 0)
/// 3. Binary search looks back 600,000 blocks (7 days) to block 178085501
/// 4. Balance at 178085501 is the same as 178685501 (existed before the search range)
/// 5. insert_balance_change_record tries to insert at 178085501 but finds no receipts
/// 6. Error: "No receipt found for block 178085501 - cannot determine counterparty"
///
/// Expected fix: When balance existed before the search range, insert a SNAPSHOT record
/// instead of failing with "No receipt found" error.
#[sqlx::test]
async fn test_fill_gap_to_past_with_insufficient_lookback(pool: PgPool) -> sqlx::Result<()> {
    let account_id = "petersalomonsen.near";
    let token_contract = "npro.nearmobile.near";
    let snapshot_block = 178685501_i64;
    
    let archival_network = create_archival_network();

    println!("\n=== Reproducing 'No receipt found' error from monitoring ===");
    println!("Scenario: SNAPSHOT exists but balance originated before 7-day lookback window");
    println!("Account: {}", account_id);
    println!("Token: {}", token_contract);
    println!("Snapshot block: {}", snapshot_block);
    
    // Step 1: Insert SNAPSHOT record with balance_before != 0
    // (This simulates what the discovery system creates)
    println!("\n--- Step 1: Insert SNAPSHOT record (as discovery creates) ---");
    
    let balance_at_snapshot = get_ft_balance(&pool, &archival_network, account_id, token_contract, snapshot_block as u64)
        .await
        .expect("Failed to get balance");
    
    println!("Balance at snapshot block: {}", balance_at_snapshot);
    
    let balance_bd = BigDecimal::from_str(&balance_at_snapshot)
        .expect("Failed to parse balance");
    
    let block_timestamp = get_block_timestamp(&archival_network, snapshot_block as u64, None)
        .await
        .expect("Failed to get timestamp");
    
    // Insert SNAPSHOT with balance_before = balance_after (the bug!)
    sqlx::query!(
        r#"
        INSERT INTO balance_changes 
            (account_id, token_id, block_height, block_timestamp, 
             amount, balance_before, balance_after, 
             transaction_hashes, receipt_id, signer_id, receiver_id, counterparty)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        "#,
        account_id,
        token_contract,
        snapshot_block,
        block_timestamp,
        BigDecimal::from(0),  // amount = 0
        balance_bd.clone(),    // balance_before = current balance (WRONG!)
        balance_bd.clone(),    // balance_after = current balance
        &Vec::<String>::new(),
        &Vec::<String>::new(),
        None::<String>,
        None::<String>,
        "SNAPSHOT"
    )
    .execute(&pool)
    .await?;
    
    println!("✓ Inserted SNAPSHOT with balance_before = balance_after = {} (simulating discovery bug)", balance_bd);
    
    // Step 2: Verify balance existed 600,000 blocks earlier (beyond lookback window)
    println!("\n--- Step 2: Verify balance existed before lookback window ---");
    let lookback_blocks = 600_000;
    let lookback_block = snapshot_block - lookback_blocks;
    
    let balance_at_lookback = get_ft_balance(&pool, &archival_network, account_id, token_contract, lookback_block as u64)
        .await
        .expect("Failed to get balance at lookback block");
    
    println!("Balance at block {} (600k blocks earlier): {}", lookback_block, balance_at_lookback);
    
    if balance_at_lookback == balance_at_snapshot {
        println!("✓ Confirmed: Balance existed before the 7-day lookback window");
    } else {
        println!("⚠ Balance was different at lookback block - test scenario doesn't match production");
    }
    
    // Step 3: Call fill_gaps which will invoke fill_gap_to_past
    println!("\n--- Step 3: Call fill_gaps (triggers fill_gap_to_past) ---");
    println!("This should detect that balance_before != 0 and search backward...");
    
    let result = fill_gaps(&pool, &archival_network, account_id, token_contract, snapshot_block).await;
    
    match result {
        Ok(filled) => {
            println!("\n✓ Gap filling succeeded!");
            println!("  Filled {} gaps", filled.len());
            for gap in &filled {
                println!("    Block {}: {} -> {}", gap.block_height, gap.balance_before, gap.balance_after);
            }
            
            // After fix: verify SNAPSHOT record was inserted at lookback boundary
            let records = sqlx::query!(
                r#"
                SELECT block_height, counterparty, balance_before::TEXT as "balance_before!", balance_after::TEXT as "balance_after!"
                FROM balance_changes 
                WHERE account_id = $1 AND token_id = $2 
                ORDER BY block_height ASC
                "#,
                account_id,
                token_contract
            )
            .fetch_all(&pool)
            .await?;
            
            println!("\nBalance change records after fill_gaps:");
            for record in &records {
                println!("  Block {}: {} -> {} [{}]",
                    record.block_height,
                    record.balance_before,
                    record.balance_after,
                    &record.counterparty
                );
            }
            
            // Should have at least 2 records: original SNAPSHOT + new SNAPSHOT at lookback boundary
            assert!(records.len() >= 2, "Expected at least 2 records after fix");
            
            // Earliest record should be a SNAPSHOT (not a transactional record with receipts)
            let earliest = &records[0];
            assert_eq!(
                &earliest.counterparty,
                "SNAPSHOT",
                "Earliest record should be a SNAPSHOT when balance existed before lookback window"
            );
            
            println!("\n✅ TEST PASSED: Gap filler correctly inserted SNAPSHOT at lookback boundary");
        }
        Err(e) => {
            let err_msg = e.to_string();
            println!("\n❌ Gap filling failed: {}", err_msg);
            
            // Before fix: this is the expected error
            assert!(
                err_msg.contains("No receipt found for block 178085501"),
                "Expected specific error 'No receipt found for block 178085501', got: {}",
                err_msg
            );
            
            println!("\n=== ERROR REPRODUCED ===");
            println!("This is the production error we need to fix:");
            println!();
            println!("Issue:");
            println!("  1. SNAPSHOT created at block {} with balance_before = balance_after", snapshot_block);
            println!("  2. fill_gap_to_past detects gap (balance_before = {} != 0)", balance_at_snapshot);
            println!("  3. Searches backward 600,000 blocks to block {}", lookback_block);
            println!("  4. Balance at {} is same as {} (existed before search range)", lookback_block, snapshot_block);
            println!("  5. Tries to insert transactional record at block {}", lookback_block);
            println!("  6. No receipts found → ERROR");
            println!();
            println!("Solution:");
            println!("  When balance existed before the lookback window,");
            println!("  insert a SNAPSHOT record (not transactional record)");
            println!("  at the lookback boundary to mark the limit of our search.");
            
            // Fail the test until we implement the fix
            panic!("Test documents the bug - will pass once fix is implemented");
        }
    }

    Ok(())
}

