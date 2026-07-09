/// End-to-end tests for the DAO notification system.
///
/// Tests the full pipeline:
///   balance_changes / detected_swaps → detection worker → dao_notifications → Telegram dispatcher → dao_notification_deliveries
///
/// No real Telegram API calls are made — TelegramClient::default() has bot=None
/// and silently succeeds on all send operations.
///
/// ```bash
/// cargo test --test notifications_e2e_test -- --nocapture
/// ```
mod common;

use sqlx::PgPool;
use std::sync::Arc;

const DAO_ID: &str = "test-notif-dao.sputnik-dao.near";
const CHAT_ID: i64 = 987654321;

/// Simulate "cursor already existed at 0" so detection processes all rows in the DB.
/// Without this, a fresh-DB test would seed the cursor to the latest row and skip everything.
async fn reset_cursors_to_start(pool: &PgPool) {
    for consumer in &[
        "notifications:balance_changes",
        "notifications:detected_swaps",
    ] {
        sqlx::query(
            "INSERT INTO goldsky_cursors (consumer_name, last_processed_id, last_processed_block, updated_at)
             VALUES ($1, '0', 0, NOW())
             ON CONFLICT (consumer_name) DO UPDATE SET
               last_processed_id = '0', last_processed_block = 0, updated_at = NOW()",
        )
        .bind(consumer)
        .execute(pool)
        .await
        .expect("reset cursor");
    }
}

async fn build_dispatch_state(pool: &PgPool) -> Arc<nt_be::AppState> {
    Arc::new(
        nt_be::AppState::builder()
            .db_pool(pool.clone())
            .build()
            .await
            .expect("build AppState for notification dispatch"),
    )
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async fn insert_dao_with_telegram(pool: &PgPool) {
    sqlx::query("INSERT INTO monitored_accounts (account_id, enabled) VALUES ($1, true)")
        .bind(DAO_ID)
        .execute(pool)
        .await
        .expect("insert monitored_account");

    sqlx::query("INSERT INTO telegram_chats (chat_id, chat_title) VALUES ($1, $2)")
        .bind(CHAT_ID)
        .bind("Test Chat")
        .execute(pool)
        .await
        .expect("insert telegram_chat");

    sqlx::query("INSERT INTO telegram_treasury_connections (dao_id, chat_id) VALUES ($1, $2)")
        .bind(DAO_ID)
        .bind(CHAT_ID)
        .execute(pool)
        .await
        .expect("insert telegram_treasury_connection");
}

/// Insert a balance_changes row with a given method_name and amount.
/// Returns the inserted id.
#[allow(clippy::too_many_arguments)]
async fn insert_balance_change(
    pool: &PgPool,
    block_height: i64,
    token_id: &str,
    amount: i64,
    counterparty: &str,
    tx_hash: Option<&str>,
    method_name: Option<&str>,
    action_kind: Option<&str>,
) -> i64 {
    let tx_hashes: Vec<String> = tx_hash.map(|h| vec![h.to_string()]).unwrap_or_default();

    sqlx::query_scalar(
        r#"
        INSERT INTO balance_changes
            (account_id, block_height, block_timestamp, block_time, token_id, amount,
             balance_before, balance_after, counterparty, transaction_hashes,
             receipt_id, method_name, action_kind)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '{}', $11, $12)
        RETURNING id
        "#,
    )
    .bind(DAO_ID)
    .bind(block_height)
    .bind(1_000_000_000_000i64) // block_timestamp (positive, non-zero)
    .bind(chrono::Utc::now()) // block_time
    .bind(token_id)
    .bind(amount)
    .bind(if amount >= 0 { 0i64 } else { amount.abs() }) // balance_before
    .bind(if amount >= 0 { amount } else { 0i64 }) // balance_after
    .bind(counterparty)
    .bind(tx_hashes)
    .bind(method_name)
    .bind(action_kind)
    .fetch_one(pool)
    .await
    .expect("insert balance_change")
}

