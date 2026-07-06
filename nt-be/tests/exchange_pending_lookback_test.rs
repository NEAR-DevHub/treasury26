mod common;

use chrono::{Duration, TimeZone, Utc};
use nt_be::handlers::public_history::gold::cursors::mark_gold_dirty;
use nt_be::handlers::public_history::gold::projector::project_public_gold_for_account;
use nt_be::handlers::public_history::gold::repository::earliest_pending_exchange_time;
use nt_be::services::TokenPriceService;
use serial_test::serial;
use sqlx::postgres::PgPoolOptions;

const ACCOUNT_ID: &str = "exchange-pending-lookback-test.sputnik-dao.near";
const RELAYER_ACCOUNT: &str = "relayer.test.near";
const USDC_TOKEN_ID: &str =
    "intents.near:nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";

async fn cleanup(pool: &sqlx::PgPool) {
    sqlx::query("DELETE FROM gold_public_history_projection_errors WHERE dao_id = $1")
        .bind(ACCOUNT_ID)
        .execute(pool)
        .await
        .expect("clear gold projection errors");
    sqlx::query("DELETE FROM gold_public_history_events WHERE dao_id = $1")
        .bind(ACCOUNT_ID)
        .execute(pool)
        .await
        .expect("clear gold history events");
    sqlx::query("DELETE FROM gold_public_history_cursors WHERE account_id = $1")
        .bind(ACCOUNT_ID)
        .execute(pool)
        .await
        .expect("clear gold cursors");
    sqlx::query("DELETE FROM silver_public_history_projection_errors WHERE account_id = $1")
        .bind(ACCOUNT_ID)
        .execute(pool)
        .await
        .expect("clear silver projection errors");
    sqlx::query("DELETE FROM silver_public_transfer_legs WHERE account_id = $1")
        .bind(ACCOUNT_ID)
        .execute(pool)
        .await
        .expect("clear silver transfer legs");
    sqlx::query("DELETE FROM silver_public_history_cursors WHERE account_id = $1")
        .bind(ACCOUNT_ID)
        .execute(pool)
        .await
        .expect("clear silver cursors");
    sqlx::query("DELETE FROM bronze_public_history_events WHERE account_id = $1")
        .bind(ACCOUNT_ID)
        .execute(pool)
        .await
        .expect("clear bronze events");
    sqlx::query("DELETE FROM dao_proposals WHERE dao_id = $1")
        .bind(ACCOUNT_ID)
        .execute(pool)
        .await
        .expect("clear proposals");
}

async fn insert_bronze_event(
    pool: &sqlx::PgPool,
    source_event_key: &str,
    transaction_hash: &str,
    receipt_id: &str,
    event_index: i32,
    block_height: i64,
    block_time: chrono::DateTime<Utc>,
) -> i64 {
    sqlx::query_scalar(
        r#"
        INSERT INTO bronze_public_history_events (
            account_id,
            source,
            source_event_key,
            transaction_hash,
            receipt_id,
            event_index,
            block_height,
            block_timestamp,
            block_time,
            affected_account_id,
            involved_account_id,
            contract_account_id,
            token_id,
            delta_amount_raw,
            decimals,
            outcome_status,
            raw_payload
        )
        VALUES (
            $1, 'nearblocks_mt', $2, $3, $4, $5, $6, 0, $7,
            $1, 'intents.near', 'intents.near', $8, 1, 6, true, '{}'::jsonb
        )
        RETURNING id
        "#,
    )
    .bind(ACCOUNT_ID)
    .bind(source_event_key)
    .bind(transaction_hash)
    .bind(receipt_id)
    .bind(event_index)
    .bind(block_height)
    .bind(block_time)
    .bind(USDC_TOKEN_ID.trim_start_matches("intents.near:"))
    .fetch_one(pool)
    .await
    .expect("insert bronze event")
}

