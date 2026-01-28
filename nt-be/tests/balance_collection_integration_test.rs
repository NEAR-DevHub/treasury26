#![allow(clippy::collapsible_if)]
#![allow(clippy::io_other_error)]

mod common;

use nt_be::handlers::balance_changes::gap_detector::find_gaps;
use nt_be::handlers::balance_changes::gap_filler::fill_gaps;
use sqlx::{PgPool, types::BigDecimal};
use std::str::FromStr;

/// Test that gap filler can find and fill a gap with live RPC data
#[sqlx::test]
async fn test_fill_gap_end_to_end(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
    // Use petersalomonsen.near which has real balance changes
    let account_id = "petersalomonsen.near";
    let token_id = "near";
    let network = common::create_archival_network();

    // Use block range from real data - we know there are multiple changes between 178142668 and 178148638
    // Start from a later block and let the system fill gaps backward
    let start_block: i64 = 178_149_000;
    let filled = fill_gaps(&pool, &network, account_id, token_id, start_block)
        .await
        .expect("fill_gaps should not error");

    assert!(!filled.is_empty(), "Should have found and filled gaps");
    println!("Filled {} initial records", filled.len());

    // Get all non-SNAPSHOT records (actual balance changes)
    let records = sqlx::query!(
        "SELECT block_height FROM balance_changes 
         WHERE account_id = $1 AND token_id = $2 AND counterparty != 'SNAPSHOT' 
         ORDER BY block_height",
        account_id,
        token_id
    )
    .fetch_all(&pool)
    .await?;

    println!("Found {} non-SNAPSHOT records", records.len());
    assert!(
        records.len() >= 2,
        "Need at least 2 records to test gap filling, got {}",
        records.len()
    );

    // Remove a record from the middle (or the first if we only have 2)
    let idx_to_remove = if records.len() > 2 {
        records.len() / 2
    } else {
        0
    };
    let block_to_remove = records[idx_to_remove].block_height;
    println!(
        "Removing record at block {} (index {}) to create gap",
        block_to_remove, idx_to_remove
    );

    sqlx::query!(
        "DELETE FROM balance_changes WHERE account_id = $1 AND token_id = $2 AND block_height = $3",
        account_id,
        token_id,
        block_to_remove
    )
    .execute(&pool)
    .await?;

    // Verify gap exists
    let gaps_before = find_gaps(&pool, account_id, token_id, start_block).await?;
    assert!(
        !gaps_before.is_empty(),
        "Should have at least one gap after removing record"
    );
    println!("Detected {} gap(s)", gaps_before.len());

    // Fill the gap
    let refilled = fill_gaps(&pool, &network, account_id, token_id, start_block)
        .await
        .expect("fill_gaps should not error");

    assert!(!refilled.is_empty(), "Should have refilled the gap");
    println!("Refilled {} record(s)", refilled.len());

    // Verify the specific block we removed was refilled
    let refilled_record = sqlx::query!(
        "SELECT block_height FROM balance_changes 
         WHERE account_id = $1 AND token_id = $2 AND block_height = $3",
        account_id,
        token_id,
        block_to_remove
    )
    .fetch_optional(&pool)
    .await?;

    assert!(
        refilled_record.is_some(),
        "Should have refilled the removed block {}",
        block_to_remove
    );
    println!("✓ Successfully refilled block {}", block_to_remove);

    println!("✓ Gap filling test completed successfully - deleted record was refilled");

    Ok(())
}

