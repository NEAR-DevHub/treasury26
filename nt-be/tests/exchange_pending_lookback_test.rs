mod common;

use chrono::{Duration, TimeZone, Utc};
use nt_be::handlers::public_history::gold::cursors::mark_gold_dirty;
use nt_be::handlers::public_history::gold::projector::project_public_gold_for_account;
use nt_be::handlers::public_history::gold::repository::earliest_pending_exchange_time;
use nt_be::handlers::public_history::quotes::{
    QuoteProposalSnapshot, QuoteProposalType, build_quote_metadata,
};
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
    sqlx::query("DELETE FROM gold_treasury_ledger_events WHERE dao_id = $1")
        .bind(ACCOUNT_ID)
        .execute(pool)
        .await
        .expect("clear gold ledger events");
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
    sqlx::query("DELETE FROM silver_balance_history WHERE account_id = $1")
        .bind(ACCOUNT_ID)
        .execute(pool)
        .await
        .expect("clear silver balance history");
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
    sqlx::query("DELETE FROM bronze_public_history_cursors WHERE account_id = $1")
        .bind(ACCOUNT_ID)
        .execute(pool)
        .await
        .expect("clear bronze cursors");
    sqlx::query("DELETE FROM dao_proposals WHERE dao_id = $1")
        .bind(ACCOUNT_ID)
        .execute(pool)
        .await
        .expect("clear proposals");
    sqlx::query("DELETE FROM balance_changes WHERE account_id = $1")
        .bind(ACCOUNT_ID)
        .execute(pool)
        .await
        .expect("clear legacy balances");
}

async fn mark_backfill_complete(pool: &sqlx::PgPool) {
    sqlx::query(
        r#"
        INSERT INTO bronze_public_history_cursors (account_id, source, backfill_done)
        VALUES
            ($1, 'nearblocks_ft', true),
            ($1, 'nearblocks_mt', true),
            ($1, 'nearblocks_receipt', true)
        "#,
    )
    .bind(ACCOUNT_ID)
    .execute(pool)
    .await
    .expect("mark public history backfill complete");
}

/// The unified ledger table FKs dao_id to monitored_accounts, and the
/// projector skips accounts that are not monitored as public.
async fn seed_monitored_account(pool: &sqlx::PgPool) {
    sqlx::query(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled, is_confidential_account)
        VALUES ($1, true, false)
        ON CONFLICT (account_id) DO NOTHING
        "#,
    )
    .bind(ACCOUNT_ID)
    .execute(pool)
    .await
    .expect("seed monitored account");
}

