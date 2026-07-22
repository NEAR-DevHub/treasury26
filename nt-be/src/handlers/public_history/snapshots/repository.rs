use bigdecimal::{BigDecimal, num_traits::Signed};
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};

use crate::handlers::public_history::bronze::store::PublicHistorySource;
use crate::handlers::public_history::silver::cursors::{
    lock_silver_cursor_tx, mark_silver_dirty_tx,
};

use super::models::{
    BronzeSnapshotCoordinate, HistoricalAssetRow, PublicBalanceSnapshotRow, SilverSnapshotLeg,
    SnapshotBootstrapCandidate, SnapshotBootstrapStats, SnapshotChartRow, SnapshotCursor,
};

const INTENTS_MULTI_TOKEN_CONTRACT: &str = "intents.near";

/// Dirty public accounts that are safe to start building. Readiness is
/// revalidated under the publication lock; this query only avoids wasted RPC.
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
            cursor.snapshot_applied_at
        FROM public_balance_snapshot_cursors cursor
        JOIN monitored_accounts monitored
          ON monitored.account_id = cursor.account_id
         AND monitored.enabled = true
         AND COALESCE(monitored.is_confidential_account, false) = false
        WHERE cursor.snapshot_dirty_generation > cursor.snapshot_applied_generation
          AND (
              SELECT COUNT(*)
              FROM bronze_public_history_cursors refreshed
              WHERE refreshed.account_id = cursor.account_id
                AND refreshed.source IN (
                    'nearblocks_ft'::public_history_source,
                    'nearblocks_mt'::public_history_source,
                    'nearblocks_receipt'::public_history_source
                )
                AND refreshed.latest_refresh_at >= NOW() - INTERVAL '15 minutes'
                AND refreshed.latest_refresh_cutoff_block_height IS NOT NULL
          ) = 3
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
            snapshot_applied_at
        FROM public_balance_snapshot_cursors
        WHERE account_id = $1
        "#,
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
}

/// Seeds the first full snapshot generation in Rust and repairs historical
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

/// Full historical asset inventory. Synthetic quote rows are deliberately
/// excluded: they describe an expected exchange, not an on-chain balance.
pub async fn load_historical_assets(
    pool: &PgPool,
    account_id: &str,
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
        ORDER BY token_standard, token_id
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
}

pub async fn load_historical_multi_token_contracts(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT DISTINCT contract_account_id
        FROM bronze_public_history_events
        WHERE account_id = $1
          AND source = 'nearblocks_mt'::public_history_source
          AND contract_account_id IS NOT NULL
        ORDER BY contract_account_id
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
}

pub async fn load_real_silver_legs(
    pool: &PgPool,
    account_id: &str,
    after_block_height: Option<i64>,
) -> Result<Vec<SilverSnapshotLeg>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT
            token_standard::text AS token_standard,
            token_id,
            direction::text AS direction,
            leg_kind::text AS leg_kind,
            block_height,
            block_time,
            amount_raw,
            decimals
        FROM silver_public_transfer_legs
        WHERE account_id = $1
          AND source <> 'quote_projection'::public_history_source
          AND leg_kind <> 'quote_pending'::public_transfer_leg_kind
          AND ($2::bigint IS NULL OR block_height > $2)
        ORDER BY block_height, block_time, id
        "#,
    )
    .bind(account_id)
    .bind(after_block_height)
    .fetch_all(pool)
    .await
}

/// Successful receipt blocks are the authoritative native event coordinates.
/// A receipt need not contain an explicit native transfer: gas, storage and an
/// attached function-call deposit can all change the account balance.
pub async fn load_native_event_coordinates(
    pool: &PgPool,
    account_id: &str,
    from: Option<DateTime<Utc>>,
) -> Result<Vec<BronzeSnapshotCoordinate>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT DISTINCT ON (block_height)
            block_height,
            block_time,
            contract_account_id,
            method_name
        FROM bronze_public_history_events
        WHERE account_id = $1
          AND source = 'nearblocks_receipt'::public_history_source
          AND outcome_status IS TRUE
          AND ($2::timestamptz IS NULL OR block_time >= $2)
        ORDER BY block_height, block_time DESC, id DESC
        "#,
    )
    .bind(account_id)
    .bind(from)
    .fetch_all(pool)
    .await
}

pub async fn load_staking_event_coordinates(
    pool: &PgPool,
    account_id: &str,
    from: Option<DateTime<Utc>>,
) -> Result<Vec<BronzeSnapshotCoordinate>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT DISTINCT ON (block_height, contract_account_id)
            block_height,
            block_time,
            contract_account_id,
            method_name
        FROM bronze_public_history_events
        WHERE account_id = $1
          AND source = 'nearblocks_receipt'::public_history_source
          AND outcome_status IS TRUE
          AND ($2::timestamptz IS NULL OR block_time >= $2)
          AND method_name IN (
              'deposit_and_stake',
              'stake',
              'unstake',
              'unstake_all',
              'withdraw',
              'withdraw_all'
          )
        ORDER BY block_height, contract_account_id, block_time DESC, id DESC
        "#,
    )
    .bind(account_id)
    .bind(from)
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

