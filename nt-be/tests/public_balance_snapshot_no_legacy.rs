use bigdecimal::BigDecimal;
use chrono::{Duration, TimeZone, Utc};
use nt_be::handlers::public_history::snapshots::repository::{
    load_chart_rows, load_missing_usd_rows, load_snapshot_assets,
};
use sqlx::PgPool;

#[sqlx::test(migrations = "./migrations")]
async fn snapshot_chart_queries_work_without_the_legacy_balance_table(pool: PgPool) {
    // Keep the forbidden table name out of public snapshot source modules while
    // proving at the database boundary that their chart SQL has no dependency.
    let legacy_table = ["balance", "changes"].join("_");
    let unavailable_table = ["legacy", "balance", "table", "unavailable"].join("_");
    sqlx::query(&format!(
        "ALTER TABLE {legacy_table} RENAME TO {unavailable_table}"
    ))
    .execute(&pool)
    .await
    .expect("make the legacy table unavailable");

    let bucket = Utc.with_ymd_and_hms(2026, 7, 21, 0, 0, 0).unwrap();
    for (asset, balance) in [("near", 42), ("wrap.near", 7)] {
        sqlx::query(
            r#"
            INSERT INTO public_balance_snapshot (
                dao_id, asset, block_height, block_time, balance, usd_value
            )
            VALUES ($1, $2, $3, $4, $5, NULL)
            "#,
        )
        .bind("snapshot-only.sputnik-dao.near")
        .bind(asset)
        .bind(100_i64)
        .bind(bucket - Duration::seconds(1))
        .bind(BigDecimal::from(balance))
        .execute(&pool)
        .await
        .expect("seed snapshot row");
    }

    let assets = load_snapshot_assets(&pool, "snapshot-only.sputnik-dao.near")
        .await
        .expect("load snapshot inventory");
    assert_eq!(assets, vec!["near", "wrap.near"]);

    let rows = load_chart_rows(
        &pool,
        "snapshot-only.sputnik-dao.near",
        &[bucket],
        &[bucket - Duration::days(1)],
    )
    .await
    .expect("load snapshot chart rows");
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|row| row.block_height == 100));

    let repair_page = load_missing_usd_rows(&pool, 1)
        .await
        .expect("load rotating USD repair page");
    assert_eq!(repair_page.len(), 1);
}