/// Insert a detected_swaps row. Returns the inserted id.
async fn insert_detected_swap(pool: &PgPool, fulfillment_bc_id: i64) -> i64 {
    sqlx::query_scalar(
        r#"
        INSERT INTO detected_swaps
            (account_id, solver_transaction_hash, fulfillment_receipt_id,
             fulfillment_balance_change_id, received_token_id, received_amount,
             sent_token_id, sent_amount, block_height)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
        "#,
    )
    .bind(DAO_ID)
    .bind("solver-tx-hash-abc")
    .bind("fulfillment-receipt-id-abc")
    .bind(fulfillment_bc_id)
    .bind("intents.near:nep141:usdc.near")
    .bind(bigdecimal::BigDecimal::from(100))
    .bind("near")
    .bind(bigdecimal::BigDecimal::from(5))
    .bind(200i64) // block_height
    .fetch_one(pool)
    .await
    .expect("insert detected_swap")
}

/// Insert a detected_swap row with configurable fields.
async fn insert_detected_swap_custom(
    pool: &PgPool,
    solver_transaction_hash: &str,
    deposit_bc_id: Option<i64>,
    fulfillment_bc_id: i64,
    fulfillment_receipt_id: Option<&str>,
    sent_amount: &str,
    received_amount: &str,
) -> i64 {
    sqlx::query_scalar(
        r#"
        INSERT INTO detected_swaps
            (account_id, solver_transaction_hash, deposit_balance_change_id,
             fulfillment_receipt_id, fulfillment_balance_change_id,
             sent_token_id, sent_amount, received_token_id, received_amount, block_height)
        VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9::numeric, $10)
        RETURNING id
        "#,
    )
    .bind(DAO_ID)
    .bind(solver_transaction_hash)
    .bind(deposit_bc_id)
    .bind(fulfillment_receipt_id)
    .bind(fulfillment_bc_id)
    .bind("near")
    .bind(sent_amount)
    .bind("near")
    .bind(received_amount)
    .bind(300i64)
    .fetch_one(pool)
    .await
    .expect("insert custom detected_swap")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Full happy-path: detection writes dao_notifications, dispatcher records deliveries.
#[sqlx::test]
async fn test_detection_and_dispatch(pool: PgPool) {
    common::load_test_env();

    insert_dao_with_telegram(&pool).await;
    reset_cursors_to_start(&pool).await;

    // add_proposal event
    insert_balance_change(
        &pool,
        100,
        "near",
        0,
        "alice.near",
        None,
        Some("add_proposal"),
        Some("FUNCTION_CALL"),
    )
    .await;

    // Outgoing FT payment
    insert_balance_change(
        &pool,
        101,
        "usdc.near",
        -50_000,
        "bob.near",
        None,
        Some("ft_transfer"),
        Some("TRANSFER"),
    )
    .await;

    // Outgoing NEAR via proposal callback
    insert_balance_change(
        &pool,
        102,
        "near",
        -1_000_000,
        "carol.near",
        None,
        Some("on_proposal_callback"),
        Some("FUNCTION_CALL"),
    )
    .await;

    // Swap (needs a fulfillment balance_change row referenced by FK)
    let fulfillment_bc_id = insert_balance_change(
        &pool,
        200,
        "intents.near:nep141:usdc.near",
        100,
        "solver.near",
        None,
        None,
        Some("TRANSFER"),
    )
    .await;
    insert_detected_swap(&pool, fulfillment_bc_id).await;

    // --- Run detection ---
    let detected = nt_be::handlers::notifications::detector::run_detection_cycle(&pool)
        .await
        .expect("detection cycle");

    assert_eq!(
        detected, 4,
        "should detect add_proposal + 2 payments + 1 swap"
    );

    let notifications: Vec<(String, String)> = sqlx::query_as(
        "SELECT event_type, dao_id FROM dao_notifications WHERE dao_id = $1 ORDER BY id",
    )
    .bind(DAO_ID)
    .fetch_all(&pool)
    .await
    .expect("query dao_notifications");

    assert_eq!(notifications.len(), 4);
    assert_eq!(notifications[0].0, "add_proposal");
    assert_eq!(notifications[1].0, "payment");
    assert_eq!(notifications[2].0, "payment");
    assert_eq!(notifications[3].0, "swap_fulfilled");

    // --- Run dispatcher (TelegramClient::default() → no real API calls) ---
    let state = build_dispatch_state(&pool).await;
    let telegram_client = nt_be::utils::telegram::TelegramClient::default();
    let sent = nt_be::handlers::notifications::telegram_dispatcher::run_telegram_dispatch_cycle(
        &state,
        &telegram_client,
        "https://app.trezu.app",
    )
    .await
    .expect("dispatch cycle");

    assert_eq!(sent, 4, "should record delivery for all 4 notifications");

    let deliveries: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT notification_id, destination, destination_ref FROM dao_notification_deliveries ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .expect("query deliveries");

    assert_eq!(deliveries.len(), 4);
    for (_, dest, dest_ref) in &deliveries {
        assert_eq!(dest, "telegram");
        assert_eq!(dest_ref, &CHAT_ID.to_string());
    }
}