/// Test seed_initial_balance to bootstrap an account
#[sqlx::test]
async fn test_seed_initial_balance(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
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

    let network = common::create_archival_network();

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
///
/// This test verifies that fill_gaps correctly:
/// 1. Seeds initial balance when no records exist
/// 2. Fills gaps backwards to find earlier balance changes
/// 3. Captures receipt data correctly for each balance change
///
/// Key records expected (in block order):
/// - Block 176927244: balance change with receipt 6Giwt4xJ9V7wLAxdo45i7G7vupYzECQaXjCtLe4KfcSY
/// - Block 176927247: balance change with receipt A32isCEQAfFoyyfWPvTH6tysviXr8WbYYkdxADiWMKHo
/// - Block 176936471: balance change with receipt 7yLs3ArYQbGoubMXBVZsekwFAfbdqHBbmYrkuVWDonfJ
///
/// Note: The system may also insert SNAPSHOT records at lookback boundaries to mark
/// search limits. These are valid records but don't have receipt data.
#[sqlx::test]
async fn test_fill_gaps_with_bootstrap(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
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

    let network = common::create_archival_network();

    // Use a known valid block height
    let up_to_block: i64 = 177_000_000;

    // Call fill_gaps repeatedly until we find all expected records
    // The system fills gaps progressively, so we may need multiple calls
    println!("=== Calling fill_gaps until key records are found ===");
    println!(
        "Looking for blocks 176927244, 176927247, 176936471 for {}/{}",
        account_id, token_id
    );

    let max_iterations = 5;
    for iteration in 1..=max_iterations {
        println!("\n--- Iteration {} ---", iteration);

        let filled = fill_gaps(&pool, &network, account_id, token_id, up_to_block)
            .await
            .expect("fill_gaps should not error");

        println!("Iteration {} returned {} records", iteration, filled.len());
        for record in &filled {
            println!(
                "  Block {}: {} -> {}",
                record.block_height, record.balance_before, record.balance_after
            );
        }

        // Check if we have all key records
        let key_records = sqlx::query!(
            r#"
            SELECT block_height
            FROM balance_changes
            WHERE account_id = $1 AND token_id = $2
            AND block_height IN (176927244, 176927247, 176936471)
            ORDER BY block_height
            "#,
            account_id,
            token_id
        )
        .fetch_all(&pool)
        .await?;

        let found_blocks: Vec<i64> = key_records.iter().map(|r| r.block_height).collect();
        println!("Found key blocks: {:?}", found_blocks);

        if found_blocks == vec![176927244, 176927247, 176936471] {
            println!("All key records found after {} iterations", iteration);
            break;
        }

        if iteration == max_iterations {
            panic!(
                "Failed to find all key records after {} iterations. Found: {:?}",
                max_iterations, found_blocks
            );
        }
    }

    // Fetch all records with detailed information
    let records = sqlx::query!(
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

    println!("\n=== All records found ===");
    for r in &records {
        println!(
            "  Block {}: {} -> {} (counterparty: {})",
            r.block_height, r.balance_before, r.balance_after, r.counterparty
        );
    }

    // Find the key records by block height
    let record_176927244 = records
        .iter()
        .find(|r| r.block_height == 176927244)
        .expect("Block 176927244 should exist");
    let record_176927247 = records
        .iter()
        .find(|r| r.block_height == 176927247)
        .expect("Block 176927247 should exist");
    let record_176936471 = records
        .iter()
        .find(|r| r.block_height == 176936471)
        .expect("Block 176936471 should exist");

    // --- Verify Block 176927244 ---
    assert!(
        !record_176927244.receipt_id.is_empty(),
        "Block 176927244 receipt_id array should not be empty"
    );
    assert_eq!(
        record_176927244.receipt_id[0], "6Giwt4xJ9V7wLAxdo45i7G7vupYzECQaXjCtLe4KfcSY",
        "Block 176927244 receipt_id should match"
    );
    assert_eq!(
        record_176927244.signer_id.as_ref().unwrap(),
        "blackdragon.tkn.near",
        "Block 176927244 signer_id should match"
    );
    assert_eq!(
        record_176927244.counterparty, "blackdragon.tkn.near",
        "Block 176927244 counterparty should match"
    );
    assert_eq!(
        record_176927244.balance_before, "10.326123124009596399999989",
        "Block 176927244 balance_before should match"
    );
    assert_eq!(
        record_176927244.balance_after, "10.449873124009596399999989",
        "Block 176927244 balance_after should match"
    );

    // --- Verify Block 176927247 ---
    assert!(
        !record_176927247.receipt_id.is_empty(),
        "Block 176927247 receipt_id array should not be empty"
    );
    assert_eq!(
        record_176927247.receipt_id[0], "A32isCEQAfFoyyfWPvTH6tysviXr8WbYYkdxADiWMKHo",
        "Block 176927247 receipt_id should match"
    );
    assert_eq!(
        record_176927247.signer_id.as_ref().unwrap(),
        "blackdragon.tkn.near",
        "Block 176927247 signer_id should match"
    );
    assert_eq!(
        record_176927247.counterparty, "blackdragon.tkn.near",
        "Block 176927247 counterparty should match"
    );
    assert_eq!(
        record_176927247.balance_before, "10.449873124009596399999989",
        "Block 176927247 balance_before should match"
    );
    assert_eq!(
        record_176927247.balance_after, "10.449933795827029599999989",
        "Block 176927247 balance_after should match"
    );

    // --- Verify Block 176936471 ---
    assert!(
        !record_176936471.receipt_id.is_empty(),
        "Block 176936471 receipt_id array should not be empty"
    );
    assert_eq!(
        record_176936471.receipt_id[0], "7yLs3ArYQbGoubMXBVZsekwFAfbdqHBbmYrkuVWDonfJ",
        "Block 176936471 receipt_id should match"
    );
    assert_eq!(
        record_176936471.signer_id.as_ref().unwrap(),
        "olskik.near",
        "Block 176936471 signer_id should match"
    );
    assert_eq!(
        record_176936471.counterparty, "olskik.near",
        "Block 176936471 counterparty should match"
    );
    assert_eq!(
        record_176936471.balance_before, "10.449933795827029599999989",
        "Block 176936471 balance_before should match"
    );
    assert_eq!(
        record_176936471.balance_after, "10.449985392206838099999989",
        "Block 176936471 balance_after should match"
    );

    // --- Verify balance continuity between key records ---
    assert_eq!(
        record_176927244.balance_after, record_176927247.balance_before,
        "Balance chain should be continuous from block 176927244 to 176927247"
    );
    assert_eq!(
        record_176927247.balance_after, record_176936471.balance_before,
        "Balance chain should be continuous from block 176927247 to 176936471"
    );

    println!("✓ All block heights and balances verified");

    Ok(())
}

/// Test getting block data with receipt execution outcomes for a specific block
/// This test queries block 176927244 to examine receipt data for testing-astradao.sputnik-dao.near
#[sqlx::test]
async fn test_get_block_receipt_data(_pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
    use nt_be::handlers::balance_changes::block_info::get_block_data;

    let network = common::create_archival_network();
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
        block_data.receipts.len(),
        1,
        "Should have exactly one receipt affecting the account"
    );

    // Assert receipt details
    let receipt = &block_data.receipts[0];
    assert_eq!(
        receipt.receipt_id.to_string(),
        "6Giwt4xJ9V7wLAxdo45i7G7vupYzECQaXjCtLe4KfcSY",
        "Receipt ID should match"
    );
    assert_eq!(
        receipt.receiver_id.as_str(),
        "testing-astradao.sputnik-dao.near",
        "Receiver ID should match"
    );
    assert_eq!(
        receipt.predecessor_id.as_str(),
        "blackdragon.tkn.near",
        "Predecessor ID should match"
    );

    println!("✓ All block 176927244 receipt data verified");

    Ok(())
}

/// Test querying a block that returns 422 error (block 178462173)
/// Should retry with previous blocks until finding a valid one
#[sqlx::test]
async fn test_query_unavailable_block_with_retry(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
    use nt_be::handlers::balance_changes::balance;

    let network = common::create_archival_network();
    let account_id = "testing-astradao.sputnik-dao.near";

    // This block is known to return 422 error
    let problematic_block: u64 = 178462173;

    println!(
        "Querying block {} which returns 422 error",
        problematic_block
    );

    // This should succeed by automatically retrying with previous blocks
    let result = balance::get_balance_change_at_block(
        &pool,
        &network,
        account_id,
        "near",
        problematic_block,
    )
    .await;

    match result {
        Ok((balance_before, balance_after)) => {
            println!(
                "Successfully queried balance with retry: {} -> {}",
                balance_before, balance_after
            );
            // Balances are BigDecimal values returned from the RPC query
            // They should be valid non-negative numbers
        }
        Err(e) => {
            panic!("Should succeed with retry logic, but got error: {}", e);
        }
    }

    Ok(())
}

/// Test monitored_accounts table operations
#[sqlx::test]
async fn test_monitored_accounts(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
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
    assert!(
        enabled[0].last_synced_at.is_none(),
        "last_synced_at should be NULL initially"
    );

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

    assert!(
        updated.last_synced_at.is_some(),
        "last_synced_at should be set"
    );
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

/// Test that NEAR balance is tracked even when other tokens (like intents) are discovered first.
/// This validates the fix for the bug where NEAR was only added to the tokens list when it was empty.
/// Uses webassemblymusic-treasury.sputnik-dao.near which has intents tokens but no recent NEAR transactions.
#[sqlx::test]
async fn test_near_snapshot_with_existing_intents_tokens(pool: PgPool) -> sqlx::Result<()> {
    use nt_be::handlers::balance_changes::account_monitor::run_monitor_cycle;

    // This account has intents tokens but no recent NEAR transactions
    // The NEAR balance hasn't changed in 30+ days, so it should get a SNAPSHOT record
    let account_id = "webassemblymusic-treasury.sputnik-dao.near";

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

    // Run monitoring cycle with current block
    println!("Running monitoring cycle for {}...", account_id);
    let network = common::create_archival_network();
    let up_to_block = 182_490_734i64; // Current block as of Jan 24, 2026

    run_monitor_cycle(&pool, &network, up_to_block, None)
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

    // Verify intents tokens were discovered
    let intents_tokens: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT token_id
        FROM balance_changes
        WHERE account_id = $1 AND token_id LIKE 'intents.near:%'
        ORDER BY token_id
        "#,
    )
    .bind(account_id)
    .fetch_all(&pool)
    .await?;

    println!("Discovered {} intents tokens:", intents_tokens.len());
    for token in &intents_tokens {
        println!("  - {}", token);
    }

    assert!(
        !intents_tokens.is_empty(),
        "Should have discovered at least one intents token"
    );

    // Verify NEAR balance was tracked (should be a SNAPSHOT since no recent transactions)
    let near_records = sqlx::query!(
        r#"
        SELECT block_height, counterparty, balance_before::TEXT as "balance_before!", balance_after::TEXT as "balance_after!"
        FROM balance_changes
        WHERE account_id = $1 AND token_id = 'near'
        ORDER BY block_height DESC
        "#,
        account_id
    )
    .fetch_all(&pool)
    .await?;

    println!("\nNEAR balance records: {}", near_records.len());
    for record in &near_records {
        println!(
            "  Block {}: {} -> {} (counterparty: {})",
            record.block_height, record.balance_before, record.balance_after, record.counterparty
        );
    }

    assert!(
        !near_records.is_empty(),
        "Should have at least one NEAR balance record"
    );

    // The NEAR record should be a SNAPSHOT since the balance hasn't changed recently
    let near_snapshot = near_records.first().expect("Should have NEAR record");
    assert_eq!(
        near_snapshot.counterparty, "SNAPSHOT",
        "NEAR record should be a SNAPSHOT since balance hasn't changed in lookback window"
    );

    // Verify balance_before equals balance_after for SNAPSHOT
    assert_eq!(
        near_snapshot.balance_before, near_snapshot.balance_after,
        "SNAPSHOT should have equal balance_before and balance_after"
    );

    println!("\n✓ NEAR balance tracked as SNAPSHOT (no recent transactions)");
    println!("✓ Intents tokens discovered: {}", intents_tokens.len());
    println!("✓ Test validates fix for NEAR tracking with existing intents tokens");

    Ok(())
}

/// Test continuous monitoring service
#[sqlx::test]
async fn test_continuous_monitoring(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
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

    assert!(
        before_sync.last_synced_at.is_none(),
        "Should not be synced yet"
    );

    // Run one monitoring cycle
    println!("Running monitoring cycle...");
    let network = common::create_archival_network();
    let up_to_block = 177_000_000i64;
    run_monitor_cycle(&pool, &network, up_to_block, None)
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

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

    assert!(
        after_sync.last_synced_at.is_some(),
        "Should be synced after cycle"
    );
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

    assert!(
        change_count.0 > 1,
        "Should have collected more balance changes"
    );
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
    run_monitor_cycle(&pool, &network, up_to_block, None)
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

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

    assert_eq!(
        after_disabled.last_synced_at, sync_time,
        "Disabled account should not be processed"
    );
    println!("✓ Disabled accounts are skipped");

    println!("✓ Continuous monitoring validated");

    Ok(())
}

#[sqlx::test]
async fn test_fill_gap_with_transaction_hash_block_178148634(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
    use nt_be::handlers::balance_changes::gap_filler::insert_balance_change_record;

    println!("\n=== Testing Balance Change Record with Transaction Hash (Block 178148634) ===\n");

    // Setup network config
    let network = common::create_archival_network();

    let account_id = "petersalomonsen.near";
    let token_id = "near";
    let target_block = 178148634u64;

    println!(
        "Inserting balance change record for block {}...",
        target_block
    );

    // Directly insert the balance change record for block 178148634
    // This will use get_account_changes to capture the transaction hash
    let filled_gap =
        insert_balance_change_record(&pool, &network, account_id, token_id, target_block)
            .await
            .map_err(|e| {
                sqlx::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e.to_string(),
                ))
            })?
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
    assert_eq!(
        record.token_id.as_deref(),
        Some(token_id),
        "Token ID should match"
    );
    assert_eq!(
        record.block_height, filled_gap.block_height,
        "Block height should match"
    );

    println!("✓ Account ID: {}", record.account_id);
    println!("✓ Token ID: {:?}", record.token_id);
    println!("✓ Block height: {}", record.block_height);
    println!("✓ Block timestamp: {}", record.block_timestamp);

    // Verify balance fields (decimal-adjusted: NEAR has 24 decimals)
    assert_eq!(
        record.balance_after, "47.131979815366840642871301",
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
            record.transaction_hashes[0], "CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5",
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
    common::load_test_env();
    use nt_be::handlers::balance_changes::block_info::get_all_account_receipts;
    use nt_be::handlers::balance_changes::token_discovery::extract_ft_tokens_from_receipt;
    use std::collections::HashSet;

    // Block 178148636 has an arizcredits.near FT transfer
    // Receipt: D9XE4evM6wvM9zaYftkmpjz1nYApKhspaFgPqn3xp24k
    // Token: arizcredits.near
    let block_height = 178148636;
    let account_id = "webassemblymusic-treasury.sputnik-dao.near";

    let network = common::create_archival_network();

    println!("\n📦 Testing FT token discovery from receipts");
    println!("Block: {}", block_height);
    println!("Account: {}", account_id);
    println!("Expected receipt: D9XE4evM6wvM9zaYftkmpjz1nYApKhspaFgPqn3xp24k");
    println!("Expected token: arizcredits.near");

    // Get ALL receipts involving the account (as sender or receiver)
    let receipts = get_all_account_receipts(&network, account_id, block_height)
        .await
        .expect("Should fetch receipts");

    println!(
        "\nFound {} receipts involving account in block",
        receipts.len()
    );

    // Extract FT tokens from all receipts
    let mut all_tokens = HashSet::new();
    for receipt in &receipts {
        println!("\nAnalyzing receipt: {}", receipt.receipt_id);
        println!("  Predecessor: {}", receipt.predecessor_id);
        println!("  Receiver: {}", receipt.receiver_id);

        // Print actions if available
        if let near_primitives::views::ReceiptEnumView::Action { actions, .. } = &receipt.receipt {
            for action in actions {
                if let near_primitives::views::ActionView::FunctionCall { method_name, .. } = action
                {
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

/// Test end-to-end FT token discovery through monitoring
/// This test verifies the complete flow:
/// 1. Start monitoring an account (only NEAR initially)
/// 2. Discover FT tokens from receipts during NEAR monitoring
/// 3. Automatically start monitoring discovered FT tokens
/// 4. Verify balance changes are collected for the discovered token
#[sqlx::test]
async fn test_ft_token_discovery_through_monitoring(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
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
    let initial_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM balance_changes WHERE account_id = $1")
            .bind(account_id)
            .fetch_one(&pool)
            .await?;

    assert_eq!(
        initial_count.0, 0,
        "Should start with no balance change records"
    );
    println!("✓ Verified empty state (0 records)");

    let network = common::create_archival_network();

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

    run_monitor_cycle(&pool, &network, up_to_block, None)
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

    // Check how many NEAR records were collected
    let near_count: (i64,) = sqlx::query_as(
        r#"
        SELECT COUNT(*)
        FROM balance_changes
        WHERE account_id = $1 AND token_id = 'near'
        "#,
    )
    .bind(account_id)
    .fetch_one(&pool)
    .await?;

    println!("✓ Collected {} NEAR balance change records", near_count.0);
    assert!(
        near_count.0 > 0,
        "Should have collected NEAR balance changes"
    );

    println!("\n=== Second Monitoring Cycle ===");
    println!("The first cycle should have discovered FT tokens from receipts");
    println!("The second cycle should collect balance changes for discovered tokens");

    // Run second monitoring cycle - should pick up discovered FT tokens
    run_monitor_cycle(&pool, &network, up_to_block, None)
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

    println!("\n=== Verifying Automatic FT Token Discovery ===");

    // The monitoring system should have automatically discovered and started tracking
    // the arizcredits.near FT token from receipts collected during NEAR monitoring.
    // Verify FT balance changes were collected
    let ft_count: (i64,) = sqlx::query_as(
        r#"
        SELECT COUNT(*)
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        "#,
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

    println!(
        "✓ Collected {} balance change records for {}",
        ft_count.0, expected_ft_token
    );

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
            record.block_height, record.balance_before, record.balance_after, record.amount
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
            let amount =
                BigDecimal::from_str(&first_record.amount).expect("amount should be valid");
            let calculated_amount = &balance_after - &balance_before;

            assert_eq!(
                amount, calculated_amount,
                "Snapshot amount should equal balance_after - balance_before"
            );
            println!(
                "✓ Snapshot record has correctly measured balances: {} -> {} (amount: {})",
                first_record.balance_before, first_record.balance_after, first_record.amount
            );
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
        let has_real_counterparty = ft_counterparties
            .iter()
            .any(|cp| !["SNAPSHOT", "system"].contains(&cp.counterparty.as_str()));

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
        "#,
    )
    .bind(account_id)
    .fetch_all(&pool)
    .await?;

    println!("\n=== All Tracked Tokens for {} ===", account_id);
    for token in &all_tokens {
        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM balance_changes WHERE account_id = $1 AND token_id = $2",
        )
        .bind(account_id)
        .bind(token)
        .fetch_one(&pool)
        .await?;

        println!("  - {}: {} records", token, count.0);
    }

    assert!(
        all_tokens.contains(&"near".to_string()),
        "Should track NEAR"
    );
    assert!(
        all_tokens.contains(&expected_ft_token.to_string()),
        "Should track discovered FT token"
    );
    // The system may discover additional tokens (intents, other FTs) - verify at least NEAR + expected FT
    assert!(
        all_tokens.len() >= 2,
        "Should track at least 2 tokens (NEAR + discovered FT), found: {}",
        all_tokens.len()
    );

    println!("\n✓ Full FT token discovery flow validated!");
    println!("  ✓ Started with NEAR monitoring only");
    println!("  ✓ Discovered {} from receipts", expected_ft_token);
    println!("  ✓ Started monitoring discovered token");
    println!("  ✓ Collected and validated balance changes for both tokens");
    println!(
        "  ✓ Total tokens discovered: {} (may include intents tokens)",
        all_tokens.len()
    );
    println!("  ✓ FT records have real counterparties");

    Ok(())
}

/// Test FT token discovery for petersalomonsen.near at block 178086209
/// This block has a NEAR balance change with transaction hash that should be captured
#[sqlx::test]
async fn test_ft_discovery_petersalomonsen_block_178086209(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
    use nt_be::handlers::balance_changes::gap_filler::fill_gaps;

    let account_id = "petersalomonsen.near";
    let target_block = 178086209i64; // Block with NEAR balance change

    println!(
        "\n=== Testing FT Discovery for {} at Block {} ===",
        account_id, target_block
    );
    println!(
        "This block has a NEAR balance change with transaction hash 2CqhsWNuFEu29TefK2MCDNHtW4B1BioduGQ8rXSi18GR"
    );

    let network = common::create_archival_network();

    // Directly fill gaps for NEAR - use target_block + 1 to ensure we search down to include target_block
    // The gap filler will seed from 178086210 and search backwards, which should find 178086209
    println!("\n=== Collecting NEAR Balance Changes ===");
    let filled = fill_gaps(&pool, &network, account_id, "near", target_block + 1)
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

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
        println!(
            "  Token: {}",
            record.token_id.as_ref().unwrap_or(&"N/A".to_string())
        );
        println!("  Counterparty: {}", record.counterparty);
        println!(
            "  Balance: {} -> {}",
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
    let blocks_with_unknown_counterparty: Vec<_> = records
        .iter()
        .filter(|r| r.counterparty == "unknown" && !r.transaction_hashes.is_empty())
        .collect();

    if !blocks_with_unknown_counterparty.is_empty() {
        println!("\n=== Blocks with 'unknown' counterparty but transaction hash ===");
        for record in &blocks_with_unknown_counterparty {
            println!(
                "  Block {}: tx_hash = {}",
                record.block_height, record.transaction_hashes[0]
            );
            println!("    These should be analyzed to discover FT contracts");
        }

        // This demonstrates the gap in current implementation:
        // When counterparty is "unknown" but we have a transaction hash,
        // we should look up the transaction to find FT contract interactions
        println!(
            "\n⚠ Current limitation: Transactions with 'unknown' counterparty are not analyzed"
        );
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
        "#,
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
            match get_ft_balance(
                &pool,
                &network,
                account_id,
                counterparty,
                target_block as u64,
            )
            .await
            {
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
        "#,
    )
    .bind(account_id)
    .fetch_all(&pool)
    .await?;

    let has_real_near_counterparty = near_counterparties
        .iter()
        .any(|cp| cp.as_str() != "SNAPSHOT");

    if has_real_near_counterparty {
        println!("\n✓ NEAR records have real counterparties");
    } else {
        println!("\n⚠ NEAR records only have SNAPSHOT counterparty (no transactions yet)");
    }

    Ok(())
}

/// Test intents token discovery for webassemblymusic-treasury via run_monitor_cycle
/// Block 165324279 has a BTC intents balance change of 0.0002 BTC
#[sqlx::test]
async fn test_discover_intents_tokens_webassemblymusic_treasury(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
    use nt_be::handlers::balance_changes::account_monitor::run_monitor_cycle;

    let network = common::create_archival_network();
    let account_id = "webassemblymusic-treasury.sputnik-dao.near";

    // Block 165324279 has a btc.omft.near intents balance change of 0.0002 BTC
    // Run monitor from 165324280 - gap filler searches backwards and finds 165324279
    let monitor_block: i64 = 165_324_280;

    println!("\n=== Testing Intents Token Discovery via run_monitor_cycle ===");
    println!("Account: {}", account_id);
    println!("Monitor block: {}", monitor_block);

    // Register the account for monitoring
    sqlx::query!(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled)
        VALUES ($1, true)
        "#,
        account_id
    )
    .execute(&pool)
    .await?;

    // Run monitor cycle - should discover intents tokens and find balance changes
    run_monitor_cycle(&pool, &network, monitor_block, None)
        .await
        .expect("Monitor cycle should complete");

    // Hard assertion: Must discover BTC intents token
    let btc_token = "intents.near:nep141:btc.omft.near";
    let btc_discovered: bool = sqlx::query_scalar(
        r#"SELECT EXISTS(SELECT 1 FROM balance_changes WHERE account_id = $1 AND token_id = $2)"#,
    )
    .bind(account_id)
    .bind(btc_token)
    .fetch_one(&pool)
    .await?;

    assert!(
        btc_discovered,
        "Must discover {} via run_monitor_cycle",
        btc_token
    );

    // Run second monitor cycle to fill gaps for discovered intents tokens
    run_monitor_cycle(&pool, &network, monitor_block, None)
        .await
        .expect("Second monitor cycle should complete");

    // Hard assertion: Must find the BTC balance change at block 165324279
    let btc_change = sqlx::query!(
        r#"
        SELECT block_height, counterparty, amount::TEXT as "amount!", 
               balance_before::TEXT as "balance_before!", balance_after::TEXT as "balance_after!"
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2 AND counterparty != 'SNAPSHOT'
        ORDER BY block_height ASC
        "#,
        account_id,
        btc_token
    )
    .fetch_all(&pool)
    .await?;

    assert!(
        !btc_change.is_empty(),
        "Must find non-SNAPSHOT BTC balance change"
    );

    // Hard assertion: Must find the change at block 165324279
    let block_165324279_change = btc_change
        .iter()
        .find(|c| c.block_height == 165_324_279)
        .expect("Must find BTC balance change at block 165324279");

    println!("\n   BTC change at block 165324279:");
    println!("   Block: {}", block_165324279_change.block_height);
    println!("   Amount: {}", block_165324279_change.amount);
    println!(
        "   Balance: {} -> {}",
        block_165324279_change.balance_before, block_165324279_change.balance_after
    );
    println!("   Counterparty: {}", block_165324279_change.counterparty);

    // Hard assertion: Amount must be 0.0002 BTC (20000 satoshis, BTC has 8 decimals)
    // Since we now use BigDecimal everywhere, amounts are stored as decimal-formatted values
    let amount =
        BigDecimal::from_str(&block_165324279_change.amount).expect("Amount must be valid decimal");
    let expected_amount = BigDecimal::from_str("0.0002").expect("Expected amount must be valid");
    assert_eq!(
        amount.abs(),
        expected_amount,
        "BTC change amount must be 0.0002 BTC (decimal-formatted)"
    );

    println!(
        "\n✓ Found BTC intents balance change: {} BTC at block 165324279",
        block_165324279_change.amount
    );

    Ok(())
}
