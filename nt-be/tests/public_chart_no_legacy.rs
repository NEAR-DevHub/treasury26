use bigdecimal::BigDecimal;
use chrono::{TimeZone, Utc};
use nt_be::handlers::public_history::charts::repository::load_gold_balance_points;
use nt_be::handlers::public_history::gold::unified::sync_unified_for_account;
use sqlx::PgPool;

const DAO: &str = "chart-only.sputnik-dao.near";

#[sqlx::test(migrations = "./migrations")]
async fn chart_queries_work_without_the_legacy_balance_table(pool: PgPool) {
    // Keep the forbidden table name out of chart source modules while proving
    // at the database boundary that the unified chart SQL has no dependency.
    let legacy_table = ["balance", "changes"].join("_");
    let unavailable_table = ["legacy", "balance", "table", "unavailable"].join("_");
    sqlx::query(&format!(
        "ALTER TABLE {legacy_table} RENAME TO {unavailable_table}"
    ))
    .execute(&pool)
    .await
    .expect("make the legacy table unavailable");

    sqlx::query(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled, is_confidential_account)
        VALUES ($1, true, false)
        "#,
    )
    .bind(DAO)
    .execute(&pool)
    .await
    .expect("seed monitored account");

    let block_time = Utc.with_ymd_and_hms(2026, 7, 21, 0, 0, 0).unwrap();
    let leg_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO silver_public_transfer_legs (
            account_id, leg_key, source_event_id, source, receipt_id,
            block_height, block_time,
            token_standard, token_id, direction, amount_raw, amount, decimals,
            leg_kind, raw_payload
        )
        VALUES (
            $1, 'chart-leg', NULL, 'nearblocks_receipt', 'chart-receipt', 100, $2,
            'native', 'near', 'incoming', 42, 42, 24,
            'transfer', '{}'::jsonb
        )
        RETURNING id
        "#,
    )
    .bind(DAO)
    .bind(block_time)
    .fetch_one(&pool)
    .await
    .expect("seed silver leg");

    // The deposit's ledger entry plus a later sponsor top-up with no visible
    // leg: the top-up moves the chain balance only.
    sqlx::query(
        r#"
        INSERT INTO silver_balance_history (
            account_id, asset, token_standard, entry_key, source, receipt_id,
            counterparty, block_height, block_time, intra_block_seq,
            delta_raw, delta, decimals, balance_before, balance_after,
            affects_user_balance, user_balance_after
        )
        VALUES
            ($1, 'near', 'native', 'native:' || $1 || ':chart-receipt',
             'nearblocks_receipt', 'chart-receipt', 'alice.near', 100, $2, 0,
             42, 42, 24, 0, 42, TRUE, 42),
            ($1, 'near', 'native', 'native:' || $1 || ':sponsor-receipt',
             'nearblocks_receipt', 'sponsor-receipt', 'sponsor.trezu.near', 101, $3, 0,
             10, 10, 24, 42, 52, FALSE, 42)
        "#,
    )
    .bind(DAO)
    .bind(block_time)
    .bind(block_time + chrono::Duration::hours(1))
    .execute(&pool)
    .await
    .expect("seed balance ledger entries");

    sqlx::query(
        r#"
        INSERT INTO gold_public_history_events (
            gold_event_key, primary_transfer_leg_id, dao_id, transaction_type,
            token_in, amount_in, token_in_balance_before, token_in_balance_after,
            block_height, event_time, status, raw_payload
        )
        VALUES (
            'chart-gold', $1, $2, 'deposit',
            'near', 42, 0, 42,
            100, $3, 'success', '{}'::jsonb
        )
        "#,
    )
    .bind(leg_id)
    .bind(DAO)
    .bind(block_time)
    .execute(&pool)
    .await
    .expect("seed gold event");

    let mut tx = pool.begin().await.expect("begin");
    sync_unified_for_account(&mut tx, DAO, block_time - chrono::Duration::days(1))
        .await
        .expect("sync unified ledger rows");
    tx.commit().await.expect("commit");

    let points = load_gold_balance_points(&pool, DAO)
        .await
        .expect("load gold balance points");
    assert_eq!(points.len(), 2, "activity leg plus hidden sponsor movement");
    assert_eq!(points[0].asset, "near");
    assert_eq!(points[0].balance, BigDecimal::from(42));
    // The sponsor top-up is charted but leaves the user-owned balance flat.
    assert_eq!(points[1].balance, BigDecimal::from(42));

    let hidden_visible: Vec<(String, bool)> = sqlx::query_as(
        r#"
        SELECT gold_event_key, history_visible
        FROM gold_treasury_ledger_events
        WHERE dao_id = $1
        ORDER BY gold_event_key
        "#,
    )
    .bind(DAO)
    .fetch_all(&pool)
    .await
    .expect("load unified rows");
    assert_eq!(hidden_visible.len(), 2);
    assert!(
        hidden_visible
            .iter()
            .any(|(key, visible)| key == "chart-gold" && *visible)
    );
    assert!(
        hidden_visible
            .iter()
            .any(|(key, visible)| key.starts_with("ledger:native:") && !visible)
    );
}