async fn insert_outgoing_leg(
    pool: &sqlx::PgPool,
    source_event_id: i64,
    proposal_ref: i64,
    block_time: chrono::DateTime<Utc>,
) -> i64 {
    sqlx::query_scalar(
        r#"
        INSERT INTO silver_public_transfer_legs (
            account_id,
            leg_key,
            source_event_id,
            source,
            proposal_ref,
            proposal_id,
            transaction_hash,
            receipt_id,
            block_height,
            block_time,
            token_standard,
            token_id,
            direction,
            counterparty,
            amount_raw,
            amount,
            decimals,
            leg_kind,
            raw_payload
        )
        VALUES (
            $1, 'outgoing-wrap-leg', $2, 'nearblocks_mt', $3, 44,
            'proposal-tx', 'outgoing-receipt', 100, $4,
            'nep141', 'wrap.near', 'outgoing', 'deposit-address',
            100000000000000000000000, 0.1, 24, 'transfer', '{}'::jsonb
        )
        RETURNING id
        "#,
    )
    .bind(ACCOUNT_ID)
    .bind(source_event_id)
    .bind(proposal_ref)
    .bind(block_time)
    .fetch_one(pool)
    .await
    .expect("insert outgoing silver leg")
}

async fn insert_incoming_leg(
    pool: &sqlx::PgPool,
    source_event_id: i64,
    block_time: chrono::DateTime<Utc>,
) -> i64 {
    sqlx::query_scalar(
        r#"
        INSERT INTO silver_public_transfer_legs (
            account_id,
            leg_key,
            source_event_id,
            source,
            transaction_hash,
            receipt_id,
            block_height,
            block_time,
            token_standard,
            token_id,
            direction,
            counterparty,
            amount_raw,
            amount,
            decimals,
            leg_kind,
            raw_payload
        )
        VALUES (
            $1, 'incoming-usdc-leg', $2, 'nearblocks_mt',
            'fulfillment-tx', 'incoming-receipt', 101, $3,
            'nep245', $4, 'incoming', 'solver-multichain-asset.near',
            492331, 0.492331, 6, 'transfer', '{}'::jsonb
        )
        RETURNING id
        "#,
    )
    .bind(ACCOUNT_ID)
    .bind(source_event_id)
    .bind(block_time)
    .bind(USDC_TOKEN_ID)
    .fetch_one(pool)
    .await
    .expect("insert incoming silver leg")
}

async fn insert_lookup_silver_leg(
    pool: &sqlx::PgPool,
    leg_key: &str,
    source_event_key: &str,
    block_height: i64,
    block_time: chrono::DateTime<Utc>,
) -> i64 {
    let source_event_id = insert_bronze_event(
        pool,
        source_event_key,
        source_event_key,
        source_event_key,
        0,
        block_height,
        block_time,
    )
    .await;

    sqlx::query_scalar(
        r#"
        INSERT INTO silver_public_transfer_legs (
            account_id,
            leg_key,
            source_event_id,
            source,
            transaction_hash,
            receipt_id,
            block_height,
            block_time,
            token_standard,
            token_id,
            direction,
            counterparty,
            amount_raw,
            amount,
            decimals,
            leg_kind,
            raw_payload
        )
        VALUES (
            $1, $2, $3, 'nearblocks_mt', $4, $4, $5, $6,
            'nep141', 'wrap.near', 'outgoing', 'deposit-address',
            100000000000000000000000, 0.1, 24, 'transfer', '{}'::jsonb
        )
        RETURNING id
        "#,
    )
    .bind(ACCOUNT_ID)
    .bind(leg_key)
    .bind(source_event_id)
    .bind(source_event_key)
    .bind(block_height)
    .bind(block_time)
    .fetch_one(pool)
    .await
    .expect("insert lookup silver leg")
}