pub async fn load_complete_snapshot_dataset(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<PublicBalanceSnapshotRow>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT dao_id, asset, block_height, block_time, balance, usd_value
        FROM public_balance_snapshot
        WHERE dao_id = $1
        ORDER BY asset, block_height, block_time
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
}

pub async fn load_missing_usd_rows(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<PublicBalanceSnapshotRow>, sqlx::Error> {
    sqlx::query_as(
        r#"
        WITH missing AS (
            SELECT
                dao_id,
                asset,
                block_height,
                block_time,
                balance,
                usd_value,
                ROW_NUMBER() OVER (
                    ORDER BY block_time, dao_id, asset, block_height
                ) - 1 AS row_index,
                COUNT(*) OVER () AS total_rows
            FROM public_balance_snapshot
            WHERE usd_value IS NULL
        ), selected_page AS (
            SELECT MOD(
                FLOOR(EXTRACT(EPOCH FROM NOW()) / 3600)::bigint,
                GREATEST((total_rows + $1 - 1) / $1, 1)
            ) AS page_number
            FROM missing
            LIMIT 1
        )
        SELECT dao_id, asset, block_height, block_time, balance, usd_value
        FROM missing
        CROSS JOIN selected_page
        WHERE row_index / $1 = selected_page.page_number
        ORDER BY row_index
        LIMIT $1
        "#,
    )
    .bind(limit.max(1))
    .fetch_all(pool)
    .await
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

/// Daily checkpoint scheduler. Only clean cursors are advanced, and only once
/// per UTC day; an already-dirty generation is left untouched for its retry.
pub async fn mark_due_checkpoint_generations(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let bootstrap = bootstrap_public_balance_snapshot_cursors(pool).await?;
    let result = sqlx::query(
        r#"
        UPDATE public_balance_snapshot_cursors cursor
        SET
            snapshot_dirty_generation =
                cursor.snapshot_dirty_generation + 1,
            snapshot_recompute_from = date_trunc('day', NOW())
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
        "#,
    )
    .execute(pool)
    .await?;
    Ok(bootstrap.cursors_seeded + result.rows_affected())
}

pub async fn load_chart_rows(
    pool: &PgPool,
    account_id: &str,
    buckets: &[DateTime<Utc>],
    lower_bounds: &[DateTime<Utc>],
) -> Result<Vec<SnapshotChartRow>, sqlx::Error> {
    if buckets.is_empty() {
        return Ok(Vec::new());
    }
    if buckets.len() != lower_bounds.len() {
        return Err(sqlx::Error::Protocol(
            "snapshot chart buckets and lower bounds differ in length".to_string(),
        ));
    }

    sqlx::query_as(
        r#"
        WITH requested AS (
            SELECT bucket, lower_bound
            FROM UNNEST(
                $2::timestamptz[], $3::timestamptz[]
            ) requested(bucket, lower_bound)
        ), assets AS (
            SELECT DISTINCT asset
            FROM public_balance_snapshot
            WHERE dao_id = $1
        )
        SELECT
            assets.asset,
            requested.bucket,
            point.block_height,
            point.balance,
            point.usd_value
        FROM assets
        CROSS JOIN requested
        JOIN LATERAL (
            SELECT block_height, balance, usd_value
            FROM public_balance_snapshot snapshot
            WHERE snapshot.dao_id = $1
              AND snapshot.asset = assets.asset
              AND snapshot.block_time <= requested.bucket
              AND snapshot.block_time > requested.lower_bound
            ORDER BY snapshot.block_time DESC, snapshot.block_height DESC
            LIMIT 1
        ) point ON TRUE
        ORDER BY assets.asset, requested.bucket
        "#,
    )
    .bind(account_id)
    .bind(buckets)
    .bind(lower_bounds)
    .fetch_all(pool)
    .await
}

async fn source_is_ready(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    required_latest_refresh_at: DateTime<Utc>,
    required_cutoff_block_height: i64,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT
            EXISTS (
                SELECT 1
                FROM monitored_accounts monitored
                WHERE monitored.account_id = $1
                  AND monitored.enabled = true
                  AND COALESCE(monitored.is_confidential_account, false) = false
            )
            AND (
                SELECT COUNT(*) = 3
                FROM bronze_public_history_cursors bronze
                WHERE bronze.account_id = $1
                  AND bronze.source IN (
                      'nearblocks_ft'::public_history_source,
                      'nearblocks_mt'::public_history_source,
                      'nearblocks_receipt'::public_history_source
                  )
                  AND bronze.backfill_done = true
                  AND bronze.latest_refresh_at >= $2
                  AND bronze.latest_refresh_cutoff_block_height >= $3
            )
            AND NOT EXISTS (
                SELECT 1
                FROM silver_public_history_cursors silver
                WHERE silver.account_id = $1
                  AND silver.silver_dirty_since IS NOT NULL
            )
            AND NOT EXISTS (
                SELECT 1
                FROM silver_public_history_projection_errors error
                WHERE error.account_id = $1
            )
        "#,
    )
    .bind(account_id)
    .bind(required_latest_refresh_at)
    .bind(required_cutoff_block_height)
    .fetch_one(&mut **tx)
    .await
}

/// Publish a complete DAO dataset. The advisory lock and generation check
/// make delayed/redelivered jobs harmless. Delete + insert + cursor advance
/// happen in one transaction, so readers observe either complete generation.
pub async fn publish_complete_snapshot_generation(
    pool: &PgPool,
    account_id: &str,
    captured_generation: i64,
    required_latest_refresh_at: DateTime<Utc>,
    required_cutoff_block_height: i64,
    rows: &[PublicBalanceSnapshotRow],
) -> Result<Option<u64>, sqlx::Error> {
    if rows.is_empty() {
        return Err(sqlx::Error::Protocol(
            "refusing to publish an empty public balance snapshot dataset".to_string(),
        ));
    }
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
            snapshot_applied_at
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
        || !source_is_ready(
            &mut tx,
            account_id,
            required_latest_refresh_at,
            required_cutoff_block_height,
        )
        .await?
    {
        tx.rollback().await?;
        return Ok(None);
    }

    sqlx::query("DELETE FROM public_balance_snapshot WHERE dao_id = $1")
        .bind(account_id)
        .execute(&mut *tx)
        .await?;

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
            snapshot_applied_at = NOW()
        WHERE account_id = $1
          AND snapshot_dirty_generation = $2
        "#,
    )
    .bind(account_id)
    .bind(captured_generation)
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
    use chrono::Duration;

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
        let earliest = Utc::now() - Duration::days(30);

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
    async fn publication_is_generation_guarded_and_replaces_the_dao_atomically(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        let account_id = "publish-snapshot.sputnik-dao.near";
        let now = Utc::now();
        sqlx::query(
            r#"
            INSERT INTO monitored_accounts (
                account_id, enabled, is_confidential_account
            )
            VALUES ($1, true, false)
            "#,
        )
        .bind(account_id)
        .execute(&pool)
        .await?;
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
        sqlx::query(
            r#"
            INSERT INTO bronze_public_history_cursors (
                account_id, source, backfill_done, latest_refresh_at,
                latest_refresh_cutoff_block_height
            )
            SELECT $1, source::public_history_source, true, $2, 500
            FROM UNNEST($3::text[]) AS sources(source)
            "#,
        )
        .bind(account_id)
        .bind(now)
        .bind(&["nearblocks_ft", "nearblocks_mt", "nearblocks_receipt"])
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
            publish_complete_snapshot_generation(
                &pool,
                account_id,
                1,
                now - Duration::minutes(1),
                400,
                std::slice::from_ref(&first),
            )
            .await?,
            Some(1)
        );

        sqlx::query(
            r#"
            UPDATE public_balance_snapshot_cursors
            SET snapshot_dirty_generation = 2,
                snapshot_recompute_from = $2
            WHERE account_id = $1
            "#,
        )
        .bind(account_id)
        .bind(now)
        .execute(&pool)
        .await?;
        let stale_worker_row = PublicBalanceSnapshotRow {
            balance: BigDecimal::from(999),
            ..first.clone()
        };
        assert_eq!(
            publish_complete_snapshot_generation(
                &pool,
                account_id,
                1,
                now - Duration::minutes(1),
                400,
                &[stale_worker_row],
            )
            .await?,
            None
        );
        let unchanged: BigDecimal =
            sqlx::query_scalar("SELECT balance FROM public_balance_snapshot WHERE dao_id = $1")
                .bind(account_id)
                .fetch_one(&pool)
                .await?;
        assert_eq!(unchanged, BigDecimal::from(10));

        let replacement = PublicBalanceSnapshotRow {
            dao_id: account_id.to_string(),
            asset: "wrap.near".to_string(),
            block_height: 200,
            block_time: now,
            balance: BigDecimal::from(7),
            usd_value: None,
        };
        assert_eq!(
            publish_complete_snapshot_generation(
                &pool,
                account_id,
                2,
                now - Duration::minutes(1),
                400,
                std::slice::from_ref(&replacement),
            )
            .await?,
            Some(1)
        );
        let stored: Vec<(String, BigDecimal)> =
            sqlx::query_as("SELECT asset, balance FROM public_balance_snapshot WHERE dao_id = $1")
                .bind(account_id)
                .fetch_all(&pool)
                .await?;
        assert_eq!(stored, vec![("wrap.near".to_string(), BigDecimal::from(7))]);

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
        assert_eq!(cursor, (2, 2, None));
        Ok(())
    }
}
