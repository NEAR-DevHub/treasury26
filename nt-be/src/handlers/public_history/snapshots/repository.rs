use bigdecimal::{BigDecimal, num_traits::Signed};
use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::handlers::public_history::bronze::store::PublicHistorySource;
use crate::handlers::public_history::silver::cursors::{
    lock_silver_cursor_tx, mark_silver_dirty_tx,
};

use super::models::{
    HistoricalAssetRow, PublicBalanceSnapshotRow, SnapshotBootstrapCandidate,
    SnapshotBootstrapStats, SnapshotChartRow, SnapshotCursor, SnapshotUsdScanCursor,
};

const INTENTS_MULTI_TOKEN_CONTRACT: &str = "intents.near";

/// Receipt method names that move value between the account and a staking
/// pool. Shared by affected-asset derivation and the pool candidate scan.
pub const STAKING_METHOD_NAMES: &[&str] = &[
    "deposit_and_stake",
    "stake",
    "unstake",
    "unstake_all",
    "withdraw",
    "withdraw_all",
];

/// Dirty public accounts that are safe to refresh. The historical seed itself
/// reads the legacy ledger, but the same generation also publishes the current
/// inventory. Silver must therefore be clean so every normalized asset is
/// visible, and all Bronze backfills must be complete before raw NEAR/staking
/// activity is treated as complete.
pub async fn load_dirty_snapshot_cursors(
    pool: &PgPool,
) -> Result<Vec<SnapshotCursor>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT
            cursor.account_id,
            cursor.snapshot_dirty_generation,
            cursor.snapshot_applied_generation,
            cursor.snapshot_recompute_from,
            cursor.snapshot_applied_at,
            cursor.snapshot_seeded_at
        FROM public_balance_snapshot_cursors cursor
        JOIN monitored_accounts monitored
          ON monitored.account_id = cursor.account_id
         AND monitored.enabled = true
         AND COALESCE(monitored.is_confidential_account, false) = false
        WHERE cursor.snapshot_dirty_generation > cursor.snapshot_applied_generation
          AND NOT EXISTS (
              SELECT 1
              FROM silver_public_history_cursors silver
              WHERE silver.account_id = cursor.account_id
                AND silver.silver_dirty_since IS NOT NULL
          )
          AND NOT EXISTS (
              SELECT 1
              FROM silver_public_history_projection_errors error
              WHERE error.account_id = cursor.account_id
          )
          AND (
              SELECT COUNT(*)
              FROM bronze_public_history_cursors bronze
              WHERE bronze.account_id = cursor.account_id
                AND bronze.source IN (
                    'nearblocks_ft'::public_history_source,
                    'nearblocks_mt'::public_history_source,
                    'nearblocks_receipt'::public_history_source
                )
                AND bronze.backfill_done = true
          ) = 3
        ORDER BY cursor.snapshot_applied_at ASC NULLS FIRST, cursor.account_id ASC
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn load_snapshot_cursor(
    pool: &PgPool,
    account_id: &str,
) -> Result<Option<SnapshotCursor>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT
            account_id,
            snapshot_dirty_generation,
            snapshot_applied_generation,
            snapshot_recompute_from,
            snapshot_applied_at,
            snapshot_seeded_at
        FROM public_balance_snapshot_cursors
        WHERE account_id = $1
        "#,
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
}

