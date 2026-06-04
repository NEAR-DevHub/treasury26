use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};

const MARK_GOLD_DIRTY_SQL: &str = r#"
    INSERT INTO gold_confidential_history_cursors (
        account_id,
        gold_dirty_since,
        gold_recompute_from,
        updated_at
    )
    VALUES ($1, NOW(), $2, NOW())
    ON CONFLICT (account_id) DO UPDATE SET
        gold_dirty_since = NOW(),
        gold_recompute_from = CASE
            WHEN EXCLUDED.gold_recompute_from IS NULL THEN gold_confidential_history_cursors.gold_recompute_from
            WHEN gold_confidential_history_cursors.gold_recompute_from IS NULL THEN EXCLUDED.gold_recompute_from
            ELSE LEAST(gold_confidential_history_cursors.gold_recompute_from, EXCLUDED.gold_recompute_from)
        END,
        updated_at = NOW()
"#;

pub(crate) async fn mark_gold_dirty(
    pool: &PgPool,
    dao_id: &str,
    recompute_from: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    sqlx::query(MARK_GOLD_DIRTY_SQL)
        .bind(dao_id)
        .bind(recompute_from)
        .execute(pool)
        .await?;
    Ok(())
}

/// Transaction-scoped so the bronze upsert and dirty flag commit atomically.
pub async fn mark_gold_dirty_tx(
    tx: &mut Transaction<'_, Postgres>,
    dao_id: &str,
    recompute_from: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    sqlx::query(MARK_GOLD_DIRTY_SQL)
        .bind(dao_id)
        .bind(recompute_from)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub async fn mark_gold_dirty_for_history_event(
    pool: &PgPool,
    history_event_id: i64,
) -> Result<(), sqlx::Error> {
    let row = sqlx::query_as::<_, (String, DateTime<Utc>)>(
        r#"
        SELECT account_id, created_at_external
        FROM bronze_confidential_history_events
        WHERE id = $1
        "#,
    )
    .bind(history_event_id)
    .fetch_optional(pool)
    .await?;

    if let Some((dao_id, recompute_from)) = row {
        mark_gold_dirty(pool, &dao_id, Some(recompute_from)).await?;
    }

    Ok(())
}

pub(crate) async fn clear_gold_dirty_if_not_advanced(
    tx: &mut Transaction<'_, Postgres>,
    dao_id: &str,
    dirty_since: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE gold_confidential_history_cursors
        SET gold_dirty_since = NULL,
            gold_recompute_from = NULL,
            updated_at = NOW()
        WHERE account_id = $1
          AND gold_dirty_since <= $2
        "#,
    )
    .bind(dao_id)
    .bind(dirty_since)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub async fn mark_backfilled_confidential_daos_gold_dirty(
    pool: &PgPool,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        WITH eligible_accounts AS (
            SELECT ma.account_id
            FROM monitored_accounts ma
            JOIN bronze_confidential_history_cursors bchc
                ON bchc.account_id = ma.account_id
               AND bchc.backfill_done = true
            LEFT JOIN gold_confidential_history_cursors gchc
                ON gchc.account_id = ma.account_id
            WHERE ma.enabled = true
              AND ma.is_confidential_account = true
              AND (
                  gchc.account_id IS NULL
                  OR gchc.gold_dirty_since IS NOT NULL
                  OR NOT EXISTS (
                      SELECT 1
                      FROM gold_confidential_history_events ghe
                      WHERE ghe.dao_id = ma.account_id
                  )
              )
        ),
        rows_to_mark AS (
            SELECT
                ea.account_id,
                MIN(bche.created_at_external) AS recompute_from
            FROM eligible_accounts ea
            JOIN bronze_confidential_history_events bche
                ON bche.account_id = ea.account_id
               AND bche.status = 'SUCCESS'
            GROUP BY ea.account_id
        )
        INSERT INTO gold_confidential_history_cursors (
            account_id,
            gold_dirty_since,
            gold_recompute_from,
            updated_at
        )
        SELECT
            account_id,
            NOW(),
            recompute_from,
            NOW()
        FROM rows_to_mark
        ON CONFLICT (account_id) DO UPDATE SET
            gold_dirty_since = NOW(),
            gold_recompute_from = CASE
                WHEN gold_confidential_history_cursors.gold_recompute_from IS NULL
                    THEN EXCLUDED.gold_recompute_from
                ELSE LEAST(
                    gold_confidential_history_cursors.gold_recompute_from,
                    EXCLUDED.gold_recompute_from
                )
            END,
            updated_at = NOW()
        "#,
    )
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}
