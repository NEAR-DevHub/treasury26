//! Test for monitoring accounts with only a creation balance change
//!
//! `test-treasury.sputnik-dao.near` was created at block ~184993794 with ~6 NEAR.
//! This is its only balance change ever. The monitoring system should detect it.
//!
//! The issue: when `seed_initial_balance` binary searches backwards, it reaches blocks
//! where the account doesn't exist yet. The NEAR RPC returns an error (not 0), which
//! propagates and kills the entire seeding process. The fix is to treat "account does
//! not exist" errors as balance 0 in the NEAR balance query.

mod common;

use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

const ACCOUNT_ID: &str = "test-treasury.sputnik-dao.near";

/// The block where the account was created (~Feb 11, 2026)
/// Counterparty: sputnik-dao.near (DAO factory), receipt: CGmocKftuPuf2GyWkYVseV3g641SLkN8HQgW3bvxeYAY
const CREATION_BLOCK: i64 = 184_983_952;

/// Block to use as up_to_block (shortly after creation)
const UP_TO_BLOCK: i64 = 185_000_000;

/// Test that balance query returns 0 for blocks before the account existed
/// (instead of erroring out)
#[sqlx::test]
async fn test_balance_query_before_account_exists(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
    use nt_be::handlers::balance_changes::balance;

    let network = common::create_archival_network();

    // Query balance at a block well before the account was created
    let before_creation_block = (CREATION_BLOCK - 100_000) as u64;

    println!(
        "Querying NEAR balance at block {} (before account creation at ~{})...",
        before_creation_block, CREATION_BLOCK
    );

    let result =
        balance::get_balance_at_block(&pool, &network, ACCOUNT_ID, "near", before_creation_block)
            .await;

    match &result {
        Ok(balance) => {
            println!("Balance at block {}: {}", before_creation_block, balance);
            assert_eq!(
                *balance,
                bigdecimal::BigDecimal::from(0),
                "Balance before account creation should be 0"
            );
        }
        Err(e) => {
            panic!(
                "Balance query should return 0 for non-existent accounts, but got error: {}",
                e
            );
        }
    }

    // Also verify balance after creation is non-zero
    let after_creation_block = (CREATION_BLOCK + 100) as u64;

    println!(
        "Querying NEAR balance at block {} (after account creation)...",
        after_creation_block
    );

    let balance_after =
        balance::get_balance_at_block(&pool, &network, ACCOUNT_ID, "near", after_creation_block)
            .await
            .expect("Balance query after creation should succeed");

    println!(
        "Balance at block {}: {}",
        after_creation_block, balance_after
    );
    assert!(
        balance_after > bigdecimal::BigDecimal::from(0),
        "Balance after account creation should be non-zero, got: {}",
        balance_after
    );

    println!("\nBalance before creation: 0");
    println!("Balance after creation: {}", balance_after);

    Ok(())
}

/// Test the full monitoring cycle for the creation-only account
#[sqlx::test]
async fn test_monitor_cycle_creation_account(pool: PgPool) -> sqlx::Result<()> {
    common::load_test_env();
    use nt_be::handlers::balance_changes::account_monitor::run_monitor_cycle;

    let network = common::create_archival_network();

    println!("\n=== Testing full monitoring cycle for creation-only account ===");
    println!("Account: {}", ACCOUNT_ID);

    // Register the account via the API (same as frontend's openTreasury)
    let app_state = nt_be::AppState::builder()
        .db_pool(pool.clone())
        .build()
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
    let app = nt_be::routes::create_routes(Arc::new(app_state));

    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/monitored-accounts")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({ "accountId": ACCOUNT_ID }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        axum::http::StatusCode::OK,
        "POST /api/monitored-accounts should succeed"
    );

    println!("Registered account via POST /api/monitored-accounts");

    // Run the monitoring cycle
    run_monitor_cycle(&pool, &network, UP_TO_BLOCK, None, None)
        .await
        .map_err(|e| {
            sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

    println!("Monitoring cycle completed");

    // Check what was collected
    let records = sqlx::query!(
        r#"
        SELECT block_height, counterparty,
               balance_before::TEXT as "balance_before!",
               balance_after::TEXT as "balance_after!"
        FROM balance_changes
        WHERE account_id = $1 AND token_id = 'near'
        ORDER BY block_height ASC
        "#,
        ACCOUNT_ID
    )
    .fetch_all(&pool)
    .await?;

    println!("\nNEAR balance records after monitoring cycle:");
    for r in &records {
        println!(
            "  Block {}: {} -> {} ({})",
            r.block_height, r.balance_before, r.balance_after, r.counterparty
        );
    }

    assert!(
        !records.is_empty(),
        "Monitoring cycle should have created at least one balance record"
    );

    // Should have a non-SNAPSHOT record for the creation
    let has_creation = records
        .iter()
        .any(|r| r.counterparty != "SNAPSHOT" && r.balance_before == "0");

    assert!(
        has_creation,
        "Should have detected the account creation balance change (balance_before = 0)"
    );

    // Verify last_synced_at was updated
    let sync_status = sqlx::query!(
        "SELECT last_synced_at FROM monitored_accounts WHERE account_id = $1",
        ACCOUNT_ID
    )
    .fetch_one(&pool)
    .await?;

    assert!(
        sync_status.last_synced_at.is_some(),
        "last_synced_at should be set after monitoring cycle"
    );

    println!("\nMonitoring cycle test passed!");

    Ok(())
}