/// Seeds the first snapshot generation in Rust and repairs historical
/// multi-token rows that predate canonical NEP-245 asset IDs. Cursor absence
/// is the idempotency marker, so a completed DAO is never reprojected again.
pub async fn bootstrap_public_balance_snapshot_cursors(
    pool: &PgPool,
) -> Result<SnapshotBootstrapStats, sqlx::Error> {
    let candidates = sqlx::query_as::<_, SnapshotBootstrapCandidate>(
        r#"
        SELECT
            monitored.account_id,
            (
                SELECT MIN(event.block_time)
                FROM bronze_public_history_events event
                WHERE event.account_id = monitored.account_id
                  AND event.source = $1::public_history_source
                  AND event.contract_account_id <> $2
            ) AS multi_token_recompute_from
        FROM monitored_accounts monitored
        WHERE monitored.enabled = true
          AND COALESCE(monitored.is_confidential_account, false) = false
          AND NOT EXISTS (
              SELECT 1
              FROM public_balance_snapshot_cursors cursor
              WHERE cursor.account_id = monitored.account_id
          )
        ORDER BY monitored.account_id
        "#,
    )
    .bind(PublicHistorySource::NearblocksMt.as_str())
    .bind(INTENTS_MULTI_TOKEN_CONTRACT)
    .fetch_all(pool)
    .await?;

    let mut stats = SnapshotBootstrapStats::default();
    for candidate in candidates {
        let mut tx = pool.begin().await?;
        lock_silver_cursor_tx(&mut tx, &candidate.account_id).await?;

        let inserted = sqlx::query(
            r#"
            INSERT INTO public_balance_snapshot_cursors (
                account_id,
                snapshot_dirty_generation,
                snapshot_applied_generation,
                snapshot_recompute_from
            )
            VALUES ($1, 1, 0, NULL)
            ON CONFLICT (account_id) DO NOTHING
            "#,
        )
        .bind(&candidate.account_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();

        if inserted == 0 {
            tx.commit().await?;
            continue;
        }

        if let Some(recompute_from) = candidate.multi_token_recompute_from {
            mark_silver_dirty_tx(&mut tx, &candidate.account_id, Some(recompute_from)).await?;
            stats.multi_token_reprojections += 1;
        }

        tx.commit().await?;
        stats.cursors_seeded += 1;
    }

    Ok(stats)
}

/// Distinct real Silver assets, optionally restricted to activity at or after
/// `since`. Synthetic quote rows are deliberately excluded: they describe an
/// expected exchange, not an on-chain balance.
pub async fn load_silver_assets(
    pool: &PgPool,
    account_id: &str,
    since: Option<DateTime<Utc>>,
) -> Result<Vec<HistoricalAssetRow>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT DISTINCT
            token_standard::text AS token_standard,
            token_id
        FROM silver_public_transfer_legs
        WHERE account_id = $1
          AND source <> 'quote_projection'::public_history_source
          AND leg_kind <> 'quote_pending'::public_transfer_leg_kind
          AND ($2::timestamptz IS NULL OR block_time >= $2)
        ORDER BY token_standard, token_id
        "#,
    )
    .bind(account_id)
    .bind(since)
    .fetch_all(pool)
    .await
}

/// True when any successful receipt landed at or after `since`. Gas, storage
/// and attached deposits all change the native balance, so every successful
/// receipt marks `near` as affected.
pub async fn has_successful_receipt_since(
    pool: &PgPool,
    account_id: &str,
    since: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM bronze_public_history_events
            WHERE account_id = $1
              AND source = 'nearblocks_receipt'::public_history_source
              AND outcome_status IS TRUE
              AND block_time >= $2
        )
        "#,
    )
    .bind(account_id)
    .bind(since)
    .fetch_one(pool)
    .await
}

/// Distinct staking-pool candidates from successful staking-method receipts,
/// optionally restricted to activity at or after `since`. Candidates still
/// require interface validation: method names alone can collide with
/// non-pool contracts.
pub async fn load_staking_pool_candidates(
    pool: &PgPool,
    account_id: &str,
    since: Option<DateTime<Utc>>,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT DISTINCT contract_account_id
        FROM bronze_public_history_events
        WHERE account_id = $1
          AND source = 'nearblocks_receipt'::public_history_source
          AND outcome_status IS TRUE
          AND contract_account_id IS NOT NULL
          AND method_name = ANY($3)
          AND ($2::timestamptz IS NULL OR block_time >= $2)
        ORDER BY contract_account_id
        "#,
    )
    .bind(account_id)
    .bind(since)
    .bind(STAKING_METHOD_NAMES)
    .fetch_all(pool)
    .await
}

