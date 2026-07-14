use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};

const MARK_GOLD_DIRTY_SQL: &str = r#"
    INSERT INTO gold_public_history_cursors (
        account_id,
        gold_dirty_since,
        gold_recompute_from,
        updated_at
    )
    VALUES ($1, NOW(), $2, NOW())
    ON CONFLICT (account_id) DO UPDATE SET
        gold_dirty_since = NOW(),
        gold_recompute_from = CASE
            WHEN EXCLUDED.gold_recompute_from IS NULL
                THEN gold_public_history_cursors.gold_recompute_from
            WHEN gold_public_history_cursors.gold_recompute_from IS NULL
                THEN EXCLUDED.gold_recompute_from
            ELSE LEAST(
                gold_public_history_cursors.gold_recompute_from,
                EXCLUDED.gold_recompute_from
            )
        END,
        updated_at = NOW()
"#;

pub async fn mark_gold_dirty(
    pool: &PgPool,
    account_id: &str,
    recompute_from: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    sqlx::query(MARK_GOLD_DIRTY_SQL)
        .bind(account_id)
        .bind(recompute_from)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn mark_gold_dirty_tx(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    sqlx::query(MARK_GOLD_DIRTY_SQL)
        .bind(account_id)
        .bind(recompute_from)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub async fn clear_gold_dirty_if_not_advanced(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    dirty_since: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE gold_public_history_cursors
        SET gold_dirty_since = NULL,
            gold_recompute_from = NULL,
            updated_at = NOW()
        WHERE account_id = $1
          AND gold_dirty_since <= $2
        "#,
    )
    .bind(account_id)
    .bind(dirty_since)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
