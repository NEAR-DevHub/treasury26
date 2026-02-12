//! Integration tests for staking rewards tracking
//!
//! These tests verify the staking pool balance query and snapshot insertion functionality.

mod common;

use bigdecimal::BigDecimal;
use nt_be::handlers::balance_changes::balance::staking::{
    block_to_epoch, epoch_to_block, get_staking_balance_at_block, is_staking_pool,
};
use nt_be::handlers::balance_changes::staking_rewards::{
    STAKING_REWARD_COUNTERPARTY, STAKING_SNAPSHOT_COUNTERPARTY, discover_staking_pools,
    extract_staking_pool, find_staking_gaps, insert_staking_reward, insert_staking_snapshot,
    is_staking_token, staking_token_id, track_staking_rewards,
};
use sqlx::{PgPool, Row};

/// Test querying staking pool balance for a known staking account
#[sqlx::test]
async fn test_query_staking_balance(_pool: PgPool) -> sqlx::Result<()> {
    let network = common::create_archival_network();

    // Use a known account that has staked with astro-stakers.poolv1.near
    // webassemblymusic-treasury has historical staking activity
    let account_id = "webassemblymusic-treasury.sputnik-dao.near";
    let staking_pool = "astro-stakers.poolv1.near";

    // Use a block where we know there's staked balance (from test data)
    let block_height: u64 = 161_048_666;

    println!(
        "Querying staking balance for {}/{} at block {}",
        account_id, staking_pool, block_height
    );

    let balance = get_staking_balance_at_block(&network, account_id, staking_pool, block_height)
        .await
        .expect("Should query staking balance");

    println!("Staking balance: {} NEAR", balance);

    // webassemblymusic-treasury should have some staked balance
    assert!(balance > 0, "Should have non-zero staking balance");

    Ok(())
}

/// Test epoch calculation functions
#[sqlx::test]
async fn test_epoch_calculations(_pool: PgPool) -> sqlx::Result<()> {
    // Test block to epoch conversion
    assert_eq!(block_to_epoch(0), 0, "Block 0 should be epoch 0");
    assert_eq!(
        block_to_epoch(43_199),
        0,
        "Block 43199 should still be epoch 0"
    );
    assert_eq!(block_to_epoch(43_200), 1, "Block 43200 should be epoch 1");

    // Test epoch to block conversion
    assert_eq!(epoch_to_block(0), 0, "Epoch 0 starts at block 0");
    assert_eq!(epoch_to_block(1), 43_200, "Epoch 1 starts at block 43200");

    // Test round-trip
    let test_block: u64 = 177_000_000;
    let epoch = block_to_epoch(test_block);
    let epoch_start = epoch_to_block(epoch);
    assert!(
        epoch_start <= test_block,
        "Epoch start should be <= original block"
    );
    assert!(
        epoch_start + 43_200 > test_block,
        "Next epoch start should be > original block"
    );

    println!(
        "Block {} is in epoch {} (starts at block {})",
        test_block, epoch, epoch_start
    );

    Ok(())
}

/// Test staking pool detection patterns
#[sqlx::test]
async fn test_staking_pool_patterns(_pool: PgPool) -> sqlx::Result<()> {
    // Valid staking pool patterns
    assert!(
        is_staking_pool("aurora.poolv1.near"),
        "aurora.poolv1.near should be detected"
    );
    assert!(
        is_staking_pool("kiln.poolv1.near"),
        "kiln.poolv1.near should be detected"
    );
    assert!(
        is_staking_pool("meta-pool.pool.near"),
        "meta-pool.pool.near should be detected"
    );
    assert!(
        is_staking_pool("some-validator.pool.near"),
        "some-validator.pool.near should be detected"
    );

    // Not staking pools
    assert!(
        !is_staking_pool("wrap.near"),
        "wrap.near should not be detected"
    );
    assert!(
        !is_staking_pool("usdt.tether-token.near"),
        "usdt.tether-token.near should not be detected"
    );
    assert!(
        !is_staking_pool("example.near"),
        "example.near should not be detected"
    );
    assert!(
        !is_staking_pool("pool.near"),
        "pool.near alone should not be detected"
    );

    println!("✓ Staking pool pattern detection working correctly");

    Ok(())
}

/// Test staking token ID format
#[sqlx::test]
async fn test_staking_token_format(_pool: PgPool) -> sqlx::Result<()> {
    // Test token_id creation
    assert_eq!(
        staking_token_id("aurora.poolv1.near"),
        "staking:aurora.poolv1.near"
    );
    assert_eq!(
        staking_token_id("kiln.poolv1.near"),
        "staking:kiln.poolv1.near"
    );

    // Test extraction
    assert_eq!(
        extract_staking_pool("staking:aurora.poolv1.near"),
        Some("aurora.poolv1.near")
    );
    assert_eq!(extract_staking_pool("NEAR"), None);
    assert_eq!(extract_staking_pool("wrap.near"), None);

    // Test detection
    assert!(is_staking_token("staking:aurora.poolv1.near"));
    assert!(!is_staking_token("NEAR"));
    assert!(!is_staking_token("aurora.poolv1.near")); // Pool address alone is not a token_id

    println!("✓ Staking token ID format working correctly");

    Ok(())
}

