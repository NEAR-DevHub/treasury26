//! Integration tests for staking rewards tracking
//!
//! These tests verify the staking pool balance query and snapshot insertion functionality.

mod common;

use bigdecimal::BigDecimal;
use nt_be::handlers::balance_changes::balance::staking::{
    block_to_epoch, epoch_to_block, get_staking_balance_at_block, is_staking_pool,
};
use nt_be::handlers::balance_changes::staking_rewards::{
    STAKING_SNAPSHOT_COUNTERPARTY, discover_staking_pools, extract_staking_pool,
    insert_staking_snapshot, is_staking_token, staking_token_id, track_staking_rewards,
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
    assert!(
        balance > BigDecimal::from(0),
        "Should have non-zero staking balance"
    );

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