async fn insert_gold_exchange(
    pool: &sqlx::PgPool,
    event_key: &str,
    primary_leg_id: i64,
    event_time: chrono::DateTime<Utc>,
    status: &str,
) {
    sqlx::query(
        r#"
        INSERT INTO gold_public_history_events (
            gold_event_key,
            primary_transfer_leg_id,
            dao_id,
            transaction_type,
            token_out,
            amount_out,
            token_out_balance_before,
            token_out_balance_after,
            event_time,
            status,
            raw_payload
        )
        VALUES (
            $1, $2, $3, 'exchange', 'wrap.near', 0.1, 1.0, 0.9,
            $4, $5::public_history_event_status, '{}'::jsonb
        )
        "#,
    )
    .bind(event_key)
    .bind(primary_leg_id)
    .bind(ACCOUNT_ID)
    .bind(event_time)
    .bind(status)
    .execute(pool)
    .await
    .expect("insert gold exchange");
}

#[tokio::test]
#[serial]
async fn pending_exchange_recompute_widens_to_pair_delayed_fulfillment() {
    common::load_test_env();
    let db_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await
        .expect("connect to test database");
    cleanup(&pool).await;

    let token_prices = TokenPriceService::new(pool.clone());
    let outgoing_time = Utc.with_ymd_and_hms(2026, 7, 6, 8, 45, 36).unwrap();
    let incoming_time = outgoing_time + Duration::seconds(16);
    let proposal_executed_at = outgoing_time + Duration::seconds(1);

    let proposal_ref: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO dao_proposals (
            dao_id,
            proposal_id,
            status,
            proposal_created_at,
            proposal_executed_at,
            proposal_execution_block_height,
            proposal_execution_transaction_hash,
            quote_metadata,
            quote_deposit_address
        )
        VALUES (
            $1, 44, 'approved', $2, $3, 100, 'proposal-tx',
            $4::jsonb, 'deposit-address'
        )
        RETURNING id
        "#,
    )
    .bind(ACCOUNT_ID)
    .bind(outgoing_time - Duration::minutes(3))
    .bind(proposal_executed_at)
    .bind(serde_json::json!({
        "status": "SUCCESS",
        "nearTxHashes": ["fulfillment-tx"],
        "quoteResponse": {
            "quoteRequest": {
                "originAsset": "nep141:wrap.near",
                "destinationAsset": "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"
            },
            "quote": {
                "amountIn": "100000000000000000000000"
            }
        },
        "swapDetails": {
            "amountIn": "100000000000000000000000",
            "amountOut": "492331"
        }
    }))
    .fetch_one(&pool)
    .await
    .expect("insert proposal");

    let outgoing_source_id = insert_bronze_event(
        &pool,
        "outgoing-source",
        "proposal-tx",
        "outgoing-receipt",
        0,
        100,
        outgoing_time,
    )
    .await;
    insert_outgoing_leg(&pool, outgoing_source_id, proposal_ref, outgoing_time).await;

    mark_gold_dirty(&pool, ACCOUNT_ID, Some(outgoing_time))
        .await
        .expect("mark outgoing dirty");
    project_public_gold_for_account(&pool, &token_prices, ACCOUNT_ID, RELAYER_ACCOUNT)
        .await
        .expect("project outgoing pending exchange");

    let pending: (String, Option<String>, Option<String>) = sqlx::query_as(
        r#"
        SELECT transaction_type::text, token_in, token_out
        FROM gold_public_history_events
        WHERE dao_id = $1
        "#,
    )
    .bind(ACCOUNT_ID)
    .fetch_one(&pool)
    .await
    .expect("fetch pending gold row");
    assert_eq!(
        pending,
        ("exchange".to_string(), None, Some("wrap.near".to_string()))
    );

    let incoming_source_id = insert_bronze_event(
        &pool,
        "incoming-source",
        "fulfillment-tx",
        "incoming-receipt",
        0,
        101,
        incoming_time,
    )
    .await;
    let incoming_leg_id = insert_incoming_leg(&pool, incoming_source_id, incoming_time).await;

    mark_gold_dirty(&pool, ACCOUNT_ID, Some(incoming_time))
        .await
        .expect("mark incoming dirty");
    project_public_gold_for_account(&pool, &token_prices, ACCOUNT_ID, RELAYER_ACCOUNT)
        .await
        .expect("project delayed fulfillment");

    let exchange: (String, Option<i64>, Option<String>, Option<String>, String) = sqlx::query_as(
        r#"
        SELECT
            transaction_type::text,
            counter_transfer_leg_id,
            token_in,
            token_out,
            status::text
        FROM gold_public_history_events
        WHERE dao_id = $1
        "#,
    )
    .bind(ACCOUNT_ID)
    .fetch_one(&pool)
    .await
    .expect("fetch completed exchange");
    assert_eq!(
        exchange,
        (
            "exchange".to_string(),
            Some(incoming_leg_id),
            Some(USDC_TOKEN_ID.to_string()),
            Some("wrap.near".to_string()),
            "success".to_string()
        )
    );

    let standalone_deposits: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM gold_public_history_events
        WHERE dao_id = $1
          AND transaction_type = 'deposit'
          AND primary_transfer_leg_id = $2
        "#,
    )
    .bind(ACCOUNT_ID)
    .bind(incoming_leg_id)
    .fetch_one(&pool)
    .await
    .expect("count standalone incoming deposits");
    assert_eq!(standalone_deposits, 0);

    let error_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM gold_public_history_projection_errors WHERE dao_id = $1",
    )
    .bind(ACCOUNT_ID)
    .fetch_one(&pool)
    .await
    .expect("count projection errors");
    assert_eq!(error_count, 0);

    cleanup(&pool).await;
}

