mod common;

use nt_be::handlers::balance_changes::balance::ft::get_balance_at_block as get_ft_balance;
use nt_be::handlers::balance_changes::block_info::get_block_timestamp;
use nt_be::handlers::balance_changes::gap_filler::fill_gaps;
use sqlx::PgPool;
use sqlx::types::BigDecimal;

/// Regression test: when a SNAPSHOT exists with balance_before != 0 and the balance
/// existed before the lookback window, fill_gap_to_past should insert a SNAPSHOT at
/// the lookback boundary instead of failing.
///
/// Real scenario:
/// 1. Discovery creates SNAPSHOT at block 178685501 with balance_before = balance_after
/// 2. fill_gap_to_past detects gap (balance_before != 0)
/// 3. Binary search looks back 600,000 blocks to block 178085501
/// 4. Balance at 178085501 is the same (existed before the search range)
/// 5. A SNAPSHOT record should be inserted at the lookback boundary
#[sqlx::test]
async fn test_fill_gap_to_past_with_insufficient_lookback(pool: PgPool) -> sqlx::Result<()> {
    let account_id = "petersalomonsen.near";
    let token_contract = "npro.nearmobile.near";
    let snapshot_block = 178685501_i64;

    let archival_network = common::create_archival_network();

    // Step 1: Insert SNAPSHOT record with balance_before != 0
    let balance_at_snapshot = get_ft_balance(
        &pool,
        &archival_network,
        account_id,
        token_contract,
        snapshot_block as u64,
    )
    .await
    .expect("Failed to get balance");

    let balance_bd = &balance_at_snapshot;

    let block_timestamp = get_block_timestamp(&archival_network, snapshot_block as u64, None)
        .await
        .expect("Failed to get timestamp");

    let block_time = {
        let secs = block_timestamp / 1_000_000_000;
        let nsecs = (block_timestamp % 1_000_000_000) as u32;
        sqlx::types::chrono::DateTime::from_timestamp(secs, nsecs)
            .expect("Failed to convert timestamp")
    };

    sqlx::query!(
        r#"
        INSERT INTO balance_changes
            (account_id, token_id, block_height, block_timestamp, block_time,
             amount, balance_before, balance_after,
             transaction_hashes, receipt_id, signer_id, receiver_id, counterparty)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        "#,
        account_id,
        token_contract,
        snapshot_block,
        block_timestamp,
        block_time,
        BigDecimal::from(0),
        balance_bd.clone(),
        balance_bd.clone(),
        &Vec::<String>::new(),
        &Vec::<String>::new(),
        None::<String>,
        None::<String>,
        "SNAPSHOT"
    )
    .execute(&pool)
    .await?;

    // Step 2: Verify balance existed before lookback window
    let lookback_blocks = 600_000;
    let lookback_block = snapshot_block - lookback_blocks;

    let balance_at_lookback = get_ft_balance(
        &pool,
        &archival_network,
        account_id,
        token_contract,
        lookback_block as u64,
    )
    .await
    .expect("Failed to get balance at lookback block");

    assert_eq!(
        balance_at_lookback, balance_at_snapshot,
        "Balance should be the same before the lookback window for this test scenario"
    );

    // Step 3: Call fill_gaps — should insert SNAPSHOT at lookback boundary
    let filled = fill_gaps(
        &pool,
        &archival_network,
        account_id,
        token_contract,
        snapshot_block,
    )
    .await
    .expect("fill_gaps should succeed by inserting SNAPSHOT at lookback boundary");

    println!("Filled {} gaps", filled.len());

    // Verify SNAPSHOT record was inserted at lookback boundary
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

    // Should have at least 2 records: SNAPSHOT at lookback boundary + original SNAPSHOT
    assert!(records.len() >= 2, "Expected at least 2 records");

    // Earliest record should be a SNAPSHOT
    let earliest = &records[0];
    assert_eq!(
        &earliest.counterparty, "SNAPSHOT",
        "Earliest record should be a SNAPSHOT when balance existed before lookback window"
    );

    Ok(())
}
