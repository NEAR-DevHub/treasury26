use near_api::{NetworkConfig, RPCEndpoint};
use nt_be::handlers::balance_changes::gap_filler::fill_gaps;
use sqlx::PgPool;
use sqlx::types::BigDecimal;
use sqlx::types::chrono::{DateTime, Utc};

/// Helper to convert nanosecond timestamp to DateTime<Utc>
fn timestamp_to_datetime(timestamp_nanos: i64) -> DateTime<Utc> {
    let secs = timestamp_nanos / 1_000_000_000;
    let nsecs = (timestamp_nanos % 1_000_000_000) as u32;
    DateTime::from_timestamp(secs, nsecs).expect("Failed to convert timestamp")
}

/// Helper to create archival network config for tests
fn create_archival_network() -> NetworkConfig {
    dotenvy::from_filename(".env").ok();
    dotenvy::from_filename_override(".env.test").ok();

    let fastnear_api_key =
        std::env::var("FASTNEAR_API_KEY").expect("FASTNEAR_API_KEY must be set in .env");

    NetworkConfig {
        rpc_endpoints: vec![
            RPCEndpoint::new(
                "https://archival-rpc.mainnet.fastnear.com/"
                    .parse()
                    .unwrap(),
            )
            .with_api_key(fastnear_api_key),
        ],
        ..NetworkConfig::mainnet()
    }
}

