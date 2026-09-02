use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};

use crate::handlers::public_history::gold::cursors::invalidate_gold_projection_ready_tx;

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

    sqlx::query(MARK_SILVER_DIRTY_SQL)
        .bind(account_id)
        .bind(recompute_from)
        .execute(&mut **tx)
        .await?;

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
    async fn silver_dirty_mark_keeps_earliest_recompute_boundary(pool: PgPool) -> sqlx::Result<()> {
        let account_id = "silver-dirty-boundary.sputnik-dao.near";
        let early = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let late = Utc.with_ymd_and_hms(2025, 2, 1, 0, 0, 0).unwrap();

        mark_silver_dirty(&pool, account_id, Some(late)).await?;
        mark_silver_dirty(&pool, account_id, Some(early)).await?;
        mark_silver_dirty(&pool, account_id, Some(late)).await?;

        let recompute_from: Option<DateTime<Utc>> = sqlx::query_scalar(
            "SELECT silver_recompute_from FROM silver_public_history_cursors WHERE account_id = $1",
        )
        .bind(account_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(recompute_from, Some(early));

        mark_silver_dirty(&pool, account_id, None).await?;
        let recompute_from: Option<DateTime<Utc>> = sqlx::query_scalar(
            "SELECT silver_recompute_from FROM silver_public_history_cursors WHERE account_id = $1",
        )
        .bind(account_id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(recompute_from, None, "full rebuild wins over any boundary");

        Ok(())
    }
}
