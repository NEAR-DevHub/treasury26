use near_api::{NetworkConfig, RPCEndpoint};
use nt_be::handlers::balance_changes::gap_filler::fill_gaps;
use nt_be::handlers::balance_changes::gap_detector::find_gaps;
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

/// Test gap detection and filling with a chain of SNAPSHOT records
/// 
/// Scenario:
/// - Block 177485501: SNAPSHOT with balance 0 -> 0
/// - Block 178085501: SNAPSHOT with balance 41.414178022306048887375898 -> 41.414178022306048887375898
/// - Block 178685501: SNAPSHOT with balance 41.414178022306048887375898 -> 41.414178022306048887375898
///
/// Gap: Between block 177485501 (balance_after=0) and 178085501 (balance_before=41.414178022306048887375898)
/// Expected behavior: Gap filler will search for the balance change in range [177485501, 178085501]
/// 
/// Note: npro.nearmobile.near has 24 decimals, so balances are decimal-adjusted:
/// - Raw 41414178022306048887375898 = 41.414178022306048887375898 NPRO
///
/// This test verifies the system handles FT transfers where receipts go to the token contract
/// (not the account), resulting in UNKNOWN counterparty records.
#[sqlx::test]
async fn test_fill_gap_between_snapshot_chain(pool: PgPool) -> sqlx::Result<()> {
    let account_id = "petersalomonsen.near";
    let token_id = "npro.nearmobile.near";
    
    let archival_network = create_archival_network();

    println!("\n=== Testing gap detection with SNAPSHOT chain ===");
    println!("Account: {}", account_id);
    println!("Token: {}", token_id);
    
    // Insert the three SNAPSHOT records
    println!("\n--- Step 1: Insert SNAPSHOT records ---");
    
    // SNAPSHOT 1: Block 177485501 with balance 0
    sqlx::query!(
        r#"
        INSERT INTO balance_changes 
            (account_id, token_id, block_height, block_timestamp, 
             amount, balance_before, balance_after, 
             transaction_hashes, receipt_id, counterparty)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        "#,
        account_id,
        token_id,
        177485501_i64,
        1766139214182554400_i64,
        BigDecimal::from(0),
        BigDecimal::from(0),
        BigDecimal::from(0),
        &Vec::<String>::new(),
        &Vec::<String>::new(),
        "SNAPSHOT"
    )
    .execute(&pool)
    .await?;
    
    println!("✓ Inserted SNAPSHOT at block 177485501: 0 -> 0");
    
    // Verify: what is the ACTUAL balance at block 177485501?
    use nt_be::handlers::balance_changes::balance::ft::get_balance_at_block as get_ft_balance;
    let actual_balance_at_177485501 = get_ft_balance(&pool, &archival_network, account_id, token_id, 177485501).await
        .expect("Should be able to query balance");
    println!("  ⚠️  ACTUAL balance at block 177485501: {}", actual_balance_at_177485501);
    println!("      (SNAPSHOT says 0, but actual balance is {})", actual_balance_at_177485501);
    
    // SNAPSHOT 2: Block 178085501 with balance 41.414178022306048887375898 (decimal-adjusted from 41414178022306048887375898)
    // npro.nearmobile.near has 24 decimals, so 41414178022306048887375898 raw = 41.414178022306048887375898 decimal
    let balance = BigDecimal::from_str("41.414178022306048887375898").unwrap();
    sqlx::query!(
        r#"
        INSERT INTO balance_changes 
            (account_id, token_id, block_height, block_timestamp, 
             amount, balance_before, balance_after, 
             transaction_hashes, receipt_id, counterparty)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        "#,
        account_id,
        token_id,
        178085501_i64,
        1766520990569151000_i64,
        BigDecimal::from(0),
        balance.clone(),
        balance.clone(),
        &Vec::<String>::new(),
        &Vec::<String>::new(),
        "SNAPSHOT"
    )
    .execute(&pool)
    .await?;
    
    println!("✓ Inserted SNAPSHOT at block 178085501: {} -> {}", balance, balance);
    
    // Verify: what is the ACTUAL balance at block 178085501?
    let actual_balance_at_178085501 = get_ft_balance(&pool, &archival_network, account_id, token_id, 178085501).await
        .expect("Should be able to query balance");
    println!("  ⚠️  ACTUAL balance at block 178085501: {}", actual_balance_at_178085501);
    if actual_balance_at_178085501 != balance.to_string() {
        println!("      ERROR: SNAPSHOT says {}, but actual balance is {}", balance, actual_balance_at_178085501);
    }
    
    // SNAPSHOT 3: Block 178685501 with balance 41414178022306048887375898
    sqlx::query!(
        r#"
        INSERT INTO balance_changes 
            (account_id, token_id, block_height, block_timestamp, 
             amount, balance_before, balance_after, 
             transaction_hashes, receipt_id, counterparty)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        "#,
        account_id,
        token_id,
        178685501_i64,
        1766909443996280300_i64,
        BigDecimal::from(0),
        balance.clone(),
        balance.clone(),
        &Vec::<String>::new(),
        &Vec::<String>::new(),
        "SNAPSHOT"
    )
    .execute(&pool)
    .await?;
    
    println!("✓ Inserted SNAPSHOT at block 178685501: {} -> {}", balance, balance);
    
    // Step 2: Detect gaps
    println!("\n--- Step 2: Detect gaps ---");
    let gaps = find_gaps(&pool, account_id, token_id, 178685501).await?;
    
    println!("Gaps detected: {}", gaps.len());
    for gap in &gaps {
        println!("  Gap: block {} to {} (balance {} -> {})",
            gap.start_block, gap.end_block, gap.actual_balance_after, gap.expected_balance_before);
    }
    
    // Should detect gap between block 177485501 (balance_after=0) and 178085501 (balance_before=41.414178022306048887375898)
    assert_eq!(gaps.len(), 1, "Should detect exactly one gap");
    assert_eq!(gaps[0].start_block, 177485501, "Gap should start after block 177485501");
    assert_eq!(gaps[0].end_block, 178085501, "Gap should end at block 178085501");
    assert_eq!(gaps[0].actual_balance_after, "0", "Gap start balance should be 0");
    assert_eq!(gaps[0].expected_balance_before, "41.414178022306048887375898", "Gap end balance should be 41.414178022306048887375898");
    
    // Step 3: Fill gaps
    println!("\n--- Step 3: Fill gaps ---");
    let filled = fill_gaps(&pool, &archival_network, account_id, token_id, 178685501).await
        .expect("Should be able to fill gaps - will insert UNKNOWN counterparty");
    
    println!("\n✓ Gap filling completed");
    println!("  Filled {} gaps", filled.len());
    
    // The gap SHOULD be filled because:
    // - Binary search finds balance changed at block 177751529
    // - No receipts found with the account as receiver (FT receipts go to token contract)
    // - SNAPSHOT insertion fails (balance actually changed from 0 to 41.414178022306048887375898)
    // - Falls back to UNKNOWN counterparty record
    assert_eq!(filled.len(), 1, "Should have filled exactly 1 gap");
    assert_eq!(filled[0].block_height, 177751529, "Gap should be filled at block 177751529");
    assert_eq!(filled[0].balance_before, "0", "Balance before should be 0");
    assert_eq!(filled[0].balance_after, "41.414178022306048887375898", "Balance after should be 41.414178022306048887375898 (decimal-adjusted)");
    
    // Query the filled record to verify it has UNKNOWN counterparty
    let filled_record = sqlx::query!(
        r#"
        SELECT block_height, balance_before::TEXT as "balance_before!", balance_after::TEXT as "balance_after!", 
               counterparty, receipt_id, transaction_hashes
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2 AND block_height = 177751529
        "#,
        account_id,
        token_id
    )
    .fetch_one(&pool)
    .await
    .expect("Should find the filled record at block 177751529");
    
    println!("\n--- Filled record at block 177751529 ---");
    println!("  Balance: {} -> {}", filled_record.balance_before, filled_record.balance_after);
    println!("  Counterparty: {}", filled_record.counterparty);
    println!("  Receipt IDs: {:?}", filled_record.receipt_id);
    println!("  Transaction hashes: {:?}", filled_record.transaction_hashes);
    
    // Verify the record has UNKNOWN counterparty
    assert_eq!(filled_record.counterparty, "UNKNOWN", 
        "Counterparty should be UNKNOWN when receipts cannot be found");
    
    // Verify no receipt or transaction data
    assert!(filled_record.receipt_id.is_empty(), "Should have no receipt IDs");
    assert!(filled_record.transaction_hashes.is_empty(), "Should have no transaction hashes");
    
    println!("\n✅ TEST PASSED: Gap filled with UNKNOWN counterparty");
    println!("   Balance change recorded despite missing receipt data");
    println!("   Counterparty can be resolved later via third-party APIs");
    
    Ok(())
}