/// Test gap detection when SNAPSHOT has balance 0 but history shows non-zero balance
///
/// Scenario:
/// - SNAPSHOT at block 178707314 with USDC balance 0 -> 0
/// - Actual withdrawal at block 178086210 (621,104 blocks earlier)
/// - Withdrawal is OUTSIDE the 600k lookback window
///
/// Expected behavior (iterative gap filling):
///
/// Run 1 (from block 178707314):
/// - Look back 600k blocks to 178107314
/// - Find balance is 0 at lookback boundary
/// - Cannot find when balance became 0 (withdrawal is earlier)
/// - Insert SNAPSHOT at lookback boundary (178107314) with balance 0
///
/// Run 2 (from block 178107314):
/// - Look back 600k blocks to 177507314  
/// - Find balance is 3450 at lookback boundary (non-zero!)
/// - Search for when balance changed from 3450 to 0
/// - Find and fill the withdrawal at block 178086210
///
/// This demonstrates how the system progressively discovers complete history
/// through iterative lookbacks, even when changes are beyond a single window.
#[sqlx::test]
async fn test_fill_gap_before_zero_snapshot(pool: PgPool) -> sqlx::Result<()> {
    let account_id = "petersalomonsen.near";
    let token_id = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // USDC

    let archival_network = create_archival_network();

    println!("\n=== Testing gap detection before SNAPSHOT with zero balance ===");
    println!("Account: {}", account_id);
    println!("Token: {} (USDC)", token_id);

    // Insert a SNAPSHOT record at block 178707314 with balance 0 -> 0
    // This simulates monitoring creating a SNAPSHOT at a recent block
    let snapshot_block: i64 = 178707314;
    let snapshot_timestamp = 1766922697036882400_i64;
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
        snapshot_block,
        snapshot_timestamp,
        timestamp_to_datetime(snapshot_timestamp),
        BigDecimal::from(0),
        BigDecimal::from(0),
        BigDecimal::from(0),
        &Vec::<String>::new(),
        &Vec::<String>::new(),
        "SNAPSHOT"
    )
    .execute(&pool)
    .await?;

    println!("✓ Inserted SNAPSHOT at block {}: 0 -> 0", snapshot_block);

    // The SNAPSHOT has balance 0, but if this came from a withdrawal,
    // the balance just before should be non-zero. Let's verify:
    use nt_be::handlers::balance_changes::balance::ft::get_balance_at_block as get_ft_balance;

    // The actual withdrawal happened at block 178086210 (621,104 blocks before SNAPSHOT)
    // This is OUTSIDE the default 600k block lookback window
    let withdrawal_block: i64 = 178086210;
    use bigdecimal::BigDecimal;
    use std::str::FromStr;
    let balance_before_withdrawal = BigDecimal::from_str("3450").unwrap(); // USDC (6 decimals)

    println!(
        "\n  Checking balance at known withdrawal block {}...",
        withdrawal_block
    );

    // Verify balance before withdrawal
    let check_block_before = withdrawal_block - 100;
    let balance_at_check = get_ft_balance(
        &pool,
        &archival_network,
        account_id,
        token_id,
        check_block_before as u64,
    )
    .await
    .expect("Should be able to query balance before withdrawal");

    println!(
        "    Block {} (before withdrawal): balance = {}",
        check_block_before, balance_at_check
    );
    assert_eq!(
        balance_at_check, balance_before_withdrawal,
        "Balance before withdrawal should be 3450 USDC"
    );

    // Verify balance after withdrawal is 0
    let check_block_after = withdrawal_block + 100;
    let balance_after_withdrawal = get_ft_balance(
        &pool,
        &archival_network,
        account_id,
        token_id,
        check_block_after as u64,
    )
    .await
    .expect("Should be able to query balance after withdrawal");

    println!(
        "    Block {} (after withdrawal): balance = {}",
        check_block_after, balance_after_withdrawal
    );
    assert_eq!(
        balance_after_withdrawal,
        BigDecimal::from_str("0").unwrap(),
        "Balance after withdrawal should be 0"
    );

    println!(
        "  ✓ Confirmed withdrawal at block {}: {} -> 0",
        withdrawal_block, balance_before_withdrawal
    );

    // Now use binary search to find the EXACT block where balance became 0
    use nt_be::handlers::balance_changes::binary_search::find_balance_change_block;

    println!("\n  Using binary search to find exact withdrawal block...");
    let change_block = find_balance_change_block(
        &pool,
        &archival_network,
        account_id,
        token_id,
        check_block_before as u64,           // Start from before withdrawal
        check_block_after as u64,            // End after withdrawal
        &BigDecimal::from_str("0").unwrap(), // Target balance is 0
    )
    .await
    .expect("Should find the balance change block");

    let found_withdrawal_block = change_block.expect("Should find a block where balance became 0");
    println!(
        "  ✓ Binary search found balance change at block {}",
        found_withdrawal_block
    );

    // Verify binary search found the correct block
    assert_eq!(
        found_withdrawal_block, withdrawal_block as u64,
        "Binary search should find the withdrawal at block 178086210"
    );

    // Now test fill_gaps behavior
    // Since the withdrawal is 621,104 blocks before SNAPSHOT (outside 600k lookback),
    // fill_gap_to_past should:
    // 1. Look back 600k blocks from SNAPSHOT (to block 178107314)
    // 2. Find balance is 0 there
    // 3. Since earliest record is SNAPSHOT with balance_before=0, check actual balance at start_block
    // 4. Find balance is still 0 at lookback boundary
    // 5. Return None (no gap to fill within lookback window)

    // ===== FIRST RUN: Fill gaps from original SNAPSHOT =====
    println!(
        "\n--- First run: fill_gaps from block {} ---",
        snapshot_block
    );
    let filled_run1 = fill_gaps(
        &pool,
        &archival_network,
        account_id,
        token_id,
        snapshot_block,
    )
    .await
    .map_err(|e| sqlx::Error::Protocol(format!("fill_gaps error: {}", e)))?;

    // The withdrawal is 621,104 blocks before SNAPSHOT, outside the 600k lookback window
    // fill_gap_to_past should:
    // 1. Query balance at lookback boundary (block 178107314)
    // 2. Find balance is 0 there
    // 3. Search for when balance became 0 (won't find it, withdrawal is earlier)
    // 4. Insert SNAPSHOT at lookback boundary with balance 0
    println!("  Filled {} gap(s)", filled_run1.len());

    assert!(
        !filled_run1.is_empty(),
        "First run: should have filled 1 gap (SNAPSHOT at lookback boundary)"
    );
    assert_eq!(
        filled_run1.len(),
        1,
        "First run: should have filled exactly 1 gap"
    );

    let lookback_boundary = snapshot_block - 600_000;
    let filled_record = &filled_run1[0];

    println!("\n  First run filled:");
    println!("    Block: {}", filled_record.block_height);
    println!(
        "    Balance: {} -> {}",
        filled_record.balance_before, filled_record.balance_after
    );

    // Hard assertions: should be a SNAPSHOT at lookback boundary
    assert_eq!(
        filled_record.block_height, lookback_boundary,
        "First run: should insert SNAPSHOT at lookback boundary (600k blocks before original)"
    );
    assert_eq!(
        filled_record.balance_before,
        BigDecimal::from_str("0").unwrap(),
        "First run: balance at lookback boundary was 0"
    );
    assert_eq!(
        filled_record.balance_after,
        BigDecimal::from_str("0").unwrap(),
        "First run: balance at lookback boundary was 0"
    );

    println!(
        "  ✓ First run: Inserted SNAPSHOT at lookback boundary (block {})",
        lookback_boundary
    );

    // ===== SECOND RUN: Fill gaps from the newly inserted SNAPSHOT =====
    println!(
        "\n--- Second run: fill_gaps from block {} ---",
        lookback_boundary
    );
    let filled_run2 = fill_gaps(
        &pool,
        &archival_network,
        account_id,
        token_id,
        lookback_boundary,
    )
    .await
    .map_err(|e| sqlx::Error::Protocol(format!("fill_gaps error: {}", e)))?;

    // Now the earliest record is at block 178107314 with balance 0
    // Looking back 600k blocks reaches 177507314
    // The withdrawal at 178086210 is within this window!
    // fill_gap_to_past should:
    // 1. Query balance at lookback boundary (177507314)
    // 2. Find balance is 3450 there (non-zero!)
    // 3. Search for when balance changed from 3450 to 0
    // 4. Find the withdrawal at block 178086210
    println!("  Filled {} gap(s)", filled_run2.len());

    // Print what was filled
    for (i, gap) in filled_run2.iter().enumerate() {
        println!(
            "    Gap {}: Block {} - {} -> {}",
            i + 1,
            gap.block_height,
            gap.balance_before,
            gap.balance_after
        );
    }

    assert!(
        !filled_run2.is_empty(),
        "Second run: should have filled gaps"
    );

    // Find the withdrawal record (should be at block 178086210)
    let withdrawal_gap = filled_run2
        .iter()
        .find(|g| g.block_height == withdrawal_block)
        .expect("Second run: should have filled the withdrawal block");

    println!("\n  Second run filled withdrawal:");
    println!("    Block: {}", withdrawal_gap.block_height);
    println!(
        "    Balance: {} -> {}",
        withdrawal_gap.balance_before, withdrawal_gap.balance_after
    );

    // Hard assertions on the withdrawal
    assert_eq!(
        withdrawal_gap.balance_before, balance_before_withdrawal,
        "Second run: balance before withdrawal should be 3450"
    );
    assert_eq!(
        withdrawal_gap.balance_after,
        BigDecimal::from_str("0").unwrap(),
        "Second run: balance after withdrawal should be 0"
    );

    println!(
        "  ✓ Second run: Found and filled actual withdrawal at block {}",
        withdrawal_block
    );

    // Query all records to verify complete chain
    let records = sqlx::query!(
        r#"
        SELECT block_height, balance_before::TEXT as "balance_before!", 
               balance_after::TEXT as "balance_after!", counterparty
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height ASC
        "#,
        account_id,
        token_id
    )
    .fetch_all(&pool)
    .await?;

    println!(
        "\n--- Final balance change chain (total: {}) ---",
        records.len()
    );
    for (i, r) in records.iter().enumerate() {
        println!(
            "  {}. Block {}: {} -> {} ({})",
            i + 1,
            r.block_height,
            r.balance_before,
            r.balance_after,
            r.counterparty
        );
    }

    // Verify we have at least the withdrawal + 2 SNAPSHOTs
    assert!(records.len() >= 3, "Should have at least 3 records");

    // Find the withdrawal record
    let withdrawal_record = records
        .iter()
        .find(|r| r.block_height == withdrawal_block)
        .expect("Should have withdrawal record");
    assert_eq!(
        withdrawal_record.balance_before,
        balance_before_withdrawal.to_string(),
        "Withdrawal: before"
    );
    assert_eq!(withdrawal_record.balance_after, "0", "Withdrawal: after");

    // Find both SNAPSHOTs
    let snapshots: Vec<_> = records
        .iter()
        .filter(|r| r.counterparty == "SNAPSHOT")
        .collect();
    assert!(
        snapshots
            .iter()
            .any(|s| s.block_height == lookback_boundary),
        "Should have SNAPSHOT at lookback boundary"
    );
    assert!(
        snapshots.iter().any(|s| s.block_height == snapshot_block),
        "Should have original SNAPSHOT"
    );

    println!("\n✓ Test passed: Iterative gap filling successfully found complete history");
    println!("  Key records:");
    println!(
        "    Block {} - Withdrawal: {} USDC -> 0",
        withdrawal_block, balance_before_withdrawal
    );
    println!(
        "    Block {} - SNAPSHOT: 0 (inserted by first fill_gaps run)",
        lookback_boundary
    );
    println!("    Block {} - SNAPSHOT: 0 (original)", snapshot_block);
    println!("\n  Strategy:");
    println!(
        "    Run 1: Looked back 600k blocks from {}, found balance=0, inserted SNAPSHOT at {}",
        snapshot_block, lookback_boundary
    );
    println!(
        "    Run 2: Looked back 600k blocks from {}, found balance=3450, filled withdrawal at {}",
        lookback_boundary, withdrawal_block
    );
    println!(
        "\n  This demonstrates how the system progressively discovers history through iterative lookbacks."
    );

    Ok(())
}
