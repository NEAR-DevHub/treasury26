/// Integration test for NEAR transfer counterparty resolution.
///
/// Reproduces the bug where native NEAR transfers between DAOs show the
/// approver (or meta-tx delegate target) as the counterparty instead of the
/// actual sending/receiving DAO.
///
/// Tests both directions:
/// - Incoming: olskik-test receives 0.1 NEAR from testing-astradao
/// - Outgoing: olskik-test sends 1.0 NEAR to lesik-o
///
/// The fix extracts `predecessor_id` (for incoming) and child receipt
/// `executor_id` (for outgoing) from the receipt chain via RPC.
///
/// ```bash
/// cargo test --test near_deposit_counterparty_test -- --nocapture
/// ```
mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use near_api::NetworkConfig;
use nt_be::routes::create_routes;
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

/// Run one maintenance cycle with minimal configuration (no gap filling, no staking).
/// This is the production code path — the server calls this every 5 minutes.
async fn run_maintenance_cycle(pool: &PgPool, _network: &NetworkConfig) {
    let state = common::build_test_state_archival(pool.clone());
    nt_be::handlers::balance_changes::account_monitor::run_maintenance_cycle(&state, 0)
        .await
        .expect("run_maintenance_cycle failed");
}

const TARGET_DAO: &str = "olskik-test.sputnik-dao.near";
const SOURCE_DAO: &str = "testing-astradao.sputnik-dao.near";
const LESIK_DAO: &str = "lesik-o.sputnik-dao.near";

// Incoming: testing-astradao → olskik-test (0.1 NEAR)
const INCOMING_TX: &str = "4ZM64KR7WgKExWn4TcBvwHWBuC4NjnUd9MWzxskHrEpH";
const INCOMING_BLOCK: i64 = 190792143;

// Outgoing: olskik-test → lesik-o (1.0 NEAR)
const OUTGOING_TX: &str = "FxWS6iXr8nqYX936GSHqmfqWfxsc4QrnbbKRwtHEfRhz";
const OUTGOING_BLOCK: i64 = 190790034;

const FIXTURE_COUNT: i64 = 6;

/// Load fixture SQL into indexed_dao_outcomes.
async fn load_fixtures(pool: &PgPool, fixture_sql: &str) {
    for stmt in fixture_sql.split(';').filter(|s| !s.trim().is_empty()) {
        let trimmed = stmt.trim();
        if trimmed.starts_with("--") && !trimmed.contains("INSERT") {
            continue;
        }
        sqlx::query(trimmed)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("Failed to execute fixture SQL: {e}\nStatement: {trimmed}"));
    }
}

/// Query balance_changes for a specific NEAR record by account and tx hash.
/// Returns the record with the largest absolute amount (the actual transfer,
/// not the gas refund).
async fn get_near_balance_change(
    pool: &PgPool,
    account_id: &str,
    tx_hash: &str,
) -> Option<(String, String)> {
    sqlx::query_as::<_, (String, String)>(
        "SELECT counterparty, amount::text
         FROM balance_changes
         WHERE account_id = $1 AND token_id = 'near' AND $2 = ANY(transaction_hashes)
         ORDER BY ABS(amount) DESC
         LIMIT 1",
    )
    .bind(account_id)
    .bind(tx_hash)
    .fetch_optional(pool)
    .await
    .unwrap()
}

/// Register monitored accounts via the API and seed the enrichment cursor.
async fn setup_enrichment(pool: &PgPool) {
    let state = Arc::new(common::build_test_state(pool.clone()));

    for dao in [TARGET_DAO, SOURCE_DAO, LESIK_DAO] {
        let app = create_routes(state.clone());
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/monitored-accounts")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "accountId": dao }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            response.status() == StatusCode::OK || response.status() == StatusCode::CONFLICT,
            "Failed to register {}: {}",
            dao,
            response.status()
        );
    }

    sqlx::query(
        "INSERT INTO goldsky_cursors (consumer_name, last_processed_id, last_processed_block, updated_at)
         VALUES ('balance_enrichment', '', 0, NOW())
         ON CONFLICT (consumer_name) DO UPDATE SET last_processed_id = '', last_processed_block = 0",
    )
    .execute(pool)
    .await
    .unwrap();
}