/// Test inserting staking snapshot records
#[sqlx::test]
async fn test_insert_staking_snapshot(pool: PgPool) -> sqlx::Result<()> {
    let network = common::create_archival_network();

    let account_id = "webassemblymusic-treasury.sputnik-dao.near";
    let staking_pool = "astro-stakers.poolv1.near";
    let block_height: u64 = 161_048_666;

    println!(
        "Inserting staking snapshot for {}/{} at block {}",
        account_id, staking_pool, block_height
    );

    let result = insert_staking_snapshot(&pool, &network, account_id, staking_pool, block_height)
        .await
        .expect("Should insert staking snapshot");

    assert!(result.is_some(), "Should return inserted balance");
    let balance = result.unwrap();
    println!("Inserted snapshot with balance: {} NEAR", balance);

    // Verify the record was inserted
    let token_id = staking_token_id(staking_pool);
    let record = sqlx::query(
        r#"
        SELECT
            account_id, token_id, block_height, counterparty,
            balance_before::TEXT as balance_before,
            balance_after::TEXT as balance_after,
            transaction_hashes, raw_data
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2 AND block_height = $3
        "#,
    )
    .bind(account_id)
    .bind(&token_id)
    .bind(block_height as i64)
    .fetch_one(&pool)
    .await?;

    let record_account_id: String = record.get("account_id");
    let record_token_id: Option<String> = record.get("token_id");
    let record_counterparty: String = record.get("counterparty");
    let record_transaction_hashes: Vec<String> = record.get("transaction_hashes");
    let raw_data: Option<serde_json::Value> = record.get("raw_data");

    assert_eq!(record_account_id, account_id);
    assert_eq!(record_token_id.as_deref(), Some(token_id.as_str()));
    assert_eq!(record_counterparty, STAKING_SNAPSHOT_COUNTERPARTY);
    assert!(
        record_transaction_hashes.is_empty(),
        "Staking snapshots should have empty transaction_hashes"
    );

    // Verify raw_data contains epoch metadata
    let raw_data = raw_data.expect("Should have raw_data");
    assert!(
        raw_data.get("epoch").is_some(),
        "Should have epoch in raw_data"
    );
    assert!(
        raw_data.get("staking_pool").is_some(),
        "Should have staking_pool in raw_data"
    );

    let balance_before: String = record.get("balance_before");
    let balance_after: String = record.get("balance_after");

    println!("✓ Staking snapshot inserted with correct fields");
    println!("  Counterparty: {}", record_counterparty);
    println!("  Balance before: {}", balance_before);
    println!("  Balance after: {}", balance_after);
    println!("  Raw data epoch: {}", raw_data.get("epoch").unwrap());

    Ok(())
}

/// Test staking pool discovery from counterparties
#[sqlx::test]
async fn test_discover_staking_pools_from_counterparties(pool: PgPool) -> sqlx::Result<()> {
    let account_id = "test-discovery-account.near";

    // Insert some test balance_changes records with staking pool counterparties
    sqlx::query(
        r#"
        INSERT INTO balance_changes
        (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, transaction_hashes, receipt_id, counterparty, actions, raw_data)
        VALUES
        ($1, 'near', 100, 1000000000000, NOW(), 1, 0, 1, '{}', '{}', 'aurora.poolv1.near', '{}', '{}'),
        ($1, 'near', 101, 1000000001000, NOW(), 1, 1, 2, '{}', '{}', 'kiln.poolv1.near', '{}', '{}'),
        ($1, 'near', 102, 1000000002000, NOW(), 1, 2, 3, '{}', '{}', 'wrap.near', '{}', '{}'),
        ($1, 'near', 103, 1000000003000, NOW(), 1, 3, 4, '{}', '{}', 'SNAPSHOT', '{}', '{}')
        "#
    )
    .bind(account_id)
    .execute(&pool)
    .await?;

    // Discover staking pools
    let pools = discover_staking_pools(&pool, account_id)
        .await
        .expect("Should discover staking pools");

    println!("Discovered staking pools: {:?}", pools);

    // Should find the two staking pools, not wrap.near or SNAPSHOT
    assert!(
        pools.contains("aurora.poolv1.near"),
        "Should discover aurora.poolv1.near"
    );
    assert!(
        pools.contains("kiln.poolv1.near"),
        "Should discover kiln.poolv1.near"
    );
    assert!(!pools.contains("wrap.near"), "Should not include wrap.near");
    assert!(!pools.contains("SNAPSHOT"), "Should not include SNAPSHOT");
    assert_eq!(pools.len(), 2, "Should have exactly 2 staking pools");

    println!("✓ Staking pool discovery working correctly");

    Ok(())
}