/// Gold balance stamps resolve non-native legs by `entry_key == leg_key`
/// against `silver_balance_history`; a leg without its ledger entry is a
/// projection error, never a NULL balance.
#[allow(clippy::too_many_arguments)]
async fn insert_ledger_entry(
    pool: &sqlx::PgPool,
    entry_key: &str,
    asset: &str,
    token_standard: &str,
    receipt_id: &str,
    block_height: i64,
    block_time: chrono::DateTime<Utc>,
    delta: &str,
    balance_before: &str,
    balance_after: &str,
    decimals: i32,
) {
    sqlx::query(
        r#"
        INSERT INTO silver_balance_history (
            account_id, asset, token_standard, entry_kind, entry_key,
            source, receipt_id, block_height, block_time, intra_block_seq,
            delta_raw, delta, decimals, balance_before, balance_after,
            affects_user_balance, user_balance_after
        )
        VALUES (
            $1, $2, $3::public_token_standard, 'movement', $4,
            'nearblocks_mt', $5, $6, $7, 0,
            $8::numeric * POWER(10::numeric, $9), $8::numeric, $9,
            $10::numeric, $11::numeric,
            TRUE, $11::numeric
        )
        "#,
    )
    .bind(ACCOUNT_ID)
    .bind(asset)
    .bind(token_standard)
    .bind(entry_key)
    .bind(receipt_id)
    .bind(block_height)
    .bind(block_time)
    .bind(delta)
    .bind(decimals)
    .bind(balance_before)
    .bind(balance_after)
    .execute(pool)
    .await
    .expect("insert silver ledger entry");
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
        INSERT INTO gold_treasury_ledger_events (
            gold_event_key,
            dao_id,
            source_kind,
            history_visible,
            transaction_type,
            status,
            event_time,
            token_out,
            amount_out,
            token_out_user_balance_after,
            primary_transfer_leg_id
        )
        VALUES (
            $1, $2, 'public_silver_leg', TRUE, 'exchange',
            $3::public_history_event_status, $4, 'wrap.near', 0.1, 0.9, $5
        )
        "#,
    )
    .bind(event_key)
    .bind(ACCOUNT_ID)
    .bind(status)
    .bind(event_time)
    .bind(primary_leg_id)
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
    seed_monitored_account(&pool).await;
    mark_backfill_complete(&pool).await;
    let token_prices = TokenPriceService::new(pool.clone());

    let outgoing_time = Utc.with_ymd_and_hms(2026, 7, 6, 8, 45, 36).unwrap();
    let incoming_time = outgoing_time + Duration::seconds(16);
    let proposal_executed_at = outgoing_time + Duration::seconds(1);
    insert_ledger_entry(
        &pool,
        "outgoing-wrap-leg",
        "wrap.near",
        "nep141",
        "outgoing-receipt",
        100,
        outgoing_time,
        "-0.1",
        "1.0",
        "0.9",
        24,
    )
    .await;
    insert_ledger_entry(
        &pool,
        "incoming-usdc-leg",
        USDC_TOKEN_ID,
        "nep245",
        "incoming-receipt",
        101,
        incoming_time,
        "0.492331",
        "0",
        "0.492331",
        6,
    )
    .await;

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
    .bind(
        build_quote_metadata(
            None,
            Some(&QuoteProposalSnapshot {
                quote_type: QuoteProposalType::AssetExchange,
                deposit_address: "deposit-address".to_string(),
                recipient: None,
                origin_asset: "nep141:wrap.near".to_string(),
                origin_amount_raw: "100000000000000000000000".to_string(),
                destination_asset: Some(
                    "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"
                        .to_string(),
                ),
                signature: None,
            }),
            Some(serde_json::json!({
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
            })),
        )
        .expect("quote metadata"),
    )
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
        FROM gold_treasury_ledger_events
        WHERE dao_id = $1
          AND source_kind = 'public_silver_leg'
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

    // Simulate asynchronous USD enrichment before a later projection pass.
    // Reprojection must not erase it when the priced token, amount, and event
    // timestamp are unchanged.
    sqlx::query(
        r#"
        UPDATE gold_treasury_ledger_events
        SET amount_out_usd = 42
        WHERE dao_id = $1
        "#,
    )
    .bind(ACCOUNT_ID)
    .execute(&pool)
    .await
    .expect("seed asynchronously enriched USD value");

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

    let exchange: (
        String,
        Option<i64>,
        Option<String>,
        Option<String>,
        String,
        Option<bigdecimal::BigDecimal>,
    ) = sqlx::query_as(
        r#"
        SELECT
            transaction_type::text,
            counter_transfer_leg_id,
            token_in,
            token_out,
            status::text,
            amount_out_usd
        FROM gold_treasury_ledger_events
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
            "success".to_string(),
            Some("42".parse().expect("valid decimal"))
        )
    );

    let reconciled_balances: (String, String) = sqlx::query_as(
        r#"
        SELECT
            trim_scale(token_out_user_balance_after)::text,
            trim_scale(token_in_user_balance_after)::text
        FROM gold_treasury_ledger_events
        WHERE dao_id = $1
        "#,
    )
    .bind(ACCOUNT_ID)
    .fetch_one(&pool)
    .await
    .expect("fetch reconciled gold balances");
    assert_eq!(
        reconciled_balances,
        ("0.9".to_string(), "0.492331".to_string())
    );

    let standalone_deposits: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM gold_treasury_ledger_events
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

    // A later dirty boundary can land exactly on the fulfillment. The
    // completed exchange must widen replay back to its outgoing leg instead
    // of retaining the exchange and projecting the incoming leg as a deposit.
    mark_gold_dirty(&pool, ACCOUNT_ID, Some(incoming_time))
        .await
        .expect("mark completed exchange dirty at fulfillment");
    project_public_gold_for_account(&pool, &token_prices, ACCOUNT_ID, RELAYER_ACCOUNT)
        .await
        .expect("reproject completed delayed exchange from fulfillment");

    let (row_count, exchange_count, deposit_count): (i64, i64, i64) = sqlx::query_as(
        r#"
        SELECT
            COUNT(*),
            COUNT(*) FILTER (WHERE transaction_type = 'exchange'),
            COUNT(*) FILTER (WHERE transaction_type = 'deposit')
        FROM gold_treasury_ledger_events
        WHERE dao_id = $1
        "#,
    )
    .bind(ACCOUNT_ID)
    .fetch_one(&pool)
    .await
    .expect("count rows after completed exchange replay");
    assert_eq!((row_count, exchange_count, deposit_count), (1, 1, 0));

    let replayed_balances: (String, String) = sqlx::query_as(
        r#"
        SELECT
            trim_scale(token_out_user_balance_after)::text,
            trim_scale(token_in_user_balance_after)::text
        FROM gold_treasury_ledger_events
        WHERE dao_id = $1
        "#,
    )
    .bind(ACCOUNT_ID)
    .fetch_one(&pool)
    .await
    .expect("fetch balances after completed exchange replay");
    assert_eq!(
        replayed_balances,
        ("0.9".to_string(), "0.492331".to_string())
    );

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
    seed_monitored_account(&pool).await;

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

    sqlx::query("UPDATE gold_treasury_ledger_events SET status = 'failed' WHERE dao_id = $1")
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