#[tokio::test]
#[serial]
async fn earliest_pending_exchange_time_uses_oldest_pending_silver_time_only() {
    common::load_test_env();
    let db_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await
        .expect("connect to test database");
    cleanup(&pool).await;

    let early = Utc.with_ymd_and_hms(2026, 7, 6, 8, 0, 0).unwrap();
    let middle = early + Duration::minutes(10);
    let late = early + Duration::minutes(20);

    let failed_leg = insert_lookup_silver_leg(&pool, "failed-leg", "failed-source", 1, early).await;
    let earliest_pending_leg =
        insert_lookup_silver_leg(&pool, "earliest-pending-leg", "pending-source-1", 2, middle)
            .await;
    let later_pending_leg =
        insert_lookup_silver_leg(&pool, "later-pending-leg", "pending-source-2", 3, late).await;

    insert_gold_exchange(
        &pool,
        "failed-exchange",
        failed_leg,
        early + Duration::seconds(5),
        "failed",
    )
    .await;
    insert_gold_exchange(
        &pool,
        "earliest-pending-exchange",
        earliest_pending_leg,
        middle + Duration::seconds(5),
        "pending",
    )
    .await;
    insert_gold_exchange(
        &pool,
        "later-pending-exchange",
        later_pending_leg,
        late + Duration::seconds(5),
        "pending",
    )
    .await;

    let mut tx = pool.begin().await.expect("begin tx");
    let earliest_pending = earliest_pending_exchange_time(&mut tx, ACCOUNT_ID)
        .await
        .expect("load earliest pending");
    tx.rollback().await.expect("rollback tx");

    assert_eq!(earliest_pending, Some(middle));

    sqlx::query("UPDATE gold_public_history_events SET status = 'failed' WHERE dao_id = $1")
        .bind(ACCOUNT_ID)
        .execute(&pool)
        .await
        .expect("mark all exchanges failed");

    let mut tx = pool.begin().await.expect("begin tx");
    let no_pending = earliest_pending_exchange_time(&mut tx, ACCOUNT_ID)
        .await
        .expect("load no pending");
    tx.rollback().await.expect("rollback tx");

    assert_eq!(no_pending, None);

    cleanup(&pool).await;
}