/// Test full staking rewards tracking flow
#[sqlx::test]
async fn test_track_staking_rewards_flow(pool: PgPool) -> sqlx::Result<()> {
    let network = common::create_archival_network();

    let account_id = "webassemblymusic-treasury.sputnik-dao.near";
    let staking_pool = "astro-stakers.poolv1.near";

    // Insert a NEAR balance change with staking pool as counterparty
    // This simulates the account having interacted with the staking pool
    sqlx::query(
        r#"
        INSERT INTO balance_changes
        (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, transaction_hashes, receipt_id, counterparty, actions, raw_data)
        VALUES ($1, 'near', 161048666, 1700000000000000000, NOW(), 10, 100, 110, '{}', '{}', $2, '{}', '{}')
        "#
    )
    .bind(account_id)
    .bind(staking_pool)
    .execute(&pool)
    .await?;

    // Track staking rewards - use epoch boundary after the transaction
    // Epoch 3728 starts at block 161049600 (next epoch after the staking interaction)
    let up_to_block: i64 = 161_049_600;
    let snapshots_created = track_staking_rewards(&pool, &network, account_id, up_to_block)
        .await
        .expect("Should track staking rewards");

    println!("Created {} staking snapshots", snapshots_created);

    // Verify staking snapshot was created
    let token_id = staking_token_id(staking_pool);
    let snapshot_exists: bool = sqlx::query_scalar(
        r#"SELECT EXISTS(SELECT 1 FROM balance_changes WHERE account_id = $1 AND token_id = $2)"#,
    )
    .bind(account_id)
    .bind(&token_id)
    .fetch_one(&pool)
    .await?;

    assert!(
        snapshot_exists,
        "Should have created staking snapshot for {}",
        token_id
    );

    // Query the snapshot details
    let snapshot = sqlx::query(
        r#"
        SELECT counterparty, raw_data
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        LIMIT 1
        "#,
    )
    .bind(account_id)
    .bind(&token_id)
    .fetch_one(&pool)
    .await?;

    let snapshot_counterparty: String = snapshot.get("counterparty");
    assert_eq!(snapshot_counterparty, STAKING_SNAPSHOT_COUNTERPARTY);
    println!("✓ Staking rewards tracking flow working correctly");

    Ok(())
}

/// Test staking balance query with non-existent account
#[sqlx::test]
async fn test_query_nonexistent_staking_balance(_pool: PgPool) -> sqlx::Result<()> {
    let network = common::create_archival_network();

    // Query an account that has never staked with this pool
    let account_id = "nonexistent-staking-account.near";
    let staking_pool = "aurora.poolv1.near";
    let block_height: u64 = 177_000_000;

    let result =
        get_staking_balance_at_block(&network, account_id, staking_pool, block_height).await;

    // The result should be OK with 0 balance (account not registered with pool)
    match result {
        Ok(balance) => {
            assert_eq!(
                balance,
                BigDecimal::from(0),
                "Non-staker should have 0 balance"
            );
            println!("✓ Non-existent staking account returns 0 balance");
        }
        Err(e) => {
            // It's also acceptable to get an error for non-existent accounts
            println!("Got error for non-existent account (acceptable): {}", e);
        }
    }

    Ok(())
}