/// DAOs without a Telegram connection must not produce notifications.
#[sqlx::test]
async fn test_no_notification_for_unconnected_dao(pool: PgPool) {
    common::load_test_env();

    // Insert monitored account but NO telegram connection
    sqlx::query("INSERT INTO monitored_accounts (account_id, enabled) VALUES ($1, true)")
        .bind(DAO_ID)
        .execute(&pool)
        .await
        .expect("insert monitored_account");

    insert_balance_change(
        &pool,
        100,
        "near",
        0,
        "alice.near",
        None,
        Some("add_proposal"),
        Some("FUNCTION_CALL"),
    )
    .await;

    let detected = nt_be::handlers::notifications::detector::run_detection_cycle(&pool)
        .await
        .expect("detection cycle");

    assert_eq!(detected, 0, "no notifications for unconnected DAO");

    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM dao_notifications WHERE dao_id = $1")
        .bind(DAO_ID)
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(count.0, 0);
}

/// Detection is idempotent — re-running does not insert duplicate rows.
#[sqlx::test]
async fn test_detection_is_idempotent(pool: PgPool) {
    common::load_test_env();

    insert_dao_with_telegram(&pool).await;
    reset_cursors_to_start(&pool).await;

    insert_balance_change(
        &pool,
        100,
        "near",
        0,
        "alice.near",
        None,
        Some("add_proposal"),
        Some("FUNCTION_CALL"),
    )
    .await;

    // Run detection twice
    nt_be::handlers::notifications::detector::run_detection_cycle(&pool)
        .await
        .expect("first detection cycle");

    // Reset cursor to replay from start again
    reset_cursors_to_start(&pool).await;

    let second_run = nt_be::handlers::notifications::detector::run_detection_cycle(&pool)
        .await
        .expect("second detection cycle");

    assert_eq!(second_run, 0, "ON CONFLICT DO NOTHING prevents duplicates");

    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM dao_notifications WHERE dao_id = $1")
        .bind(DAO_ID)
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(count.0, 1, "still exactly one notification row");
}

/// Dispatch is idempotent — re-running does not send or record duplicates.
#[sqlx::test]
async fn test_dispatch_is_idempotent(pool: PgPool) {
    common::load_test_env();

    insert_dao_with_telegram(&pool).await;
    reset_cursors_to_start(&pool).await;

    insert_balance_change(
        &pool,
        100,
        "near",
        0,
        "alice.near",
        None,
        Some("add_proposal"),
        Some("FUNCTION_CALL"),
    )
    .await;

    nt_be::handlers::notifications::detector::run_detection_cycle(&pool)
        .await
        .expect("detection");

    let state = build_dispatch_state(&pool).await;
    let telegram_client = nt_be::utils::telegram::TelegramClient::default();

    let first = nt_be::handlers::notifications::telegram_dispatcher::run_telegram_dispatch_cycle(
        &state,
        &telegram_client,
        "https://app.trezu.app",
    )
    .await
    .expect("first dispatch");

    let second = nt_be::handlers::notifications::telegram_dispatcher::run_telegram_dispatch_cycle(
        &state,
        &telegram_client,
        "https://app.trezu.app",
    )
    .await
    .expect("second dispatch");

    assert_eq!(first, 1);
    assert_eq!(second, 0, "already delivered — nothing to send");

    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM dao_notification_deliveries")
        .fetch_one(&pool)
        .await
        .expect("count deliveries");
    assert_eq!(count.0, 1);
}