pub async fn latest_snapshot_block_time(
    pool: &PgPool,
    account_id: &str,
) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT MAX(block_time)
        FROM public_balance_snapshot
        WHERE dao_id = $1
        "#,
    )
    .bind(account_id)
    .fetch_one(pool)
    .await
}

/// Start of trusted coverage: nothing can be charted before the first stored
/// row, and the chart never fabricates zeros there.
pub async fn earliest_snapshot_block_time(
    pool: &PgPool,
    account_id: &str,
) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT MIN(block_time)
        FROM public_balance_snapshot
        WHERE dao_id = $1
        "#,
    )
    .bind(account_id)
    .fetch_one(pool)
    .await
}

pub async fn load_snapshot_assets(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT DISTINCT asset
        FROM public_balance_snapshot
        WHERE dao_id = $1
        ORDER BY asset
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
}

/// Latest stored balance per asset; the refresh writes a new row only when
/// the live balance differs from this value.
pub async fn load_latest_balances_per_asset(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<(String, BigDecimal)>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT DISTINCT ON (asset) asset, balance
        FROM public_balance_snapshot
        WHERE dao_id = $1
        ORDER BY asset, block_time DESC, block_height DESC
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
}

pub async fn load_missing_usd_rows(
    pool: &PgPool,
    after: Option<&SnapshotUsdScanCursor>,
    limit: i64,
) -> Result<Vec<PublicBalanceSnapshotRow>, sqlx::Error> {
    let limit = limit.max(1);
    match after {
        Some(cursor) => {
            sqlx::query_as(
                r#"
                SELECT dao_id, asset, block_height, block_time, balance, usd_value
                FROM public_balance_snapshot
                WHERE usd_value IS NULL
                  AND (block_time, dao_id, asset, block_height) > ($1, $2, $3, $4)
                ORDER BY block_time, dao_id, asset, block_height
                LIMIT $5
                "#,
            )
            .bind(cursor.block_time)
            .bind(&cursor.dao_id)
            .bind(&cursor.asset)
            .bind(cursor.block_height)
            .bind(limit)
            .fetch_all(pool)
            .await
        }
        None => {
            sqlx::query_as(
                r#"
                SELECT dao_id, asset, block_height, block_time, balance, usd_value
                FROM public_balance_snapshot
                WHERE usd_value IS NULL
                ORDER BY block_time, dao_id, asset, block_height
                LIMIT $1
                "#,
            )
            .bind(limit)
            .fetch_all(pool)
            .await
        }
    }
}

pub async fn update_snapshot_usd_values(
    pool: &PgPool,
    rows: &[PublicBalanceSnapshotRow],
) -> Result<u64, sqlx::Error> {
    let rows = rows
        .iter()
        .filter(|row| row.usd_value.is_some())
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return Ok(0);
    }
    let dao_ids = rows
        .iter()
        .map(|row| row.dao_id.as_str())
        .collect::<Vec<_>>();
    let assets = rows
        .iter()
        .map(|row| row.asset.as_str())
        .collect::<Vec<_>>();
    let heights = rows.iter().map(|row| row.block_height).collect::<Vec<_>>();
    let values = rows
        .iter()
        .map(|row| row.usd_value.clone())
        .collect::<Vec<_>>();
    let result = sqlx::query(
        r#"
        UPDATE public_balance_snapshot snapshot
        SET usd_value = patch.usd_value
        FROM UNNEST(
            $1::text[], $2::text[], $3::bigint[], $4::numeric[]
        ) patch(dao_id, asset, block_height, usd_value)
        WHERE snapshot.dao_id = patch.dao_id
          AND snapshot.asset = patch.asset
          AND snapshot.block_height = patch.block_height
          AND snapshot.usd_value IS NULL
        "#,
    )
    .bind(&dao_ids)
    .bind(&assets)
    .bind(&heights)
    .bind(&values)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Historical seed rows. `DO NOTHING` keeps any row a live refresh has