/// Test that track_staking_rewards prioritizes recent epochs over older ones
///
/// Scenario: Existing snapshots at epochs [3720, 3723, 3725], current epoch 3730
/// Missing: [3721, 3722, 3724, 3726, 3727, 3728, 3729, 3730]
/// Expected: Fill the 5 most recent: [3730, 3729, 3728, 3727, 3726]
///
/// Uses historical epochs that are definitely available on mainnet archival nodes.
#[sqlx::test]
async fn test_track_staking_rewards_prioritizes_recent_epochs(pool: PgPool) -> sqlx::Result<()> {
    let network = common::create_archival_network();

    let account_id = "webassemblymusic-treasury.sputnik-dao.near";
    let staking_pool = "astro-stakers.poolv1.near";
    let token_id = staking_token_id(staking_pool);

    // Use historical epochs that are definitely available
    // Epoch 3720 = block 160,704,000 (historical, definitely exists)
    let first_epoch = 3720u64;
    let current_epoch = 3730u64;

    // First, insert a staking transaction so the pool is discovered
    let first_tx_block = epoch_to_block(first_epoch);
    sqlx::query(
        r#"
        INSERT INTO balance_changes
        (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, transaction_hashes, receipt_id, counterparty, actions, raw_data)
        VALUES ($1, 'NEAR', $2, 1700000000000000000, NOW(), 10, 100, 110, '{}', '{}', $3, '{}', '{}')
        "#
    )
    .bind(account_id)
    .bind(first_tx_block as i64)
    .bind(staking_pool)
    .execute(&pool)
    .await?;

    // Insert existing staking snapshots at epochs 3720, 3723, 3725 (with gaps)
    for epoch in [3720u64, 3723, 3725] {
        let epoch_block = epoch_to_block(epoch);
        sqlx::query(
            r#"
            INSERT INTO balance_changes
            (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, transaction_hashes, receipt_id, counterparty, actions, raw_data)
            VALUES ($1, $2, $3, 1700000000000000000, NOW(), 0, 100, 100, '{}', '{}', 'STAKING_SNAPSHOT', '{}', '{"epoch": 0}')
            "#
        )
        .bind(account_id)
        .bind(&token_id)
        .bind(epoch_block as i64)
        .execute(&pool)
        .await?;
    }

    // Verify initial state: 3 existing snapshots
    let initial_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM balance_changes WHERE account_id = $1 AND token_id = $2",
    )
    .bind(account_id)
    .bind(&token_id)
    .fetch_one(&pool)
    .await?;
    assert_eq!(initial_count, 3, "Should start with 3 existing snapshots");

    // Set current block to epoch 3730 boundary
    let up_to_block = epoch_to_block(current_epoch) as i64;

    println!(
        "Testing with epochs {} to {}, up_to_block={}",
        first_epoch, current_epoch, up_to_block
    );

    // Run track_staking_rewards - should fill up to 5 missing epochs
    let snapshots_created = track_staking_rewards(&pool, &network, account_id, up_to_block)
        .await
        .expect("Should track staking rewards");

    println!("Created {} staking snapshots", snapshots_created);

    // Get all snapshots ordered by block_height descending to see which were created
    let snapshots: Vec<(i64,)> = sqlx::query_as(
        r#"
        SELECT block_height
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height DESC
        "#,
    )
    .bind(account_id)
    .bind(&token_id)
    .fetch_all(&pool)
    .await?;

    let snapshot_epochs: Vec<u64> = snapshots
        .iter()
        .map(|(block,)| block_to_epoch(*block as u64))
        .collect();

    println!("All snapshot epochs (newest first): {:?}", snapshot_epochs);

    // Verify that the most recent epochs were filled first
    // Missing epochs: [3721, 3722, 3724, 3726, 3727, 3728, 3729, 3730]
    // The 5 most recent missing epochs are: 3730, 3729, 3728, 3727, 3726

    // Check that we have the current epoch (3730)
    assert!(
        snapshot_epochs.contains(&current_epoch),
        "Should have filled current epoch {}",
        current_epoch
    );

    // Check that recent epochs were prioritized over older gaps
    let has_3726 = snapshot_epochs.contains(&3726);
    let has_3727 = snapshot_epochs.contains(&3727);
    let has_3728 = snapshot_epochs.contains(&3728);
    let has_3729 = snapshot_epochs.contains(&3729);

    // If we created 5 snapshots, all recent ones should be present
    if snapshots_created >= 5 {
        assert!(has_3726, "Should have epoch 3726");
        assert!(has_3727, "Should have epoch 3727");
        assert!(has_3728, "Should have epoch 3728");
        assert!(has_3729, "Should have epoch 3729");
    }

    // Verify older gaps (3721, 3722, 3724) are NOT filled yet (they come later)
    // They should only be filled in subsequent cycles
    let has_3721 = snapshot_epochs.contains(&3721);
    let has_3722 = snapshot_epochs.contains(&3722);
    let has_3724 = snapshot_epochs.contains(&3724);

    // At least some older epochs should still be missing after first cycle
    let older_gaps_remaining = !has_3721 || !has_3722 || !has_3724;
    assert!(
        older_gaps_remaining || snapshots_created < 5,
        "Older gaps (3721, 3722, 3724) should not all be filled before recent epochs"
    );

    println!("✓ Staking rewards correctly prioritizes recent epochs");
    println!("  Filled epochs: {:?}", snapshot_epochs);
    println!(
        "  Older gaps remaining: 3721={}, 3722={}, 3724={}",
        !has_3721, !has_3722, !has_3724
    );

    Ok(())
}