/// On fresh start (no cursor row), the detector seeds from the latest existing
/// row and does NOT produce notifications for pre-existing history.
/// Only events that arrive *after* the first run are notified.
#[sqlx::test]
async fn test_fresh_start_skips_history(pool: PgPool) {
    common::load_test_env();

    insert_dao_with_telegram(&pool).await;

    // Insert a historical balance_change before the worker has ever run
    insert_balance_change(
        &pool,
        100,
        "near",
        0,
        "alice.near",
        None,
        Some("add_proposal"),
        Some("FUNCTION_CALL"),
    )
    .await;

    // First run — no cursor exists yet. Should seed to latest id and detect 0.
    let first = nt_be::handlers::notifications::detector::run_detection_cycle(&pool)
        .await
        .expect("first detection cycle");

    assert_eq!(
        first, 0,
        "pre-existing history must be skipped on fresh start"
    );

    // Cursor is now persisted at the latest id
    let cursor: (i64,) = sqlx::query_as(
        "SELECT last_processed_block FROM goldsky_cursors WHERE consumer_name = 'notifications:balance_changes'",
    )
    .fetch_one(&pool)
    .await
    .expect("cursor must exist after first run");
    assert!(cursor.0 > 0, "cursor should be seeded to latest row id");

    // Insert a new event *after* the fresh-start seed
    insert_balance_change(
        &pool,
        101,
        "near",
        0,
        "bob.near",
        None,
        Some("add_proposal"),
        Some("FUNCTION_CALL"),
    )
    .await;

    let second = nt_be::handlers::notifications::detector::run_detection_cycle(&pool)
        .await
        .expect("second detection cycle");

    assert_eq!(second, 1, "only the post-seed event should be detected");
}

/// A swap inserted concurrently between two detection cycles is still picked up.
///
/// Simulates the real scenario: the balance_changes detection cursor advances past
/// the fulfillment row, then the swap detection cursor (separate table) picks up the
/// detected_swaps row that was written by the enrichment worker moments later.
/// Both cycles run concurrently via tokio::join!, so the swap notification arrives
/// in the *next* cycle at the latest.
#[sqlx::test]
async fn test_swap_inserted_between_cycles(pool: PgPool) {
    common::load_test_env();

    insert_dao_with_telegram(&pool).await;
    reset_cursors_to_start(&pool).await;

    let tg = nt_be::utils::telegram::TelegramClient::default();
    let base_url = "https://app.trezu.app";
    let state = build_dispatch_state(&pool).await;

    // Cycle 1: only a balance change exists, no swap yet
    let fulfillment_bc_id = insert_balance_change(
        &pool,
        100,
        "intents.near:nep141:usdc.near",
        100,
        "solver.near",
        None,
        None,
        Some("TRANSFER"),
    )
    .await;

    let (det1, _) = tokio::join!(
        nt_be::handlers::notifications::detector::run_detection_cycle(&pool),
        nt_be::handlers::notifications::telegram_dispatcher::run_telegram_dispatch_cycle(
            &state, &tg, base_url,
        ),
    );
    assert_eq!(
        det1.expect("cycle 1 detection"),
        0,
        "no notifiable events yet"
    );

    // The enrichment worker writes the detected_swap after the first cycle finishes
    insert_detected_swap(&pool, fulfillment_bc_id).await;

    // Cycle 2: swap now exists — detection picks it up, dispatcher sends it
    let (det2, _disp2) = tokio::join!(
        nt_be::handlers::notifications::detector::run_detection_cycle(&pool),
        nt_be::handlers::notifications::telegram_dispatcher::run_telegram_dispatch_cycle(
            &state, &tg, base_url,
        ),
    );

    assert_eq!(
        det2.expect("cycle 2 detection"),
        1,
        "swap_fulfilled detected in cycle 2"
    );
    // Dispatcher in cycle 2 may or may not have seen the new notification depending on
    // join! ordering — run a third dispatch to guarantee delivery is recorded.
    let _final_sent =
        nt_be::handlers::notifications::telegram_dispatcher::run_telegram_dispatch_cycle(
            &state, &tg, base_url,
        )
        .await
        .expect("final dispatch");

    let total_delivered: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM dao_notification_deliveries")
            .fetch_one(&pool)
            .await
            .expect("count deliveries");

    assert_eq!(
        total_delivered.0, 1,
        "swap notification delivered exactly once"
    );
}

