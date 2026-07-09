use sqlx::PgPool;

use super::models::{PublicHistoryCursor, PublicHistorySource};

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
    .execute(pool)
    .await?;

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