/// End-to-end test for staking rewards using real monitoring cycles
///
/// This test uses real blockchain data:
/// - Account: webassemblymusic-treasury.sputnik-dao.near
/// - Staking pool: astro-stakers.poolv1.near
/// - Real staking transaction at block 161048663 (epoch 3727)
/// - Staking balance: 1000 NEAR
///
/// The test:
/// 1. Sets up the account as monitored
/// 2. Runs monitor cycles starting a few epochs after the staking transaction
/// 3. Verifies the staking transaction is discovered and staking snapshots are created
/// 4. Runs additional cycles to fill more epochs
/// 5. Asserts exact staking balance amounts
#[sqlx::test]
async fn test_staking_rewards_end_to_end_with_monitor_cycle(pool: PgPool) -> sqlx::Result<()> {
    use nt_be::handlers::balance_changes::account_monitor::run_monitor_cycle;

    let network = common::create_archival_network();

    let account_id = "webassemblymusic-treasury.sputnik-dao.near";
    let staking_pool = "astro-stakers.poolv1.near";
    let token_id = staking_token_id(staking_pool);

    // The real staking transaction is at block 161048663 (epoch 3727)
    // We'll run cycles starting at epoch 3730 to discover it and create snapshots
    let staking_tx_block = 161_048_663i64;
    let staking_tx_epoch = block_to_epoch(staking_tx_block as u64);
    println!(
        "Staking transaction at block {} (epoch {})",
        staking_tx_block, staking_tx_epoch
    );

    // Set up the account as monitored
    sqlx::query(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled, last_synced_at)
        VALUES ($1, true, NULL)
        "#,
    )
    .bind(account_id)
    .execute(&pool)
    .await?;

    // Run first monitor cycle at epoch 3730 (a few epochs after the staking transaction)
    // This should:
    // 1. Seed NEAR balance (which will discover the staking pool as counterparty)
    // 2. Track staking rewards and create snapshots
    let first_cycle_epoch = 3730u64;
    let first_cycle_block = epoch_to_block(first_cycle_epoch) as i64;
    println!(
        "\n=== Running first monitor cycle at block {} (epoch {}) ===",
        first_cycle_block, first_cycle_epoch
    );

    run_monitor_cycle(&pool, &network, first_cycle_block, None, None)
        .await
        .expect("First monitor cycle should succeed");

    // Check if staking snapshots were created
    let snapshots_after_cycle1: Vec<(i64, String, String)> = sqlx::query_as(
        r#"
        SELECT block_height, balance_before::TEXT, balance_after::TEXT
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height
        "#,
    )
    .bind(account_id)
    .bind(&token_id)
    .fetch_all(&pool)
    .await?;

    println!(
        "After cycle 1: {} staking snapshots",
        snapshots_after_cycle1.len()
    );
    for (block, before, after) in &snapshots_after_cycle1 {
        let epoch = block_to_epoch(*block as u64);
        println!(
            "  Epoch {} (block {}): {} -> {}",
            epoch, block, before, after
        );
    }

    // Run a second monitor cycle at a later epoch to fill more snapshots
    let second_cycle_epoch = 3732u64;
    let second_cycle_block = epoch_to_block(second_cycle_epoch) as i64;
    println!(
        "\n=== Running second monitor cycle at block {} (epoch {}) ===",
        second_cycle_block, second_cycle_epoch
    );

    run_monitor_cycle(&pool, &network, second_cycle_block, None, None)
        .await
        .expect("Second monitor cycle should succeed");

    // Check snapshots after second cycle
    let snapshots_after_cycle2: Vec<(i64, String, String)> = sqlx::query_as(
        r#"
        SELECT block_height, balance_before::TEXT, balance_after::TEXT
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height
        "#,
    )
    .bind(account_id)
    .bind(&token_id)
    .fetch_all(&pool)
    .await?;

    println!(
        "After cycle 2: {} staking snapshots",
        snapshots_after_cycle2.len()
    );
    for (block, before, after) in &snapshots_after_cycle2 {
        let epoch = block_to_epoch(*block as u64);
        println!(
            "  Epoch {} (block {}): {} -> {}",
            epoch, block, before, after
        );
    }

    // Run a third monitor cycle to potentially fill more gaps
    let third_cycle_epoch = 3734u64;
    let third_cycle_block = epoch_to_block(third_cycle_epoch) as i64;
    println!(
        "\n=== Running third monitor cycle at block {} (epoch {}) ===",
        third_cycle_block, third_cycle_epoch
    );

    run_monitor_cycle(&pool, &network, third_cycle_block, None, None)
        .await
        .expect("Third monitor cycle should succeed");

    // Final verification: only consider STAKING_SNAPSHOT records here
    let final_snapshots: Vec<(i64, String, String, String)> = sqlx::query_as(
        r#"
        SELECT block_height, balance_before::TEXT, balance_after::TEXT, counterparty
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2 AND counterparty = 'STAKING_SNAPSHOT'
        ORDER BY block_height
        "#,
    )
    .bind(account_id)
    .bind(&token_id)
    .fetch_all(&pool)
    .await?;

    println!("\n=== Final staking snapshots ===");
    println!("Total: {} snapshots", final_snapshots.len());

    // Verify we have staking snapshots
    assert!(
        !final_snapshots.is_empty(),
        "Should have created staking snapshots"
    );

    // All staking snapshots should have STAKING_SNAPSHOT counterparty
    for (block, before, after, counterparty) in &final_snapshots {
        let epoch = block_to_epoch(*block as u64);
        println!(
            "  Epoch {} (block {}): {} -> {} [{}]",
            epoch, block, before, after, counterparty
        );

        assert_eq!(
            counterparty, STAKING_SNAPSHOT_COUNTERPARTY,
            "All staking records should have STAKING_SNAPSHOT counterparty"
        );

        // Verify the balance is approximately 1000 NEAR (the known staking amount)
        // Balance should be >= 1000 (initial stake) and could grow with rewards
        let balance: BigDecimal = after.parse().expect("Should parse balance");
        assert!(
            balance >= 1000,
            "Staking balance should be at least 1000 NEAR, got {}",
            balance
        );
    }

    // Verify exact balances for specific epochs (these are deterministic on-chain values)
    // The staking balance grows with rewards each epoch
    let balance_map: std::collections::HashMap<u64, String> = final_snapshots
        .iter()
        .map(|(block, _, after, _)| (block_to_epoch(*block as u64), after.clone()))
        .collect();

    // Epoch 3728: Initial stake of 1000 NEAR (first epoch after staking transaction)
    if let Some(balance) = balance_map.get(&3728) {
        assert_eq!(
            balance, "1000",
            "Epoch 3728 should have exactly 1000 NEAR staked"
        );
    }

    // Epoch 3729: 1000 NEAR + first epoch of rewards
    if let Some(balance) = balance_map.get(&3729) {
        assert_eq!(
            balance, "1000.081598495096742265936191",
            "Epoch 3729 balance should match expected value with rewards"
        );
    }

    // Epoch 3730: More accumulated rewards
    if let Some(balance) = balance_map.get(&3730) {
        assert_eq!(
            balance, "1000.162843277605394644382094",
            "Epoch 3730 balance should match expected value with rewards"
        );
    }

    // Epoch 3731: More accumulated rewards
    if let Some(balance) = balance_map.get(&3731) {
        assert_eq!(
            balance, "1000.245604806973206628912358",
            "Epoch 3731 balance should match expected value with rewards"
        );
    }

    // Epoch 3732: More accumulated rewards
    if let Some(balance) = balance_map.get(&3732) {
        assert_eq!(
            balance, "1000.327977473718191328977448",
            "Epoch 3732 balance should match expected value with rewards"
        );
    }

    // Epoch 3733: More accumulated rewards
    if let Some(balance) = balance_map.get(&3733) {
        assert_eq!(
            balance, "1000.408574502130747008715062",
            "Epoch 3733 balance should match expected value with rewards"
        );
    }

    // Epoch 3734: More accumulated rewards (final epoch in test)
    if let Some(balance) = balance_map.get(&3734) {
        assert_eq!(
            balance, "1000.490123937552885356492289",
            "Epoch 3734 balance should match expected value with rewards"
        );
    }

    // Verify we have at least some recent epochs covered
    let epochs: Vec<u64> = final_snapshots
        .iter()
        .map(|(block, _, _, _)| block_to_epoch(*block as u64))
        .collect();

    // Should have the most recent epoch from the last cycle
    assert!(
        epochs.contains(&third_cycle_epoch) || epochs.iter().any(|&e| e >= staking_tx_epoch),
        "Should have covered epochs after the staking transaction"
    );

    println!("\n✓ End-to-end staking rewards test passed");
    println!(
        "  Discovered staking pool {} for {}",
        staking_pool, account_id
    );
    println!("  Created {} staking snapshots", final_snapshots.len());
    println!("  Covered epochs: {:?}", epochs);

    Ok(())
}

