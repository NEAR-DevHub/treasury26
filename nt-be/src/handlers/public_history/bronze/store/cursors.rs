use sqlx::PgPool;

use super::models::{PublicHistoryCursor, PublicHistorySource};
use crate::handlers::public_history::gold::cursors::mark_gold_force_full_recompute_tx;

/// A public DAO is projection-ready only after every NearBlocks source has
/// walked to its terminal page. Missing cursor rows deliberately count as
/// incomplete.
pub async fn is_public_history_backfill_complete(
    pool: &PgPool,
    account_id: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT COUNT(*) = 3
        FROM bronze_public_history_cursors
        WHERE account_id = $1
          AND source IN (
              'nearblocks_ft'::public_history_source,
              'nearblocks_mt'::public_history_source,
              'nearblocks_receipt'::public_history_source
          )
          AND backfill_done = true
        "#,
    )
    .bind(account_id)
    .fetch_one(pool)
    .await
}

pub async fn load_public_history_cursor(
    pool: &PgPool,
    account_id: &str,
    source: PublicHistorySource,
) -> Result<Option<PublicHistoryCursor>, sqlx::Error> {
    sqlx::query_as::<_, PublicHistoryCursor>(
        r#"
        SELECT
            account_id,
            source::text AS source,
            backward_cursor,
            backfill_done,
            last_seen_block_height
        FROM bronze_public_history_cursors
        WHERE account_id = $1
          AND source = $2::public_history_source
        "#,
    )
    .bind(account_id)
    .bind(source.as_str())
    .fetch_optional(pool)
    .await
}

pub async fn save_public_backfill_progress(
    pool: &PgPool,
    account_id: &str,
    source: PublicHistorySource,
    backward_cursor: Option<&str>,
    backfill_done: bool,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        INSERT INTO bronze_public_history_cursors (
            account_id,
            source,
            backward_cursor,
            backfill_done,
            updated_at
        )
        VALUES ($1, $2::public_history_source, $3, $4, NOW())
        ON CONFLICT (account_id, source) DO UPDATE SET
            backward_cursor = COALESCE(
                EXCLUDED.backward_cursor,
                bronze_public_history_cursors.backward_cursor
            ),
            backfill_done = bronze_public_history_cursors.backfill_done
                OR EXCLUDED.backfill_done,
            updated_at = NOW()
        "#,
    )
    .bind(account_id)
    .bind(source.as_str())
    .bind(backward_cursor)
    .bind(backfill_done)
    .execute(&mut *tx)
    .await?;

    let all_sources_complete: bool = sqlx::query_scalar(
        r#"
        SELECT COUNT(*) = 3
        FROM bronze_public_history_cursors
        WHERE account_id = $1
          AND source IN (
              'nearblocks_ft'::public_history_source,
              'nearblocks_mt'::public_history_source,
              'nearblocks_receipt'::public_history_source
          )
          AND backfill_done = true
        "#,
    )
    .bind(account_id)
    .fetch_one(&mut *tx)
    .await?;

    // This also gives fully-backfilled accounts with no events an empty gold
    // projection, allowing them to publish a safe readiness marker.
    if all_sources_complete {
        mark_gold_force_full_recompute_tx(&mut tx, account_id).await?;
    }

    tx.commit().await?;

    Ok(())
}

pub async fn record_public_history_poll_result(
    pool: &PgPool,
    account_id: &str,
    source: PublicHistorySource,
    last_seen_block_height: Option<i64>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO bronze_public_history_cursors (
            account_id,
            source,
            last_seen_block_height,
            updated_at
        )
        VALUES (
            $1,
            $2::public_history_source,
            $3,
            NOW()
        )
        ON CONFLICT (account_id, source) DO UPDATE SET
            last_seen_block_height = COALESCE(
                GREATEST(
                    bronze_public_history_cursors.last_seen_block_height,
                    EXCLUDED.last_seen_block_height
                ),
                bronze_public_history_cursors.last_seen_block_height,
                EXCLUDED.last_seen_block_height
            ),
            updated_at = NOW()
        "#,
    )
    .bind(account_id)
    .bind(source.as_str())
    .bind(last_seen_block_height)
    .execute(pool)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[sqlx::test]
    async fn backfill_is_complete_only_when_all_sources_are_done(pool: PgPool) -> sqlx::Result<()> {
        let account_id = "backfill-readiness-test.sputnik-dao.near";
        assert!(!is_public_history_backfill_complete(&pool, account_id).await?);

        for source in [
            PublicHistorySource::NearblocksFt,
            PublicHistorySource::NearblocksMt,
        ] {
            save_public_backfill_progress(&pool, account_id, source, None, true).await?;
        }
        assert!(!is_public_history_backfill_complete(&pool, account_id).await?);

        save_public_backfill_progress(
            &pool,
            account_id,
            PublicHistorySource::NearblocksReceipt,
            None,
            true,
        )
        .await?;
        assert!(is_public_history_backfill_complete(&pool, account_id).await?);

        let gold_projection_scheduled: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM gold_public_history_cursors
                WHERE account_id = $1
                  AND gold_dirty_since IS NOT NULL
                  AND projection_ready_at IS NULL
            )
            "#,
        )
        .bind(account_id)
        .fetch_one(&pool)
        .await?;
        assert!(gold_projection_scheduled);

        let (force_full, recompute_from): (bool, Option<chrono::DateTime<chrono::Utc>>) =
            sqlx::query_as(
                r#"
                SELECT gold_force_full_recompute, gold_recompute_from
                FROM gold_public_history_cursors
                WHERE account_id = $1
                "#,
            )
            .bind(account_id)
            .fetch_one(&pool)
            .await?;
        assert!(force_full);
        assert!(recompute_from.is_none());

        crate::handlers::public_history::gold::cursors::mark_gold_dirty(
            &pool,
            account_id,
            Some(chrono::Utc::now()),
        )
        .await?;
        let (force_full, recompute_from): (bool, Option<chrono::DateTime<chrono::Utc>>) =
            sqlx::query_as(
                r#"
                SELECT gold_force_full_recompute, gold_recompute_from
                FROM gold_public_history_cursors
                WHERE account_id = $1
                "#,
            )
            .bind(account_id)
            .fetch_one(&pool)
            .await?;
        assert!(force_full);
        assert!(recompute_from.is_none());

        Ok(())
    }
}