/// Run enrichment until all outcomes are processed.
async fn run_enrichment(pool: &PgPool, network: &near_api::NetworkConfig) -> usize {
    let mut total = 0usize;
    loop {
        let processed = nt_be::handlers::balance_changes::goldsky_enrichment::run_enrichment_cycle(
            pool,
            pool,
            network,
            None,
            "http://unused",
            None,
        )
        .await
        .unwrap();
        total += processed;
        if processed < 100 {
            break;
        }
    }
    total
}

/// Test 1: Incoming NEAR — counterparty should be the source DAO.
///
/// The Transfer receipt on olskik-test has predecessor_id = testing-astradao
/// (the DAO that executed act_proposal and created the Transfer).
#[sqlx::test]
async fn test_incoming_near_counterparty(pool: PgPool) {
    common::load_test_env();
    let _ = env_logger::try_init();
    let network = common::create_archival_network();

    load_fixtures(
        &pool,
        include_str!("test_data/goldsky_near_deposit_counterparty_fixtures.sql"),
    )
    .await;
    setup_enrichment(&pool).await;

    let total = run_enrichment(&pool, &network).await;
    println!("Enrichment: processed {} outcomes", total);
    assert!(total >= FIXTURE_COUNT as usize);

    let (counterparty, amount) = get_near_balance_change(&pool, TARGET_DAO, INCOMING_TX)
        .await
        .expect("Should have incoming NEAR balance change");

    println!("Incoming: counterparty={}, amount={}", counterparty, amount);

    assert_eq!(
        counterparty, SOURCE_DAO,
        "Incoming counterparty should be source DAO, not the approver"
    );

    println!("PASSED");
}

/// Test 2: Outgoing NEAR — counterparty should be the recipient DAO.
///
/// The act_proposal receipt on olskik-test creates a child Transfer receipt
/// whose executor_id = lesik-o (the recipient of the NEAR).
#[sqlx::test]
async fn test_outgoing_near_counterparty(pool: PgPool) {
    common::load_test_env();
    let _ = env_logger::try_init();
    let network = common::create_archival_network();

    load_fixtures(
        &pool,
        include_str!("test_data/goldsky_near_deposit_counterparty_fixtures.sql"),
    )
    .await;
    setup_enrichment(&pool).await;

    let total = run_enrichment(&pool, &network).await;
    println!("Enrichment: processed {} outcomes", total);
    assert!(total >= FIXTURE_COUNT as usize);

    let (counterparty, amount) = get_near_balance_change(&pool, TARGET_DAO, OUTGOING_TX)
        .await
        .expect("Should have outgoing NEAR balance change");

    println!("Outgoing: counterparty={}, amount={}", counterparty, amount);

    assert_eq!(
        counterparty, LESIK_DAO,
        "Outgoing counterparty should be recipient DAO, not the delegate target"
    );
    assert!(
        amount.starts_with('-'),
        "Outgoing amount should be negative: {}",
        amount
    );

    println!("PASSED");
}

