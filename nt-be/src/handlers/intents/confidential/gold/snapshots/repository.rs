use std::collections::HashMap;

use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use sqlx::PgPool;

#[derive(Debug, Clone)]
pub struct SnapshotRow {
    pub asset: String,
    pub raw_balance: BigDecimal,
    pub balance: BigDecimal,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ChartSnapshotRow {
    pub asset: String,
    pub snapshot_at: DateTime<Utc>,
    pub balance: BigDecimal,
}

/// Used by snapshot to detect assets that have disappeared and need a zero tombstone.
pub async fn load_latest_balances_per_asset(
    pool: &PgPool,
    dao_id: &str,
) -> Result<HashMap<String, BigDecimal>, sqlx::Error> {
    let rows: Vec<(String, BigDecimal)> = sqlx::query_as(
        r#"
        SELECT DISTINCT ON (asset) asset, balance
        FROM gold_confidential_balance_snapshots
        WHERE dao_id = $1
        ORDER BY asset, snapshot_at DESC
        "#,
    )
    .bind(dao_id)
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().collect())
}

/// Used by the hourly cron to skip DAOs that already have a fresh
/// activity-triggered snapshot.
pub async fn latest_snapshot_at(
    pool: &PgPool,
    dao_id: &str,
) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT MAX(snapshot_at)
        FROM gold_confidential_balance_snapshots
        WHERE dao_id = $1
        "#,
    )
    .bind(dao_id)
    .fetch_one(pool)
    .await
}

/// Idempotent on replay via the `(dao_id, asset, snapshot_at)` unique constraint.
pub async fn insert_snapshot_rows(
    pool: &PgPool,
    dao_id: &str,
    snapshot_at: DateTime<Utc>,
    rows: &[SnapshotRow],
) -> Result<u64, sqlx::Error> {
    if rows.is_empty() {
        return Ok(0);
    }

    let assets: Vec<String> = rows.iter().map(|r| r.asset.clone()).collect();
    let raw_balances: Vec<BigDecimal> = rows.iter().map(|r| r.raw_balance.clone()).collect();
    let balances: Vec<BigDecimal> = rows.iter().map(|r| r.balance.clone()).collect();

    let result = sqlx::query(
        r#"
        INSERT INTO gold_confidential_balance_snapshots
            (dao_id, asset, snapshot_at, raw_balance, balance)
        SELECT $1, asset, $2, raw_balance, balance
        FROM UNNEST($3::text[], $4::numeric[], $5::numeric[])
            AS t(asset, raw_balance, balance)
        ON CONFLICT (dao_id, asset, snapshot_at) DO NOTHING
        "#,
    )
    .bind(dao_id)
    .bind(snapshot_at)
    .bind(&assets)
    .bind(&raw_balances)
    .bind(&balances)
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}

/// Returns every snapshot inside the window plus the latest row before `start_time`
/// per asset — that earlier row is the carry-forward baseline for the first bucket.
pub async fn load_snapshots_for_chart(
    pool: &PgPool,
    dao_id: &str,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
) -> Result<Vec<ChartSnapshotRow>, sqlx::Error> {
    sqlx::query_as::<_, ChartSnapshotRow>(
        r#"
        (
            SELECT DISTINCT ON (asset) asset, snapshot_at, balance
            FROM gold_confidential_balance_snapshots
            WHERE dao_id = $1
              AND snapshot_at < $2
            ORDER BY asset ASC, snapshot_at DESC
        )
        UNION ALL
        (
            SELECT asset, snapshot_at, balance
            FROM gold_confidential_balance_snapshots
            WHERE dao_id = $1
              AND snapshot_at >= $2
              AND snapshot_at <= $3
        )
        ORDER BY asset ASC, snapshot_at ASC
        "#,
    )
    .bind(dao_id)
    .bind(start_time)
    .bind(end_time)
    .fetch_all(pool)
    .await
}
