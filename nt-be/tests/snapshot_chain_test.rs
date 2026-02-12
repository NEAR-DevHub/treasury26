mod common;

use nt_be::handlers::balance_changes::gap_detector::find_gaps;
use nt_be::handlers::balance_changes::gap_filler::fill_gaps;
use sqlx::PgPool;
use sqlx::types::chrono::DateTime;

/// Convert NEAR block timestamp (nanoseconds) to DateTime<Utc>
fn timestamp_to_datetime(timestamp_nanos: i64) -> DateTime<sqlx::types::chrono::Utc> {
    let secs = timestamp_nanos / 1_000_000_000;
    let nsecs = (timestamp_nanos % 1_000_000_000) as u32;
    DateTime::from_timestamp(secs, nsecs).expect("Failed to convert timestamp")
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
/// (not the account). FT counterparty resolution queries the token contract's state changes
/// to identify the actual counterparty.
#[sqlx::test]
async fn test_fill_gap_between_snapshot_chain(pool: PgPool) -> sqlx::Result<()> {
    let account_id = "petersalomonsen.near";
    let token_id = "npro.nearmobile.near";

    let archival_network = common::create_archival_network();

    println!("\n=== Testing gap detection with SNAPSHOT chain ===");
    println!("Account: {}", account_id);
    println!("Token: {}", token_id);

    // Insert the three SNAPSHOT records
    println!("\n--- Step 1: Insert SNAPSHOT records ---");

    // SNAPSHOT 1: Block 177485501 with balance 0
    let timestamp1 = 1766139214182554400_i64;
    sqlx::query!(
        r#"
        INSERT INTO balance_changes 
            (account_id, token_id, block_height, block_timestamp, block_time,
             amount, balance_before, balance_after, 
             transaction_hashes, receipt_id, counterparty)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        "#,
        account_id,
        token_id,
        177485501_i64,
        timestamp1,
        timestamp_to_datetime(timestamp1),
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
    let actual_balance_at_177485501 =
        get_ft_balance(&pool, &archival_network, account_id, token_id, 177485501)
            .await
            .expect("Should be able to query balance");
    println!(
        "  ⚠️  ACTUAL balance at block 177485501: {}",
        actual_balance_at_177485501
    );
    println!(
        "      (SNAPSHOT says 0, but actual balance is {})",
        actual_balance_at_177485501
    );

    // SNAPSHOT 2: Block 178085501 with balance 41.414178022306048887375898 (decimal-adjusted from 41414178022306048887375898)
    // npro.nearmobile.near has 24 decimals, so 41414178022306048887375898 raw = 41.414178022306048887375898 decimal
    let balance = BigDecimal::from_str("41.414178022306048887375898").unwrap();
    let timestamp2 = 1766909444596280416_i64;
    sqlx::query!(
        r#"
        INSERT INTO balance_changes 
            (account_id, token_id, block_height, block_timestamp, block_time,
             amount, balance_before, balance_after, 
             transaction_hashes, receipt_id, counterparty)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        "#,
        account_id,
        token_id,
        178085501_i64,
        timestamp2,
        timestamp_to_datetime(timestamp2),
        BigDecimal::from(0),
        balance.clone(),
        balance.clone(),
        &Vec::<String>::new(),
        &Vec::<String>::new(),
        "SNAPSHOT"
    )
    .execute(&pool)
    .await?;

    println!(
        "✓ Inserted SNAPSHOT at block 178085501: {} -> {}",
        balance, balance
    );

    // Verify: what is the ACTUAL balance at block 178085501?
    let actual_balance_at_178085501 =
        get_ft_balance(&pool, &archival_network, account_id, token_id, 178085501)
            .await
            .expect("Should be able to query balance");
    println!(
        "  ⚠️  ACTUAL balance at block 178085501: {}",
        actual_balance_at_178085501
    );
    if actual_balance_at_178085501.to_string() != balance.to_string() {
        println!(
            "      ERROR: SNAPSHOT says {}, but actual balance is {}",
            balance, actual_balance_at_178085501
        );
    }

    // SNAPSHOT 3: Block 178685501 with balance 41414178022306048887375898
    let timestamp3 = 1767679675056280416_i64;
    sqlx::query!(
        r#"
        INSERT INTO balance_changes 
            (account_id, token_id, block_height, block_timestamp, block_time,
             amount, balance_before, balance_after, 
             transaction_hashes, receipt_id, counterparty)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        "#,
        account_id,
        token_id,
        178685501_i64,
        timestamp3,
        timestamp_to_datetime(timestamp3),
        BigDecimal::from(0),
        balance.clone(),
        balance.clone(),
        &Vec::<String>::new(),
        &Vec::<String>::new(),
        "SNAPSHOT"
    )
    .execute(&pool)
    .await?;

    println!(
        "✓ Inserted SNAPSHOT at block 178685501: {} -> {}",
        balance, balance
    );

    // Step 2: Detect gaps
    println!("\n--- Step 2: Detect gaps ---");
    let gaps = find_gaps(&pool, account_id, token_id, 178685501).await?;

    println!("Gaps detected: {}", gaps.len());
    for gap in &gaps {
        println!(
            "  Gap: block {} to {} (balance {} -> {})",
            gap.start_block, gap.end_block, gap.actual_balance_after, gap.expected_balance_before
        );
    }

    // Should detect gap between block 177485501 (balance_after=0) and 178085501 (balance_before=41.414178022306048887375898)
    assert_eq!(gaps.len(), 1, "Should detect exactly one gap");
    assert_eq!(
        gaps[0].start_block, 177485501,
        "Gap should start after block 177485501"
    );
    assert_eq!(
        gaps[0].end_block, 178085501,
        "Gap should end at block 178085501"
    );
    use bigdecimal::BigDecimal;
    use std::str::FromStr;
    assert_eq!(
        gaps[0].actual_balance_after,
        BigDecimal::from_str("0").unwrap(),
        "Gap start balance should be 0"
    );
    assert_eq!(
        gaps[0].expected_balance_before,
        BigDecimal::from_str("41.414178022306048887375898").unwrap(),
        "Gap end balance should be 41.414178022306048887375898"
    );

    // Step 3: Fill gaps
    println!("\n--- Step 3: Fill gaps ---");
    let filled = fill_gaps(&pool, &archival_network, account_id, token_id, 178685501)
        .await
        .expect("Should be able to fill gaps with FT counterparty resolution");

    println!("\n✓ Gap filling completed");
    println!("  Filled {} gaps", filled.len());

    // With the new logic that always inserts SNAPSHOTs at lookback boundaries,
    // we may fill 2 gaps: the actual balance change + a SNAPSHOT at lookback
    // Find the actual balance change at block 177751529
    let balance_change = filled
        .iter()
        .find(|g| g.block_height == 177751529)
        .expect("Should have filled gap at block 177751529");

    assert_eq!(
        balance_change.balance_before,
        BigDecimal::from_str("0").unwrap(),
        "Balance before should be 0"
    );
    assert_eq!(
        balance_change.balance_after,
        BigDecimal::from_str("41.414178022306048887375898").unwrap(),
        "Balance after should be 41.414178022306048887375898 (decimal-adjusted)"
    );

    println!("  ✓ Found balance change at block 177751529: 0 -> 41.414178022306048887375898");

    // Query the filled record to verify counterparty was resolved
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
    println!(
        "  Balance: {} -> {}",
        filled_record.balance_before, filled_record.balance_after
    );
    println!("  Counterparty: {}", filled_record.counterparty);
    println!("  Receipt IDs: {:?}", filled_record.receipt_id);
    println!(
        "  Transaction hashes: {:?}",
        filled_record.transaction_hashes
    );

    // FT counterparty resolution finds the actual sender via token contract state changes
    assert_eq!(
        filled_record.counterparty, "distribution.nearmobile.near",
        "Counterparty should be resolved from token contract receipts"
    );

    // FT counterparty resolution provides the receipt ID
    assert!(
        !filled_record.receipt_id.is_empty(),
        "Should have receipt IDs from FT counterparty resolution"
    );

    println!("\n✅ TEST PASSED: Gap filled with resolved FT counterparty");
    println!("   Counterparty resolved via token contract state changes");

    Ok(())
}
