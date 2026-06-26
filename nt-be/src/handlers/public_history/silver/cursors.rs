use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};

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
            WHEN EXCLUDED.silver_recompute_from IS NULL
                THEN silver_public_history_cursors.silver_recompute_from
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
    sqlx::query(MARK_SILVER_DIRTY_SQL)
        .bind(account_id)
        .bind(recompute_from)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn mark_silver_dirty_tx(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    sqlx::query(MARK_SILVER_DIRTY_SQL)
        .bind(account_id)
        .bind(recompute_from)
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