/// Test finding staking gaps between snapshots
#[sqlx::test]
async fn test_find_staking_gaps(pool: PgPool) -> sqlx::Result<()> {
    let account_id = "test-gap-account.near";
    let staking_pool = "test.poolv1.near";
    let token_id = staking_token_id(staking_pool);

    // Insert staking snapshots with different balances (gaps between them)
    // Epoch 100 (block 4320000): balance 1000
    // Epoch 102 (block 4406400): balance 1010 (gap - balance changed)
    // Epoch 104 (block 4492800): balance 1010 (no gap - balance same)
    // Epoch 106 (block 4579200): balance 1025 (gap - balance changed)
    let snapshots = vec![
        (4320000i64, "1000", "1000"),
        (4406400i64, "1000", "1010"), // Gap from previous
        (4492800i64, "1010", "1010"), // No gap
        (4579200i64, "1010", "1025"), // Gap from previous
    ];

    for (block_height, before, after) in snapshots {
        let before_bd: BigDecimal = before.parse().unwrap();
        let after_bd: BigDecimal = after.parse().unwrap();
        let amount = &after_bd - &before_bd;

        sqlx::query(
            r#"
            INSERT INTO balance_changes
            (account_id, token_id, block_height, block_timestamp, block_time, amount, balance_before, balance_after, transaction_hashes, receipt_id, counterparty, actions, raw_data)
            VALUES ($1, $2, $3, 1700000000000000000, NOW(), $4, $5, $6, '{}', '{}', 'STAKING_SNAPSHOT', '{}', '{}')
            "#,
        )
        .bind(account_id)
        .bind(&token_id)
        .bind(block_height)
        .bind(amount)
        .bind(before_bd)
        .bind(after_bd)
        .execute(&pool)
        .await?;
    }

    // Find gaps
    let gaps = find_staking_gaps(&pool, account_id, staking_pool, 5000000)
        .await
        .expect("Should find staking gaps");

    println!("Found {} staking gaps:", gaps.len());
    for gap in &gaps {
        println!(
            "  Block {} -> {}: {} -> {}",
            gap.start_block, gap.end_block, gap.balance_at_start, gap.balance_at_end
        );
    }

    // Should find 2 gaps
    assert_eq!(gaps.len(), 2, "Should find 2 gaps");

    // First gap: 4320000 -> 4406400 (1000 -> 1010)
    assert_eq!(gaps[0].start_block, 4320000);
    assert_eq!(gaps[0].end_block, 4406400);
    assert_eq!(gaps[0].balance_at_start.to_string(), "1000");
    assert_eq!(gaps[0].balance_at_end.to_string(), "1010");

    // Second gap: 4492800 -> 4579200 (1010 -> 1025)
    assert_eq!(gaps[1].start_block, 4492800);
    assert_eq!(gaps[1].end_block, 4579200);
    assert_eq!(gaps[1].balance_at_start.to_string(), "1010");
    assert_eq!(gaps[1].balance_at_end.to_string(), "1025");

    println!("✓ Staking gap detection working correctly");

    Ok(())
}

