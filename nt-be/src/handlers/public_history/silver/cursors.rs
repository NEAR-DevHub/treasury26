use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};

use crate::handlers::public_history::gold::cursors::invalidate_gold_projection_ready_tx;

#[derive(Debug, sqlx::FromRow)]
struct SilverDirtyState {
    silver_dirty_since: Option<DateTime<Utc>>,
    silver_recompute_from: Option<DateTime<Utc>>,
    snapshot_cursor_exists: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SnapshotDirtyChange {
    InitialSilverCursor,
    MissingSnapshotCursor,
    NewWindow,
    ExpandedBoundary,
    Unchanged,
}

impl SnapshotDirtyChange {
    fn should_bump_generation(self) -> bool {
        self != Self::Unchanged
    }
}

fn classify_snapshot_dirty_change(
    prior: Option<&SilverDirtyState>,
    recompute_from: Option<DateTime<Utc>>,
) -> SnapshotDirtyChange {
    let Some(prior) = prior else {
        return SnapshotDirtyChange::InitialSilverCursor;
    };
    if !prior.snapshot_cursor_exists {
        return SnapshotDirtyChange::MissingSnapshotCursor;
    }
    if prior.silver_dirty_since.is_none() {
        return SnapshotDirtyChange::NewWindow;
    }
    if prior
        .silver_recompute_from
        .is_some_and(|previous| recompute_from.is_none_or(|requested| requested < previous))
    {
        return SnapshotDirtyChange::ExpandedBoundary;
    }
    SnapshotDirtyChange::Unchanged
}

const MARK_SILVER_DIRTY_SQL: &str = r#"
    INSERT INTO silver_public_history_cursors (
        account_id,
        silver_dirty_since,
        silver_recompute_from,
        updated_at
    )
    VALUES ($1, NOW(), $2, NOW())
    ON CONFLICT (account_id) DO UPDATE SET
        silver_dirty_since = NOW(),
        silver_recompute_from = CASE
            WHEN silver_public_history_cursors.silver_dirty_since IS NOT NULL
                 AND silver_public_history_cursors.silver_recompute_from IS NULL
                THEN NULL
            WHEN EXCLUDED.silver_recompute_from IS NULL
                THEN NULL
            WHEN silver_public_history_cursors.silver_recompute_from IS NULL
                THEN EXCLUDED.silver_recompute_from
            ELSE LEAST(
                silver_public_history_cursors.silver_recompute_from,
                EXCLUDED.silver_recompute_from
            )
        END,
        updated_at = NOW()
"#;

const MARK_SNAPSHOT_DIRTY_SQL: &str = r#"
    INSERT INTO public_balance_snapshot_cursors (
        account_id,
        snapshot_dirty_generation,
        snapshot_applied_generation,
        snapshot_recompute_from
    )
    VALUES ($1, 1, 0, $2)
    ON CONFLICT (account_id) DO UPDATE SET
        snapshot_recompute_from = CASE
            WHEN public_balance_snapshot_cursors.snapshot_dirty_generation
                    > public_balance_snapshot_cursors.snapshot_applied_generation
                 AND public_balance_snapshot_cursors.snapshot_recompute_from IS NULL
                THEN NULL
            WHEN EXCLUDED.snapshot_recompute_from IS NULL
                THEN NULL
            WHEN public_balance_snapshot_cursors.snapshot_dirty_generation
                    = public_balance_snapshot_cursors.snapshot_applied_generation
                THEN EXCLUDED.snapshot_recompute_from
            ELSE LEAST(
                public_balance_snapshot_cursors.snapshot_recompute_from,
                EXCLUDED.snapshot_recompute_from
            )
        END,
        snapshot_dirty_generation =
            public_balance_snapshot_cursors.snapshot_dirty_generation + 1
"#;

pub async fn mark_silver_dirty(
    pool: &PgPool,
    account_id: &str,
    recompute_from: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    mark_silver_dirty_tx(&mut tx, account_id, recompute_from).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn mark_silver_dirty_tx(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    // Serialize both new and existing cursor rows with the Silver projector.
    // Row locking alone cannot protect two concurrent first inserts.
    lock_silver_cursor_tx(tx, account_id).await?;

    let prior = sqlx::query_as::<_, SilverDirtyState>(
        r#"
        SELECT
            silver.silver_dirty_since,
            silver.silver_recompute_from,
            EXISTS (
                SELECT 1
                FROM public_balance_snapshot_cursors snapshot
                WHERE snapshot.account_id = silver.account_id
            ) AS snapshot_cursor_exists
        FROM silver_public_history_cursors silver
        WHERE silver.account_id = $1
        FOR UPDATE OF silver
        "#,
    )
    .bind(account_id)
    .fetch_optional(&mut **tx)
    .await?;

    // One snapshot generation represents one Silver dirty window. Repeated
    // marks in that window bump the generation only when they expand the
    // required history to an earlier boundary or to a full rebuild.
    let snapshot_change = classify_snapshot_dirty_change(prior.as_ref(), recompute_from);

    sqlx::query(MARK_SILVER_DIRTY_SQL)
        .bind(account_id)
        .bind(recompute_from)
        .execute(&mut **tx)
        .await?;

    if snapshot_change.should_bump_generation() {
        sqlx::query(MARK_SNAPSHOT_DIRTY_SQL)
            .bind(account_id)
            .bind(recompute_from)
            .execute(&mut **tx)
            .await?;
    }

    invalidate_gold_projection_ready_tx(tx, account_id).await?;
    Ok(())
}

pub async fn lock_silver_cursor_tx(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("public-silver:{account_id}"))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub async fn clear_silver_dirty_if_not_advanced(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    dirty_since: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE silver_public_history_cursors
        SET silver_dirty_since = NULL,
            silver_recompute_from = NULL,
            updated_at = NOW()
        WHERE account_id = $1
          AND silver_dirty_since <= $2
        "#,
    )
    .bind(account_id)
    .bind(dirty_since)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;

    #[sqlx::test]
    async fn rust_dirty_mark_bumps_only_for_dirty_work_and_preserves_boundaries(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        let account_id = "snapshot-rust-dirty.sputnik-dao.near";
        let early = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let late = Utc.with_ymd_and_hms(2025, 2, 1, 0, 0, 0).unwrap();

        mark_silver_dirty(&pool, account_id, Some(late)).await?;
        let first: (i64, i64, Option<DateTime<Utc>>) = sqlx::query_as(
            r#"
            SELECT snapshot_dirty_generation,
                   snapshot_applied_generation,
                   snapshot_recompute_from
            FROM public_balance_snapshot_cursors
            WHERE account_id = $1
            "#,
        )
        .bind(account_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(first, (1, 0, Some(late)));

        sqlx::query(
            "UPDATE silver_public_history_cursors SET updated_at = NOW() WHERE account_id = $1",
        )
        .bind(account_id)
        .execute(&pool)
        .await?;
        let generation: i64 = sqlx::query_scalar(
            "SELECT snapshot_dirty_generation FROM public_balance_snapshot_cursors WHERE account_id = $1",
        )
        .bind(account_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(generation, 1, "unrelated cursor updates must not bump");

        mark_silver_dirty(&pool, account_id, Some(early)).await?;
        let second: (i64, Option<DateTime<Utc>>) = sqlx::query_as(
            "SELECT snapshot_dirty_generation, snapshot_recompute_from FROM public_balance_snapshot_cursors WHERE account_id = $1",
        )
        .bind(account_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(second, (2, Some(early)));

        mark_silver_dirty(&pool, account_id, None).await?;
        mark_silver_dirty(&pool, account_id, Some(late)).await?;
        let full_rebuild: (i64, Option<DateTime<Utc>>) = sqlx::query_as(
            "SELECT snapshot_dirty_generation, snapshot_recompute_from FROM public_balance_snapshot_cursors WHERE account_id = $1",
        )
        .bind(account_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(full_rebuild, (3, None));

        sqlx::query(
            r#"
            UPDATE public_balance_snapshot_cursors
            SET snapshot_applied_generation = snapshot_dirty_generation,
                snapshot_recompute_from = NULL,
                snapshot_applied_at = NOW()
            WHERE account_id = $1
            "#,
        )
        .bind(account_id)
        .execute(&pool)
        .await?;
        sqlx::query(
            r#"
            UPDATE silver_public_history_cursors
            SET silver_dirty_since = NULL,
                silver_recompute_from = NULL,
                updated_at = NOW()
            WHERE account_id = $1
            "#,
        )
        .bind(account_id)
        .execute(&pool)
        .await?;

        mark_silver_dirty(&pool, account_id, Some(late)).await?;
        let next_window: (i64, i64, Option<DateTime<Utc>>) = sqlx::query_as(
            "SELECT snapshot_dirty_generation, snapshot_applied_generation, snapshot_recompute_from FROM public_balance_snapshot_cursors WHERE account_id = $1",
        )
        .bind(account_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(next_window, (4, 3, Some(late)));

        Ok(())
    }

    #[sqlx::test]
    async fn concurrent_first_dirty_marks_share_one_snapshot_generation(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        let account_id = "snapshot-rust-concurrent.sputnik-dao.near";
        let boundary = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();

        let (first, second) = tokio::join!(
            mark_silver_dirty(&pool, account_id, Some(boundary)),
            mark_silver_dirty(&pool, account_id, Some(boundary)),
        );
        first?;
        second?;

        let generation: i64 = sqlx::query_scalar(
            "SELECT snapshot_dirty_generation FROM public_balance_snapshot_cursors WHERE account_id = $1",
        )
        .bind(account_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(generation, 1);

        Ok(())
    }

    #[sqlx::test]
    async fn public_balance_snapshot_rejects_negative_values(pool: PgPool) -> sqlx::Result<()> {
        let error = sqlx::query(
            r#"
            INSERT INTO public_balance_snapshot (
                dao_id, asset, block_height, block_time, balance, usd_value
            )
            VALUES ('dao.near', 'near', 1, NOW(), -1, 0)
            "#,
        )
        .execute(&pool)
        .await
        .expect_err("negative balances must be rejected");

        assert!(matches!(error, sqlx::Error::Database(_)));
        Ok(())
    }
}
