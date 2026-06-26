use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;

use super::models::{PublicHistoryCursor, PublicHistorySource};

const HOT_POLL_DELAY: Duration = Duration::seconds(30);
const RECENT_POLL_DELAY: Duration = Duration::seconds(120);
const WARM_POLL_DELAY: Duration = Duration::seconds(600);
const INACTIVE_POLL_DELAY: Duration = Duration::seconds(3600);

pub(crate) fn public_history_next_poll_delay(
    had_history_changes: bool,
    last_activity_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> Duration {
    if had_history_changes {
        return HOT_POLL_DELAY;
    }

    let Some(last_activity_at) = last_activity_at else {
        return INACTIVE_POLL_DELAY;
    };

    if last_activity_at > now - Duration::hours(2) {
        RECENT_POLL_DELAY
    } else if last_activity_at > now - Duration::hours(48) {
        WARM_POLL_DELAY
    } else {
        INACTIVE_POLL_DELAY
    }
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
            forward_cursor,
            backward_cursor,
            backfill_done,
            next_poll_at,
            last_polled_at,
            last_activity_at
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

pub async fn save_public_latest_page_cursor(
    pool: &PgPool,
    account_id: &str,
    source: PublicHistorySource,
    next_cursor: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO bronze_public_history_cursors (
            account_id,
            source,
            forward_cursor,
            last_polled_at,
            updated_at
        )
        VALUES ($1, $2::public_history_source, $3, NOW(), NOW())
        ON CONFLICT (account_id, source) DO UPDATE SET
            forward_cursor = COALESCE(
                EXCLUDED.forward_cursor,
                bronze_public_history_cursors.forward_cursor
            ),
            last_polled_at = NOW(),
            updated_at = NOW()
        "#,
    )
    .bind(account_id)
    .bind(source.as_str())
    .bind(next_cursor)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn save_public_backfill_progress(
    pool: &PgPool,
    account_id: &str,
    source: PublicHistorySource,
    backward_cursor: Option<&str>,
    initial_forward_cursor: Option<&str>,
    backfill_done: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO bronze_public_history_cursors (
            account_id,
            source,
            forward_cursor,
            backward_cursor,
            backfill_done,
            last_polled_at,
            updated_at
        )
        VALUES ($1, $2::public_history_source, $3, $4, $5, NOW(), NOW())
        ON CONFLICT (account_id, source) DO UPDATE SET
            forward_cursor = COALESCE(
                EXCLUDED.forward_cursor,
                bronze_public_history_cursors.forward_cursor
            ),
            backward_cursor = COALESCE(
                EXCLUDED.backward_cursor,
                bronze_public_history_cursors.backward_cursor
            ),
            backfill_done = bronze_public_history_cursors.backfill_done
                OR EXCLUDED.backfill_done,
            last_polled_at = NOW(),
            updated_at = NOW()
        "#,
    )
    .bind(account_id)
    .bind(source.as_str())
    .bind(initial_forward_cursor)
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
    had_history_changes: bool,
    last_seen_block_height: Option<i64>,
    last_seen_block_timestamp: Option<&bigdecimal::BigDecimal>,
) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    let current_last_activity_at = sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
        r#"
        SELECT last_activity_at
        FROM bronze_public_history_cursors
        WHERE account_id = $1
          AND source = $2::public_history_source
        "#,
    )
    .bind(account_id)
    .bind(source.as_str())
    .fetch_optional(pool)
    .await?
    .flatten();

    let last_activity_at = if had_history_changes {
        Some(now)
    } else {
        current_last_activity_at
    };
    let delay = public_history_next_poll_delay(had_history_changes, last_activity_at, now);
    let next_poll_at = now + delay;

    sqlx::query(
        r#"
        INSERT INTO bronze_public_history_cursors (
            account_id,
            source,
            last_activity_at,
            next_poll_at,
            last_seen_block_height,
            last_seen_block_timestamp,
            updated_at
        )
        VALUES (
            $1,
            $2::public_history_source,
            $3,
            $4,
            $5,
            $6,
            NOW()
        )
        ON CONFLICT (account_id, source) DO UPDATE SET
            last_activity_at = EXCLUDED.last_activity_at,
            next_poll_at = EXCLUDED.next_poll_at,
            last_seen_block_height = COALESCE(
                GREATEST(
                    bronze_public_history_cursors.last_seen_block_height,
                    EXCLUDED.last_seen_block_height
                ),
                bronze_public_history_cursors.last_seen_block_height,
                EXCLUDED.last_seen_block_height
            ),
            last_seen_block_timestamp = COALESCE(
                GREATEST(
                    bronze_public_history_cursors.last_seen_block_timestamp,
                    EXCLUDED.last_seen_block_timestamp
                ),
                bronze_public_history_cursors.last_seen_block_timestamp,
                EXCLUDED.last_seen_block_timestamp
            ),
            updated_at = NOW()
        "#,
    )
    .bind(account_id)
    .bind(source.as_str())
    .bind(last_activity_at)
    .bind(next_poll_at)
    .bind(last_seen_block_height)
    .bind(last_seen_block_timestamp)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn load_due_public_history_accounts(
    pool: &PgPool,
    source: PublicHistorySource,
    limit: i64,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT ma.account_id
        FROM monitored_accounts ma
        LEFT JOIN bronze_public_history_cursors c
          ON c.account_id = ma.account_id
         AND c.source = $1::public_history_source
        WHERE ma.enabled = true
          AND (
              c.account_id IS NULL
              OR c.next_poll_at IS NULL
              OR c.next_poll_at <= NOW()
          )
        ORDER BY c.next_poll_at ASC NULLS FIRST, ma.account_id ASC
        LIMIT $2
        "#,
    )
    .bind(source.as_str())
    .bind(limit)
    .fetch_all(pool)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poll_delay_matches_confidential_tiers() {
        let now = DateTime::parse_from_rfc3339("2026-06-25T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        assert_eq!(public_history_next_poll_delay(true, None, now), HOT_POLL_DELAY);
        assert_eq!(
            public_history_next_poll_delay(false, Some(now - Duration::minutes(30)), now),
            RECENT_POLL_DELAY
        );
        assert_eq!(
            public_history_next_poll_delay(false, Some(now - Duration::hours(12)), now),
            WARM_POLL_DELAY
        );
        assert_eq!(
            public_history_next_poll_delay(false, Some(now - Duration::hours(72)), now),
            INACTIVE_POLL_DELAY
        );
    }
}