/// Test 3: Re-enrichment corrects existing wrong counterparty records.
///
/// Inserts balance_changes with wrong counterparty (the old bug), then
/// re-runs enrichment. The ON CONFLICT DO UPDATE upsert should overwrite
/// with the correct counterparty.
#[sqlx::test]
async fn test_re_enrichment_corrects_wrong_counterparty(pool: PgPool) {
    common::load_test_env();
    let _ = env_logger::try_init();
    let network = common::create_archival_network();

    load_fixtures(
        &pool,
        include_str!("test_data/goldsky_near_deposit_counterparty_fixtures.sql"),
    )
    .await;

    // Insert wrong incoming record
    sqlx::query(
        "INSERT INTO balance_changes
         (account_id, token_id, block_height, block_timestamp, block_time,
          amount, balance_before, balance_after,
          transaction_hashes, receipt_id, signer_id, receiver_id,
          counterparty, actions, raw_data, action_kind, method_name)
         VALUES ($1, 'near', $2, 1774267965606000000, '2026-03-23T12:12:45.606Z',
          0.1, 1.7727, 1.8727,
          ARRAY[$3], '{}'::text[], 'sponsor.trezu.near', 'yurtur.near',
          'yurtur.near', '{}'::jsonb, '{}'::jsonb, 'FUNCTION_CALL', 'act_proposal')",
    )
    .bind(TARGET_DAO)
    .bind(INCOMING_BLOCK)
    .bind(INCOMING_TX)
    .execute(&pool)
    .await
    .unwrap();

    // Insert wrong outgoing record
    sqlx::query(
        "INSERT INTO balance_changes
         (account_id, token_id, block_height, block_timestamp, block_time,
          amount, balance_before, balance_after,
          transaction_hashes, receipt_id, signer_id, receiver_id,
          counterparty, actions, raw_data, action_kind, method_name)
         VALUES ($1, 'near', $2, 1774266706024000000, '2026-03-23T11:51:46.024Z',
          -1.001, 2.7737, 1.7726,
          ARRAY[$3], '{}'::text[], 'sponsor.trezu.near', 'olskik.near',
          'olskik.near', '{}'::jsonb, '{}'::jsonb, 'FUNCTION_CALL', 'act_proposal')",
    )
    .bind(TARGET_DAO)
    .bind(OUTGOING_BLOCK)
    .bind(OUTGOING_TX)
    .execute(&pool)
    .await
    .unwrap();

    // Verify wrong counterparties
    let (wrong_in, _) = get_near_balance_change(&pool, TARGET_DAO, INCOMING_TX)
        .await
        .unwrap();
    let (wrong_out, _) = get_near_balance_change(&pool, TARGET_DAO, OUTGOING_TX)
        .await
        .unwrap();
    assert_eq!(wrong_in, "yurtur.near");
    assert_eq!(wrong_out, "olskik.near");
    println!(
        "Pre-existing: incoming={}, outgoing={}",
        wrong_in, wrong_out
    );

    // Re-run enrichment
    setup_enrichment(&pool).await;
    let total = run_enrichment(&pool, &network).await;
    println!("Re-enrichment: processed {} outcomes", total);

    // Verify corrected
    let (fixed_in, _) = get_near_balance_change(&pool, TARGET_DAO, INCOMING_TX)
        .await
        .unwrap();
    let (fixed_out, _) = get_near_balance_change(&pool, TARGET_DAO, OUTGOING_TX)
        .await
        .unwrap();

    println!(
        "Corrected: incoming={} (was {}), outgoing={} (was {})",
        fixed_in, wrong_in, fixed_out, wrong_out
    );

    assert_eq!(
        fixed_in, SOURCE_DAO,
        "Incoming should be corrected to source DAO"
    );
    assert_eq!(
        fixed_out, LESIK_DAO,
        "Outgoing should be corrected to recipient DAO"
    );

    println!("PASSED");
}