/// Test inserting staking reward records
#[sqlx::test]
async fn test_insert_staking_reward(pool: PgPool) -> sqlx::Result<()> {
    let network = common::create_archival_network();

    let account_id = "webassemblymusic-treasury.sputnik-dao.near";
    let staking_pool = "astro-stakers.poolv1.near";
    let token_id = staking_token_id(staking_pool);

    // Use block 161091600 (epoch 3728) where we know there's staked balance
    let block_height: u64 = 161_091_600;

    println!(
        "Inserting staking reward for {}/{} at block {}",
        account_id, staking_pool, block_height
    );

    let balance = insert_staking_reward(&pool, &network, account_id, staking_pool, block_height)
        .await
        .expect("Should insert staking reward");

    println!("Inserted staking reward with balance: {} NEAR", balance);

    // Verify the record was inserted with STAKING_REWARD counterparty
    let record = sqlx::query(
        r#"
        SELECT
            account_id, token_id, block_height, counterparty,
            balance_before::TEXT as balance_before,
            balance_after::TEXT as balance_after,
            transaction_hashes, raw_data
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2 AND block_height = $3
        "#,
    )
    .bind(account_id)
    .bind(&token_id)
    .bind(block_height as i64)
    .fetch_one(&pool)
    .await?;

    let record_counterparty: String = record.get("counterparty");
    let record_transaction_hashes: Vec<String> = record.get("transaction_hashes");
    let raw_data: Option<serde_json::Value> = record.get("raw_data");

    assert_eq!(
        record_counterparty, STAKING_REWARD_COUNTERPARTY,
        "Should have STAKING_REWARD counterparty"
    );
    assert!(
        record_transaction_hashes.is_empty(),
        "Staking rewards should have empty transaction_hashes"
    );

    // Verify raw_data contains reward metadata
    let raw_data = raw_data.expect("Should have raw_data");
    assert!(
        raw_data.get("staking_pool").is_some(),
        "Should have staking_pool in raw_data"
    );
    assert!(
        raw_data.get("reward_type").is_some(),
        "Should have reward_type in raw_data"
    );
    assert_eq!(
        raw_data.get("reward_type").unwrap().as_str().unwrap(),
        "staking_reward",
        "Should have correct reward_type"
    );

    println!("✓ Staking reward insertion working correctly");
    println!("  Counterparty: {}", record_counterparty);

    Ok(())
}

