use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};

const PUBLIC_GOLD_PROJECTION_READY_VERSION: i32 = 1;

const MARK_GOLD_DIRTY_SQL: &str = r#"
    INSERT INTO gold_public_history_cursors (
        account_id,
        gold_dirty_since,
        gold_recompute_from,
        projection_ready_at,
        projection_ready_version,
        projection_validation_pending,
        updated_at
    )
    VALUES ($1, NOW(), $2, NULL, 0, true, NOW())
    ON CONFLICT (account_id) DO UPDATE SET
        gold_dirty_since = NOW(),
        gold_recompute_from = CASE
            WHEN gold_public_history_cursors.gold_force_full_recompute
                THEN NULL
            WHEN EXCLUDED.gold_recompute_from IS NULL
                THEN gold_public_history_cursors.gold_recompute_from
            WHEN gold_public_history_cursors.gold_recompute_from IS NULL
                THEN EXCLUDED.gold_recompute_from
            ELSE LEAST(
                gold_public_history_cursors.gold_recompute_from,
                EXCLUDED.gold_recompute_from
            )
        END,
        projection_ready_at = NULL,
        projection_ready_version = 0,
        projection_validation_pending = true,
        updated_at = NOW()
"#;

const INVALIDATE_GOLD_PROJECTION_READY_SQL: &str = r#"
    INSERT INTO gold_public_history_cursors (
        account_id,
        projection_ready_at,
        projection_ready_version,
        projection_validation_pending,
        updated_at
    )
    VALUES ($1, NULL, 0, true, NOW())
    ON CONFLICT (account_id) DO UPDATE SET
        projection_ready_at = NULL,
        projection_ready_version = 0,
        projection_validation_pending = true,
        updated_at = NOW()
"#;

const MARK_GOLD_FORCE_FULL_RECOMPUTE_SQL: &str = r#"
    INSERT INTO gold_public_history_cursors (
        account_id,
        gold_dirty_since,
        gold_recompute_from,
        projection_ready_at,
        projection_ready_version,
        projection_validation_pending,
        gold_force_full_recompute,
        updated_at
    )
    VALUES ($1, NOW(), NULL, NULL, 0, true, true, NOW())
    ON CONFLICT (account_id) DO UPDATE SET
        gold_dirty_since = NOW(),
        gold_recompute_from = NULL,
        projection_ready_at = NULL,
        projection_ready_version = 0,
        projection_validation_pending = true,
        gold_force_full_recompute = true,
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

pub async fn mark_gold_force_full_recompute_tx(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(MARK_GOLD_FORCE_FULL_RECOMPUTE_SQL)
        .bind(account_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub async fn invalidate_gold_projection_ready_tx(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(INVALIDATE_GOLD_PROJECTION_READY_SQL)
        .bind(account_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Recover durable validation work after an older binary cleared only the
/// legacy dirty timestamp during a rolling deployment.
pub async fn ensure_gold_projection_scheduled_tx(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE gold_public_history_cursors
        SET gold_dirty_since = NOW(),
            updated_at = NOW()
        WHERE account_id = $1
          AND projection_validation_pending = true
          AND gold_dirty_since IS NULL
        "#,
    )
    .bind(account_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn has_public_history_projection_errors(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM silver_public_history_projection_errors
            WHERE account_id = $1
        ) OR EXISTS (
            SELECT 1
            FROM gold_public_history_projection_errors
            WHERE dao_id = $1
        )
        "#,
    )
    .bind(account_id)
    .fetch_one(&mut **tx)
    .await
}

/// Atomically clear the processed dirty cursor and publish the durable read
/// marker. The update is refused while silver has newer work or bronze is not
/// fully backfilled, leaving the gold cursor dirty for a later retry.
pub async fn complete_gold_projection_if_current(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    dirty_since: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    let completed = sqlx::query_scalar::<_, bool>(
        r#"
        UPDATE gold_public_history_cursors gold_cursor
        SET gold_dirty_since = NULL,
            gold_recompute_from = NULL,
            projection_ready_at = NOW(),
            projection_ready_version = $3,
            projection_validation_pending = false,
            gold_force_full_recompute = false,
            updated_at = NOW()
        WHERE gold_cursor.account_id = $1
          AND gold_cursor.gold_dirty_since <= $2
          AND (
              SELECT COUNT(*)
              FROM bronze_public_history_cursors bronze_cursor
              WHERE bronze_cursor.account_id = gold_cursor.account_id
                AND bronze_cursor.source IN (
                    'nearblocks_ft'::public_history_source,
                    'nearblocks_mt'::public_history_source,
                    'nearblocks_receipt'::public_history_source
                )
                AND bronze_cursor.backfill_done = true
          ) = 3
          AND NOT EXISTS (
              SELECT 1
              FROM silver_public_history_cursors silver_cursor
              WHERE silver_cursor.account_id = gold_cursor.account_id
                AND silver_cursor.silver_dirty_since IS NOT NULL
          )
          AND NOT EXISTS (
              SELECT 1
              FROM silver_public_history_projection_errors silver_error
              WHERE silver_error.account_id = gold_cursor.account_id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM gold_public_history_projection_errors gold_error
              WHERE gold_error.dao_id = gold_cursor.account_id
          )
        RETURNING true
        "#,
    )
    .bind(account_id)
    .bind(dirty_since)
    .bind(PUBLIC_GOLD_PROJECTION_READY_VERSION)
    .fetch_optional(&mut **tx)
    .await?;

    Ok(completed.unwrap_or(false))
}

/// A public account is safe to serve from gold only when the last successful
/// projection published readiness and no bronze, silver, or gold work remains.
pub async fn is_public_gold_projection_ready(
    pool: &PgPool,
    account_id: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM gold_public_history_cursors gold_cursor
            WHERE gold_cursor.account_id = $1
              AND gold_cursor.projection_ready_at IS NOT NULL
              AND gold_cursor.projection_ready_version = $2
              AND gold_cursor.projection_validation_pending = false
              AND gold_cursor.gold_force_full_recompute = false
              AND gold_cursor.gold_dirty_since IS NULL
              AND (
                  SELECT COUNT(*)
                  FROM bronze_public_history_cursors bronze_cursor
                  WHERE bronze_cursor.account_id = gold_cursor.account_id
                    AND bronze_cursor.source IN (
                        'nearblocks_ft'::public_history_source,
                        'nearblocks_mt'::public_history_source,
                        'nearblocks_receipt'::public_history_source
                    )
                    AND bronze_cursor.backfill_done = true
              ) = 3
              AND NOT EXISTS (
                  SELECT 1
                  FROM silver_public_history_cursors silver_cursor
                  WHERE silver_cursor.account_id = gold_cursor.account_id
                    AND silver_cursor.silver_dirty_since IS NOT NULL
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM silver_public_history_projection_errors silver_error
                  WHERE silver_error.account_id = gold_cursor.account_id
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM gold_public_history_projection_errors gold_error
                  WHERE gold_error.dao_id = gold_cursor.account_id
              )
        )
        "#,
    )
    .bind(account_id)
    .bind(PUBLIC_GOLD_PROJECTION_READY_VERSION)
    .fetch_one(pool)
    .await
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
            projection_validation_pending = false,
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