/// Test 4: counterparty correction via the server maintenance cycle, with cursor tracking.
///
/// Verifies the full production code path end-to-end:
///
/// 1. `run_maintenance_cycle` (what the server spawns every 5 minutes) drives the
///    correction — no monitored accounts are needed (correction is unconditional).
/// 2. Progress is tracked in `maintenance_jobs`: on the first run the cursor is
///    initialised to the highest matching block; after the batch it advances to
///    `min(batch) - 1`.
/// 3. A second cycle finds no records at or below the new cursor, sets the
///    cursor to the sentinel `-1`, and becomes a no-op on all future calls.
/// 4. Gas-cost records (`ABS(amount) ≤ 0.01`) are never touched.
#[sqlx::test]
async fn test_correct_near_counterparties(pool: PgPool) {
    common::load_test_env();
    let _ = env_logger::try_init();
    let network = common::create_archival_network();

    // Insert wrong incoming record (counterparty = receiver_id)
    sqlx::query(
        "INSERT INTO balance_changes
         (account_id, token_id, block_height, block_timestamp, block_time,
          amount, balance_before, balance_after,
          transaction_hashes, receipt_id, signer_id, receiver_id,
          counterparty, actions, raw_data, action_kind, method_name)
         VALUES ($1, 'near', $2, 1774267965606000000, '2026-03-23T12:12:45.606Z',
          0.1, 1.7727, 1.8727,
          ARRAY[$3], '{}'::text[], 'sponsor.trezu.near', 'yurtur.near',
          'yurtur.near', '{}'::jsonb, '{}'::jsonb, 'FUNCTION_CALL', 'act_proposal')",
    )
    .bind(TARGET_DAO)
    .bind(INCOMING_BLOCK)
    .bind(INCOMING_TX)
    .execute(&pool)
    .await
    .unwrap();

    // Insert wrong outgoing record (counterparty = receiver_id)
    sqlx::query(
        "INSERT INTO balance_changes
         (account_id, token_id, block_height, block_timestamp, block_time,
          amount, balance_before, balance_after,
          transaction_hashes, receipt_id, signer_id, receiver_id,
          counterparty, actions, raw_data, action_kind, method_name)
         VALUES ($1, 'near', $2, 1774266706024000000, '2026-03-23T11:51:46.024Z',
          -1.001, 2.7737, 1.7726,
          ARRAY[$3], '{}'::text[], 'sponsor.trezu.near', 'olskik.near',
          'olskik.near', '{}'::jsonb, '{}'::jsonb, 'FUNCTION_CALL', 'act_proposal')",
    )
    .bind(TARGET_DAO)
    .bind(OUTGOING_BLOCK)
    .bind(OUTGOING_TX)
    .execute(&pool)
    .await
    .unwrap();

    // Insert a gas cost record that should NOT be corrected (amount < 0.01)
    sqlx::query(
        "INSERT INTO balance_changes
         (account_id, token_id, block_height, block_timestamp, block_time,
          amount, balance_before, balance_after,
          transaction_hashes, receipt_id, signer_id, receiver_id,
          counterparty, actions, raw_data, action_kind, method_name)
         VALUES ($1, 'near', 190790036, 1774266706024000000, '2026-03-23T11:51:46.024Z',
          0.00005, 1.7726, 1.7727,
          ARRAY[$2], '{}'::text[], 'sponsor.trezu.near', 'olskik.near',
          'olskik.near', '{}'::jsonb, '{}'::jsonb, 'FUNCTION_CALL', 'act_proposal')",
    )
    .bind(TARGET_DAO)
    .bind(OUTGOING_TX)
    .execute(&pool)
    .await
    .unwrap();

    // Verify wrong counterparties are in place before correction
    let (wrong_in, _) = get_near_balance_change(&pool, TARGET_DAO, INCOMING_TX)
        .await
        .unwrap();
    let (wrong_out, _) = get_near_balance_change(&pool, TARGET_DAO, OUTGOING_TX)
        .await
        .unwrap();
    assert_eq!(wrong_in, "yurtur.near");
    assert_eq!(wrong_out, "olskik.near");

    // No maintenance_jobs cursor should exist yet
    let cursor_before: Option<i64> = sqlx::query_scalar(
        "SELECT last_processed_block FROM maintenance_jobs WHERE job_name = 'counterparty_correction'",
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(
        cursor_before.is_none(),
        "No cursor should exist before first run"
    );

    // Run via run_maintenance_cycle — the production server code path.
    // No monitored accounts registered: correction must run unconditionally.
    run_maintenance_cycle(&pool, &network).await;

    // --- Verify corrections -------------------------------------------------
    let (fixed_in, _) = get_near_balance_change(&pool, TARGET_DAO, INCOMING_TX)
        .await
        .unwrap();
    let (fixed_out, _) = get_near_balance_change(&pool, TARGET_DAO, OUTGOING_TX)
        .await
        .unwrap();

    println!(
        "Corrected: incoming={} (was {}), outgoing={} (was {})",
        fixed_in, wrong_in, fixed_out, wrong_out
    );
    assert_eq!(
        fixed_in, SOURCE_DAO,
        "Incoming counterparty should be corrected"
    );
    assert_eq!(
        fixed_out, LESIK_DAO,
        "Outgoing counterparty should be corrected"
    );

    // Gas cost record (amount 0.00005) must not be touched
    let gas_record: Option<(String,)> = sqlx::query_as(
        "SELECT counterparty FROM balance_changes
         WHERE account_id = $1 AND block_height = 190790036 AND token_id = 'near'",
    )
    .bind(TARGET_DAO)
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert_eq!(
        gas_record.unwrap().0,
        "olskik.near",
        "Gas cost record should NOT be corrected"
    );

    // --- Verify cursor was written and points to below the lowest processed block ---
    // OUTGOING_BLOCK (190790034) is the lower of the two corrected records.
    let cursor_after: i64 = sqlx::query_scalar(
        "SELECT last_processed_block FROM maintenance_jobs WHERE job_name = 'counterparty_correction'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        cursor_after,
        OUTGOING_BLOCK - 1,
        "Cursor should advance to one below the lowest processed block"
    );
    println!("Cursor after first cycle: {}", cursor_after);

    // --- Second cycle: must find nothing to reprocess -----------------------
    run_maintenance_cycle(&pool, &network).await;

    let cursor_second: i64 = sqlx::query_scalar(
        "SELECT last_processed_block FROM maintenance_jobs WHERE job_name = 'counterparty_correction'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        cursor_second, -1,
        "Cursor should be set to sentinel -1 when no records remain"
    );
    println!("Cursor after second cycle (sentinel): {}", cursor_second);

    println!("PASSED");
}