/// Test track_and_fill_staking_rewards creates both snapshots and fills gaps
#[sqlx::test]
async fn test_track_and_fill_staking_rewards(pool: PgPool) -> sqlx::Result<()> {
    use nt_be::handlers::balance_changes::account_monitor::run_monitor_cycle;

    let network = common::create_archival_network();

    let account_id = "webassemblymusic-treasury.sputnik-dao.near";
    let staking_pool = "astro-stakers.poolv1.near";
    let token_id = staking_token_id(staking_pool);

    // The real staking transaction is at block 161048663 (epoch 3727)
    let staking_tx_block = 161_048_663i64;

    // Set up the account as monitored
    sqlx::query(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled, last_synced_at)
        VALUES ($1, true, NULL)
        "#,
    )
    .bind(account_id)
    .execute(&pool)
    .await?;

    // Run multiple monitor cycles to create snapshots and fill gaps
    // Each cycle creates up to 5 epoch snapshots
    for cycle in 0..3 {
        let cycle_epoch = 3730u64 + (cycle as u64 * 2);
        let cycle_block = epoch_to_block(cycle_epoch) as i64;
        println!(
            "\n=== Running monitor cycle {} at block {} (epoch {}) ===",
            cycle + 1,
            cycle_block,
            cycle_epoch
        );

        run_monitor_cycle(&pool, &network, cycle_block, None, None)
            .await
            .expect("Monitor cycle should succeed");
    }

    // Check results: should have both STAKING_SNAPSHOT and STAKING_REWARD records
    let all_records: Vec<(i64, String, String, String)> = sqlx::query_as(
        r#"
        SELECT block_height, balance_after::TEXT, counterparty,
               CASE WHEN counterparty = 'STAKING_SNAPSHOT' THEN 'snapshot'
                    WHEN counterparty = 'STAKING_REWARD' THEN 'reward'
                    ELSE 'other' END as record_type
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height
        "#,
    )
    .bind(account_id)
    .bind(&token_id)
    .fetch_all(&pool)
    .await?;

    println!("\n=== Final staking records ===");
    let mut snapshot_count = 0;
    let mut reward_count = 0;

    for (block, balance, counterparty, record_type) in &all_records {
        let epoch = block_to_epoch(*block as u64);
        println!(
            "  Block {} (epoch {}): balance {} [{}]",
            block, epoch, balance, counterparty
        );

        match record_type.as_str() {
            "snapshot" => snapshot_count += 1,
            "reward" => reward_count += 1,
            _ => {}
        }
    }

    println!("\nSummary:");
    println!("  Total records: {}", all_records.len());
    println!("  STAKING_SNAPSHOT: {}", snapshot_count);
    println!("  STAKING_REWARD: {}", reward_count);

    // Verify we have some records
    assert!(
        !all_records.is_empty(),
        "Should have created staking records"
    );
    assert!(snapshot_count > 0, "Should have STAKING_SNAPSHOT records");

    // Should have STAKING_REWARD records for gaps between snapshots with different balances
    // The real blockchain data has balance increases between epochs, so we should find gaps
    assert!(
        reward_count > 0,
        "Should have STAKING_REWARD records for filled gaps (found {} snapshots but no rewards)",
        snapshot_count
    );

    // Get all STAKING_REWARD records with their amounts
    let rewards: Vec<(i64, String, String, String)> = sqlx::query_as(
        r#"
        SELECT block_height, balance_before::TEXT, balance_after::TEXT, amount::TEXT
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2 AND counterparty = 'STAKING_REWARD'
        ORDER BY block_height
        "#,
    )
    .bind(account_id)
    .bind(&token_id)
    .fetch_all(&pool)
    .await?;

    println!("\n=== STAKING_REWARD records (exact blocks where rewards occurred) ===");
    for (block, balance_before, balance_after, amount) in &rewards {
        let epoch = block_to_epoch(*block as u64);
        println!(
            "  Block {} (epoch {}): {} NEAR staked → {} NEAR (reward: {} NEAR)",
            block, epoch, balance_before, balance_after, amount
        );
    }

    // Hard assertions for the exact blocks and amounts where staking rewards occurred
    // These are deterministic values from the blockchain
    assert_eq!(
        rewards.len(),
        6,
        "Should have exactly 6 STAKING_REWARD records"
    );

    // Epoch 3728 reward (first reward after initial stake)
    assert_eq!(
        rewards[0].0, 161064202,
        "First reward should be at block 161064202"
    );
    assert_eq!(
        rewards[0].1, "1000",
        "Balance before first reward should be 1000 NEAR"
    );
    assert_eq!(
        rewards[0].2, "1000.081598495096742265936191",
        "Balance after first reward should be 1000.081598495096742265936191 NEAR"
    );
    assert_eq!(
        rewards[0].3, "0.081598495096742265936191",
        "First reward amount should be 0.081598495096742265936191 NEAR"
    );

    // Epoch 3729 reward
    assert_eq!(
        rewards[1].0, 161106976,
        "Second reward should be at block 161106976"
    );
    assert_eq!(
        rewards[1].3, "0.081244782508652378445903",
        "Second reward amount should be 0.081244782508652378445903 NEAR"
    );

    // Epoch 3730 reward
    assert_eq!(
        rewards[2].0, 161150142,
        "Third reward should be at block 161150142"
    );
    assert_eq!(
        rewards[2].3, "0.082761529367811984530264",
        "Third reward amount should be 0.082761529367811984530264 NEAR"
    );

    // Epoch 3731 reward
    assert_eq!(
        rewards[3].0, 161193732,
        "Fourth reward should be at block 161193732"
    );
    assert_eq!(
        rewards[3].3, "0.082372666744984700065090",
        "Fourth reward amount should be 0.082372666744984700065090 NEAR"
    );

    // Epoch 3732 reward
    assert_eq!(
        rewards[4].0, 161237043,
        "Fifth reward should be at block 161237043"
    );
    assert_eq!(
        rewards[4].3, "0.080597028412555679737614",
        "Fifth reward amount should be 0.080597028412555679737614 NEAR"
    );

    // Epoch 3733 reward
    assert_eq!(
        rewards[5].0, 161280282,
        "Sixth reward should be at block 161280282"
    );
    assert_eq!(
        rewards[5].3, "0.081549435422138347777227",
        "Sixth reward amount should be 0.081549435422138347777227 NEAR"
    );

    // Now test the API to ensure it returns only STAKING_REWARD records, not STAKING_SNAPSHOT
    println!("\n=== Testing balance changes API ===");

    // Query balance changes as the API would (filtering out synthetic records)
    let api_changes: Vec<(i64, String, String)> = sqlx::query_as(
        r#"
        SELECT block_height, counterparty, amount::TEXT
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
          AND counterparty NOT IN ('SNAPSHOT', 'NOT_REGISTERED', 'STAKING_SNAPSHOT')
        ORDER BY block_height
        "#,
    )
    .bind(account_id)
    .bind(&token_id)
    .fetch_all(&pool)
    .await?;

    println!("API would return {} records", api_changes.len());
    for (block, counterparty, amount) in &api_changes {
        let epoch = block_to_epoch(*block as u64);
        println!(
            "  Block {} (epoch {}): {} [amount: {}]",
            block, epoch, counterparty, amount
        );
    }

    // The API should only return STAKING_REWARD records, filtering out STAKING_SNAPSHOT
    assert_eq!(
        api_changes.len(),
        reward_count as usize,
        "API should return {} STAKING_REWARD records (filtered STAKING_SNAPSHOT)",
        reward_count
    );

    // Verify all returned records are STAKING_REWARD
    for (_, counterparty, _) in &api_changes {
        assert_eq!(
            counterparty, STAKING_REWARD_COUNTERPARTY,
            "API should only return STAKING_REWARD records"
        );
    }

    // Verify the blocks match our reward blocks
    let api_blocks: Vec<i64> = api_changes.iter().map(|(block, _, _)| *block).collect();
    let reward_blocks: Vec<i64> = rewards.iter().map(|(block, _, _, _)| *block).collect();
    assert_eq!(
        api_blocks, reward_blocks,
        "API blocks should match reward blocks"
    );

    println!(
        "\n✓ track_and_fill_staking_rewards working correctly ({} snapshots, {} rewards)",
        snapshot_count, reward_count
    );
    println!(
        "✓ API correctly filters out STAKING_SNAPSHOT, returning only {} STAKING_REWARD records",
        api_changes.len()
    );

    Ok(())
}