/// already written at the same coordinate authoritative over seeded data.
pub async fn insert_snapshot_rows_if_absent(
    pool: &PgPool,
    rows: &[PublicBalanceSnapshotRow],
) -> Result<u64, sqlx::Error> {
    if rows.is_empty() {
        return Ok(0);
    }
    if rows.iter().any(|row| row.balance.is_negative()) {
        return Err(sqlx::Error::Protocol(
            "refusing to write a negative public balance snapshot".to_string(),
        ));
    }
    let dao_ids: Vec<&str> = rows.iter().map(|row| row.dao_id.as_str()).collect();
    let assets: Vec<&str> = rows.iter().map(|row| row.asset.as_str()).collect();
    let heights: Vec<i64> = rows.iter().map(|row| row.block_height).collect();
    let times: Vec<DateTime<Utc>> = rows.iter().map(|row| row.block_time).collect();
    let balances: Vec<BigDecimal> = rows.iter().map(|row| row.balance.clone()).collect();
    let usd_values: Vec<Option<BigDecimal>> =
        rows.iter().map(|row| row.usd_value.clone()).collect();

    let result = sqlx::query(
        r#"
        INSERT INTO public_balance_snapshot (
            dao_id, asset, block_height, block_time, balance, usd_value
        )
        SELECT dao_id, asset, block_height, block_time, balance, usd_value
        FROM UNNEST(
            $1::text[],
            $2::text[],
            $3::bigint[],
            $4::timestamptz[],
            $5::numeric[],
            $6::numeric[]
        ) rows(dao_id, asset, block_height, block_time, balance, usd_value)
        ON CONFLICT (dao_id, asset, block_height) DO NOTHING
        "#,
    )
    .bind(&dao_ids)
    .bind(&assets)
    .bind(&heights)
    .bind(&times)
    .bind(&balances)
    .bind(&usd_values)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Daily scheduler for balances that drift without on-chain events: staking
/// rewards accrue silently, so DAOs holding `staking:*` assets are re-dirtied
/// once per UTC day. `snapshot_recompute_from = NOW()` keeps the refresh
/// scoped to standing holdings instead of a historical event window.
pub async fn mark_staking_holdings_dirty(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        UPDATE public_balance_snapshot_cursors cursor
        SET
            snapshot_dirty_generation = cursor.snapshot_dirty_generation + 1,
            snapshot_recompute_from = NOW()
        FROM monitored_accounts monitored
        WHERE monitored.account_id = cursor.account_id
          AND monitored.enabled = true
          AND COALESCE(monitored.is_confidential_account, false) = false
          AND cursor.snapshot_dirty_generation = cursor.snapshot_applied_generation
          AND (
              cursor.snapshot_applied_at IS NULL
              OR date_trunc('day', cursor.snapshot_applied_at)
                 < date_trunc('day', NOW())
          )
          AND EXISTS (
              SELECT 1
              FROM public_balance_snapshot snapshot
              WHERE snapshot.dao_id = cursor.account_id
                AND snapshot.asset LIKE 'staking:%'
          )
        "#,
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Effective sparse balance per asset per requested bucket: the latest
/// snapshot at or before the bucket, carried forward. Buckets before an
/// asset's first trusted row produce no coordinate at all — missing history
/// is never represented as zero.
pub async fn load_chart_rows(
    pool: &PgPool,
    account_id: &str,
    buckets: &[DateTime<Utc>],
) -> Result<Vec<SnapshotChartRow>, sqlx::Error> {
    if buckets.is_empty() {
        return Ok(Vec::new());
    }

    sqlx::query_as(
        r#"
        WITH requested AS (
            SELECT bucket
            FROM UNNEST($2::timestamptz[]) requested(bucket)
        ), assets AS (
            SELECT DISTINCT asset
            FROM public_balance_snapshot
            WHERE dao_id = $1
        )
        SELECT
            assets.asset,
            requested.bucket,
            point.balance
        FROM assets
        CROSS JOIN requested
        JOIN LATERAL (
            SELECT balance
            FROM public_balance_snapshot snapshot
            WHERE snapshot.dao_id = $1
              AND snapshot.asset = assets.asset
              AND snapshot.block_time <= requested.bucket
            ORDER BY snapshot.block_time DESC, snapshot.block_height DESC
            LIMIT 1
        ) point ON TRUE
        ORDER BY assets.asset, requested.bucket
        "#,
    )
    .bind(account_id)
    .bind(buckets)
    .fetch_all(pool)
    .await
}

/// Publish one sparse refresh. This is deliberately the only point that marks
/// a generation applied: historical seeding, inventory discovery and every
/// authoritative balance read must already have succeeded. The advisory lock
/// and generation check make delayed or redelivered jobs harmless; an empty
/// row set still advances the generation because "nothing changed" is a valid
/// refresh outcome.
pub async fn publish_sparse_snapshot_refresh(
    pool: &PgPool,
    account_id: &str,
    captured_generation: i64,
    rows: &[PublicBalanceSnapshotRow],
    mark_seeded: bool,
) -> Result<Option<u64>, sqlx::Error> {
    if rows.iter().any(|row| row.dao_id != account_id) {
        return Err(sqlx::Error::Protocol(
            "refusing to publish snapshot rows for another DAO".to_string(),
        ));
    }
    if rows.iter().any(|row| row.balance.is_negative()) {
        return Err(sqlx::Error::Protocol(
            "refusing to publish a negative public balance snapshot".to_string(),
        ));
    }

    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("public-balance-snapshot:{account_id}"))
        .execute(&mut *tx)
        .await?;

    let cursor = sqlx::query_as::<_, SnapshotCursor>(
        r#"
        SELECT
            account_id,
            snapshot_dirty_generation,
            snapshot_applied_generation,
            snapshot_recompute_from,
            snapshot_applied_at,
            snapshot_seeded_at
        FROM public_balance_snapshot_cursors
        WHERE account_id = $1
        FOR UPDATE
        "#,
    )
    .bind(account_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(cursor) = cursor else {
        tx.rollback().await?;
        return Ok(None);
    };
    if cursor.snapshot_applied_generation >= captured_generation
        || cursor.snapshot_dirty_generation != captured_generation
    {
        tx.rollback().await?;
        return Ok(None);
    }

    if !rows.is_empty() {
        let dao_ids: Vec<&str> = rows.iter().map(|row| row.dao_id.as_str()).collect();
        let assets: Vec<&str> = rows.iter().map(|row| row.asset.as_str()).collect();
        let heights: Vec<i64> = rows.iter().map(|row| row.block_height).collect();
        let times: Vec<DateTime<Utc>> = rows.iter().map(|row| row.block_time).collect();
        let balances: Vec<BigDecimal> = rows.iter().map(|row| row.balance.clone()).collect();
        let usd_values: Vec<Option<BigDecimal>> =
            rows.iter().map(|row| row.usd_value.clone()).collect();

        sqlx::query(
            r#"
            INSERT INTO public_balance_snapshot (
                dao_id, asset, block_height, block_time, balance, usd_value
            )
            SELECT dao_id, asset, block_height, block_time, balance, usd_value
            FROM UNNEST(
                $1::text[],
                $2::text[],
                $3::bigint[],
                $4::timestamptz[],
                $5::numeric[],
                $6::numeric[]
            ) rows(dao_id, asset, block_height, block_time, balance, usd_value)
            ON CONFLICT (dao_id, asset, block_height) DO UPDATE SET
                block_time = EXCLUDED.block_time,
                balance = EXCLUDED.balance,
                usd_value = EXCLUDED.usd_value
            "#,
        )
        .bind(&dao_ids)
        .bind(&assets)
        .bind(&heights)
        .bind(&times)
        .bind(&balances)
        .bind(&usd_values)
        .execute(&mut *tx)
        .await?;
    }

    let applied = sqlx::query(
        r#"
        UPDATE public_balance_snapshot_cursors
        SET snapshot_applied_generation = $2,
            snapshot_recompute_from = NULL,
            snapshot_applied_at = NOW(),
            snapshot_seeded_at = CASE
                WHEN $3 THEN COALESCE(snapshot_seeded_at, NOW())
                ELSE snapshot_seeded_at
            END
        WHERE account_id = $1
          AND snapshot_dirty_generation = $2
        "#,
    )
    .bind(account_id)
    .bind(captured_generation)
    .bind(mark_seeded)
    .execute(&mut *tx)
    .await?;

    if applied.rows_affected() != 1 {
        tx.rollback().await?;
        return Ok(None);
    }

    tx.commit().await?;
    Ok(Some(rows.len() as u64))
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, DurationRound as _};

    use super::*;

    #[test]
    fn public_snapshot_sql_has_no_legacy_table_dependency() {
        let source = include_str!("repository.rs");
        let forbidden = ["balance", "changes"].join("_");
        assert!(!source.contains(&forbidden));
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn rust_bootstrap_seeds_once_and_marks_legacy_multi_token_history(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        let multi_token_account = "snapshot-bootstrap-mt.sputnik-dao.near";
        let plain_account = "snapshot-bootstrap-plain.sputnik-dao.near";
        // Truncate to timestamptz precision so the value survives the
        // Postgres round-trip intact.
        let earliest = (Utc::now() - Duration::days(30))
            .duration_trunc(Duration::microseconds(1))
            .expect("valid truncation");

        sqlx::query(
            r#"
            INSERT INTO monitored_accounts (
                account_id, enabled, is_confidential_account
            )
            VALUES ($1, true, false), ($2, true, false)
            "#,
        )
        .bind(multi_token_account)
        .bind(plain_account)
        .execute(&pool)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO bronze_public_history_events (
                account_id,
                source,
                source_event_key,
                block_height,
                block_timestamp,
                block_time,
                affected_account_id,
                contract_account_id,
                token_id,
                raw_payload
            )
            VALUES ($1, $2::public_history_source, 'legacy-mt', 10, 1,
                    $3, $1, 'v2_1.omni.hot.tg', 'token', '{}')
            "#,
        )
        .bind(multi_token_account)
        .bind(PublicHistorySource::NearblocksMt.as_str())
        .bind(earliest)
        .execute(&pool)
        .await?;

        let first = bootstrap_public_balance_snapshot_cursors(&pool).await?;
        assert_eq!(
            first,
            SnapshotBootstrapStats {
                cursors_seeded: 2,
                multi_token_reprojections: 1,
            }
        );

        let multi_token_cursor: (i64, i64, Option<DateTime<Utc>>) = sqlx::query_as(
            r#"
            SELECT snapshot_dirty_generation,
                   snapshot_applied_generation,
                   snapshot_recompute_from
            FROM public_balance_snapshot_cursors
            WHERE account_id = $1
            "#,
        )
        .bind(multi_token_account)
        .fetch_one(&pool)
        .await?;
        assert_eq!(multi_token_cursor, (2, 0, None));

        let silver_recompute_from: Option<DateTime<Utc>> = sqlx::query_scalar(
            r#"
            SELECT silver_recompute_from
            FROM silver_public_history_cursors
            WHERE account_id = $1
            "#,
        )
        .bind(multi_token_account)
        .fetch_one(&pool)
        .await?;
        assert_eq!(silver_recompute_from, Some(earliest));

        let second = bootstrap_public_balance_snapshot_cursors(&pool).await?;
        assert_eq!(second, SnapshotBootstrapStats::default());

        Ok(())
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn sparse_publication_is_generation_guarded_and_append_only(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        let account_id = "publish-snapshot.sputnik-dao.near";
        let now = Utc::now();
        sqlx::query(
            r#"
            INSERT INTO public_balance_snapshot_cursors (
                account_id, snapshot_dirty_generation,
                snapshot_applied_generation, snapshot_recompute_from
            )
            VALUES ($1, 1, 0, NULL)
            "#,
        )
        .bind(account_id)
        .execute(&pool)
        .await?;

        let first = PublicBalanceSnapshotRow {
            dao_id: account_id.to_string(),
            asset: "near".to_string(),
            block_height: 100,
            block_time: now - Duration::days(1),
            balance: BigDecimal::from(10),
            usd_value: Some(BigDecimal::from(20)),
        };
        assert_eq!(
            publish_sparse_snapshot_refresh(
                &pool,
                account_id,
                1,
                std::slice::from_ref(&first),
                true,
            )
            .await?,
            Some(1)
        );
        let seeded_at: Option<DateTime<Utc>> = sqlx::query_scalar(
            "SELECT snapshot_seeded_at FROM public_balance_snapshot_cursors WHERE account_id = $1",
        )
        .bind(account_id)
        .fetch_one(&pool)
        .await?;
        assert!(seeded_at.is_some(), "first publish records the seed");

        // An obsolete generation must not write anything.
        sqlx::query(
            r#"
            UPDATE public_balance_snapshot_cursors
            SET snapshot_dirty_generation = 2
            WHERE account_id = $1
            "#,
        )
        .bind(account_id)
        .execute(&pool)
        .await?;
        let stale_worker_row = PublicBalanceSnapshotRow {
            balance: BigDecimal::from(999),
            ..first.clone()
        };
        assert_eq!(
            publish_sparse_snapshot_refresh(&pool, account_id, 1, &[stale_worker_row], false)
                .await?,
            None
        );
        let unchanged: BigDecimal =
            sqlx::query_scalar("SELECT balance FROM public_balance_snapshot WHERE dao_id = $1")
                .bind(account_id)
                .fetch_one(&pool)
                .await?;
        assert_eq!(unchanged, BigDecimal::from(10));

        // A sparse refresh appends new coordinates; prior history stays.
        let addition = PublicBalanceSnapshotRow {
            dao_id: account_id.to_string(),
            asset: "wrap.near".to_string(),
            block_height: 200,
            block_time: now,
            balance: BigDecimal::from(7),
            usd_value: None,
        };
        assert_eq!(
            publish_sparse_snapshot_refresh(
                &pool,
                account_id,
                2,
                std::slice::from_ref(&addition),
                false,
            )
            .await?,
            Some(1)
        );
        let stored: Vec<(String, BigDecimal)> = sqlx::query_as(
            r#"
            SELECT asset, balance
            FROM public_balance_snapshot
            WHERE dao_id = $1
            ORDER BY asset
            "#,
        )
        .bind(account_id)
        .fetch_all(&pool)
        .await?;
        assert_eq!(
            stored,
            vec![
                ("near".to_string(), BigDecimal::from(10)),
                ("wrap.near".to_string(), BigDecimal::from(7)),
            ]
        );

        // An empty refresh ("nothing changed") still advances the generation.
        sqlx::query(
            r#"
            UPDATE public_balance_snapshot_cursors
            SET snapshot_dirty_generation = 3
            WHERE account_id = $1
            "#,
        )
        .bind(account_id)
        .execute(&pool)
        .await?;
        assert_eq!(
            publish_sparse_snapshot_refresh(&pool, account_id, 3, &[], false).await?,
            Some(0)
        );

        let cursor: (i64, i64, Option<DateTime<Utc>>) = sqlx::query_as(
            r#"
            SELECT snapshot_dirty_generation, snapshot_applied_generation,
                   snapshot_recompute_from
            FROM public_balance_snapshot_cursors
            WHERE account_id = $1
            "#,
        )
        .bind(account_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(cursor, (3, 3, None));
        Ok(())
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn chart_rows_carry_forward_and_never_fabricate_missing_history(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        let account_id = "chart-rows.sputnik-dao.near";
        let day = |offset: i64| {
            DateTime::parse_from_rfc3339("2026-07-10T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc)
                + Duration::days(offset)
        };
        let rows = [
            PublicBalanceSnapshotRow {
                dao_id: account_id.to_string(),
                asset: "near".to_string(),
                block_height: 100,
                block_time: day(1),
                balance: BigDecimal::from(5),
                usd_value: None,
            },
            PublicBalanceSnapshotRow {
                dao_id: account_id.to_string(),
                asset: "near".to_string(),
                block_height: 300,
                block_time: day(3),
                balance: BigDecimal::from(8),
                usd_value: None,
            },
            PublicBalanceSnapshotRow {
                dao_id: account_id.to_string(),
                asset: "wrap.near".to_string(),
                block_height: 300,
                block_time: day(3),
                balance: BigDecimal::from(2),
                usd_value: None,
            },
        ];
        insert_snapshot_rows_if_absent(&pool, &rows).await?;

        let buckets = [day(0), day(1), day(2), day(3), day(4)];
        let chart = load_chart_rows(&pool, account_id, &buckets).await?;

        let coordinates: Vec<(String, DateTime<Utc>, BigDecimal)> = chart
            .into_iter()
            .map(|row| (row.asset, row.bucket, row.balance))
            .collect();
        assert_eq!(
            coordinates,
            vec![
                // No day(0) row for either asset: history starts at day(1).
                ("near".to_string(), day(1), BigDecimal::from(5)),
                ("near".to_string(), day(2), BigDecimal::from(5)),
                ("near".to_string(), day(3), BigDecimal::from(8)),
                ("near".to_string(), day(4), BigDecimal::from(8)),
                // wrap.near only exists from day(3); no zeros before that.
                ("wrap.near".to_string(), day(3), BigDecimal::from(2)),
                ("wrap.near".to_string(), day(4), BigDecimal::from(2)),
            ]
        );
        Ok(())
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn missing_usd_scan_drains_beyond_one_thousand_and_updates_exact_key(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        let account_id = "snapshot-usd-scan.sputnik-dao.near";
        let start = DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let rows = (0..1_205)
            .map(|offset| PublicBalanceSnapshotRow {
                dao_id: account_id.to_string(),
                asset: "unmapped.near".to_string(),
                block_height: offset,
                block_time: start + Duration::seconds(offset),
                balance: BigDecimal::from(1),
                usd_value: None,
            })
            .collect::<Vec<_>>();
        insert_snapshot_rows_if_absent(&pool, &rows).await?;

        let first = load_missing_usd_rows(&pool, None, 1_000).await?;
        assert_eq!(first.len(), 1_000);
        let cursor = SnapshotUsdScanCursor::from(first.last().unwrap());
        let second = load_missing_usd_rows(&pool, Some(&cursor), 5_000).await?;
        assert_eq!(second.len(), 205);
        assert_eq!(second.first().unwrap().block_height, 1_000);

        let mut patch = second[0].clone();
        patch.usd_value = Some(BigDecimal::from(42));
        assert_eq!(
            update_snapshot_usd_values(&pool, std::slice::from_ref(&patch)).await?,
            1
        );
        assert_eq!(update_snapshot_usd_values(&pool, &[patch]).await?, 0);

        let values: Vec<(i64, Option<BigDecimal>)> = sqlx::query_as(
            r#"
            SELECT block_height, usd_value
            FROM public_balance_snapshot
            WHERE dao_id = $1
              AND asset = 'unmapped.near'
              AND block_height IN (1000, 1001)
            ORDER BY block_height
            "#,
        )
        .bind(account_id)
        .fetch_all(&pool)
        .await?;
        assert_eq!(
            values,
            vec![(1_000, Some(BigDecimal::from(42))), (1_001, None),]
        );
        Ok(())
    }
}