/// Synthetic proposal-deposit rows should not emit swap_fulfilled notifications
/// unless they have a distinct fulfillment leg (or explicit fulfillment receipt).
#[sqlx::test]
async fn test_swap_notifications_skip_synthetic_proposal_deposits(pool: PgPool) {
    common::load_test_env();

    insert_dao_with_telegram(&pool).await;
    reset_cursors_to_start(&pool).await;

    // Two proposal deposits with identical amounts (can happen in parallel proposals)
    let deposit_a = insert_balance_change(
        &pool,
        400,
        "near",
        -100_681_984_951_474_100,
        "megha19.near",
        None,
        Some("on_proposal_callback"),
        Some("FUNCTION_CALL"),
    )
    .await;
    let deposit_b = insert_balance_change(
        &pool,
        401,
        "near",
        -100_681_984_951_474_100,
        "megha19.near",
        None,
        Some("on_proposal_callback"),
        Some("FUNCTION_CALL"),
    )
    .await;

    // Synthetic rows: fulfillment points to the same deposit and no receipt.
    let _synthetic_a = insert_detected_swap_custom(
        &pool,
        "proposal-deposit-synthetic-a",
        Some(deposit_a),
        deposit_a,
        None,
        "0.1006819849514741",
        "0.1000",
    )
    .await;
    let _synthetic_b = insert_detected_swap_custom(
        &pool,
        "proposal-deposit-synthetic-b",
        Some(deposit_b),
        deposit_b,
        None,
        "0.1006819849514741",
        "0.1000",
    )
    .await;

    // Real fulfillment row for only one of them.
    let real_fulfillment_bc = insert_balance_change(
        &pool,
        402,
        "near",
        100_000_000_000_000_000,
        "solver.near",
        None,
        None,
        Some("TRANSFER"),
    )
    .await;
    let real_swap = insert_detected_swap_custom(
        &pool,
        "real-solver-tx-hash",
        Some(deposit_a),
        real_fulfillment_bc,
        Some("real-fulfillment-receipt"),
        "0.1006819849514741",
        "0.1000",
    )
    .await;

    nt_be::handlers::notifications::detector::run_detection_cycle(&pool)
        .await
        .expect("detection cycle");
    let rows: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT id, source_id FROM dao_notifications WHERE dao_id = $1 AND event_type = 'swap_fulfilled' ORDER BY id",
    )
    .bind(DAO_ID)
    .fetch_all(&pool)
    .await
    .expect("fetch swap notifications");
    assert_eq!(
        rows.len(),
        1,
        "only one swap notification should be written"
    );
    assert_eq!(
        rows[0].1, real_swap,
        "notification should reference the real fulfilled detected_swap row"
    );
}

/// add_proposal notifications are deduped by tx hash and prefer the non-zero row.
#[sqlx::test]
async fn test_add_proposal_dedupes_by_tx_hash(pool: PgPool) {
    common::load_test_env();

    insert_dao_with_telegram(&pool).await;
    reset_cursors_to_start(&pool).await;

    let tx_hash = "proposal-shared-tx-hash";

    // Simulate the real fan-out shape: two zero rows + one non-zero row for the same tx.
    let _zero_a = insert_balance_change(
        &pool,
        300,
        "near",
        0,
        "frol.near",
        Some(tx_hash),
        Some("add_proposal"),
        Some("FUNCTION_CALL"),
    )
    .await;
    let chosen_nonzero = insert_balance_change(
        &pool,
        301,
        "near",
        -2_000_000,
        "frol.near",
        Some(tx_hash),
        Some("add_proposal"),
        Some("FUNCTION_CALL"),
    )
    .await;
    let _zero_b = insert_balance_change(
        &pool,
        302,
        "near",
        0,
        "frol.near",
        Some(tx_hash),
        Some("add_proposal"),
        Some("FUNCTION_CALL"),
    )
    .await;

    let detected = nt_be::handlers::notifications::detector::run_detection_cycle(&pool)
        .await
        .expect("detection cycle");
    assert_eq!(
        detected, 1,
        "one proposal notification expected per tx hash"
    );

    let row: (i64, serde_json::Value) = sqlx::query_as(
        "SELECT source_id, payload FROM dao_notifications WHERE dao_id = $1 AND event_type = 'add_proposal'",
    )
    .bind(DAO_ID)
    .fetch_one(&pool)
    .await
    .expect("fetch proposal notification");

    assert_eq!(
        row.0, chosen_nonzero,
        "detector should choose the non-zero proposal row"
    );
    assert_eq!(
        row.1.get("tx_hash").and_then(|v| v.as_str()),
        Some(tx_hash),
        "payload should carry tx hash used for dedupe"
    );
}
