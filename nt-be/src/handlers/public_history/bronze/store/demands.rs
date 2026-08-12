use chrono::{DateTime, Utc};
use sqlx::PgPool;

use super::models::PublicHistorySource;

/// Retry backoff per prior attempt; the last entry repeats. Authentication
/// or schema failures stay visible in `last_error` and retry slowly instead
/// of hot-looping or being lost.
const RETRY_BACKOFF_SECONDS: [i64; 4] = [15, 30, 60, 120];

pub fn retry_backoff_seconds(attempts: i32) -> i64 {
    let index = (attempts.max(0) as usize).min(RETRY_BACKOFF_SECONDS.len() - 1);
    RETRY_BACKOFF_SECONDS[index]
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct LatestDemandRow {
    account_id: String,
    source: String,
    trigger_block_height: i64,
    trigger_transaction_hash: Option<String>,
    generation: i64,
    attempts: i32,
    next_attempt_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct LatestDemand {
    pub account_id: String,
    pub source: PublicHistorySource,
    pub trigger_block_height: i64,
    pub trigger_transaction_hash: Option<String>,
    pub generation: i64,
    pub attempts: i32,
    pub next_attempt_at: DateTime<Utc>,
}

impl TryFrom<LatestDemandRow> for LatestDemand {
    type Error = super::models::PublicHistorySourceParseError;

    fn try_from(row: LatestDemandRow) -> Result<Self, Self::Error> {
        Ok(Self {
            account_id: row.account_id,
            source: PublicHistorySource::from_db(&row.source)?,
            trigger_block_height: row.trigger_block_height,
            trigger_transaction_hash: row.trigger_transaction_hash,
            generation: row.generation,
            attempts: row.attempts,
            next_attempt_at: row.next_attempt_at,
        })
    }
}

/// Record (or refresh) the realtime demand for one (account, source). A
/// newer trigger landing while a token job is pending or running bumps the
/// generation and re-arms immediate dispatch — nothing is discarded.
pub async fn upsert_latest_demand(
    pool: &PgPool,
    account_id: &str,
    source: PublicHistorySource,
    trigger_block_height: i64,
    trigger_transaction_hash: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO public_history_latest_demands (
            account_id, source, trigger_block_height, trigger_transaction_hash
        )
        VALUES ($1, $2::public_history_source, $3, $4)
        ON CONFLICT (account_id, source) DO UPDATE SET
            trigger_block_height = GREATEST(
                public_history_latest_demands.trigger_block_height,
                EXCLUDED.trigger_block_height
            ),
            trigger_transaction_hash = CASE
                WHEN EXCLUDED.trigger_block_height
                     >= public_history_latest_demands.trigger_block_height
                    THEN EXCLUDED.trigger_transaction_hash
                ELSE public_history_latest_demands.trigger_transaction_hash
            END,
            generation = public_history_latest_demands.generation + 1,
            attempts = 0,
            next_attempt_at = NOW(),
            last_error = NULL,
            updated_at = NOW()
        "#,
    )
    .bind(account_id)
    .bind(source.as_str())
    .bind(trigger_block_height)
    .bind(trigger_transaction_hash)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn load_ready_latest_demands(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<LatestDemand>, sqlx::Error> {
    let rows: Vec<LatestDemandRow> = sqlx::query_as(
        r#"
        SELECT demand.account_id, demand.source::text AS source,
               demand.trigger_block_height, demand.trigger_transaction_hash,
               demand.generation, demand.attempts, demand.next_attempt_at
        FROM public_history_latest_demands AS demand
        WHERE demand.next_attempt_at <= NOW()
          AND NOT EXISTS (
              SELECT 1
              FROM apalis.jobs AS job
              WHERE job.job_type = 'public_history_latest'
                AND job.metadata->>'job_key' =
                    'latest:' || demand.account_id || ':' || demand.source::text
                AND (
                    job.status IN ('Pending', 'Queued', 'Running')
                    OR (job.status = 'Failed' AND job.attempts < job.max_attempts)
                )
          )
        ORDER BY demand.next_attempt_at
        LIMIT $1
        "#,
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            LatestDemand::try_from(row)
                .map_err(|error| sqlx::Error::Decode(Box::new(std::io::Error::other(error))))
        })
        .collect()
}

/// Age of the oldest ready demand — the realtime-lag health signal.
pub async fn oldest_ready_latest_demand_age_seconds(
    pool: &PgPool,
) -> Result<Option<f64>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT EXTRACT(epoch FROM NOW() - MIN(next_attempt_at))::double precision
        FROM public_history_latest_demands
        WHERE next_attempt_at <= NOW()
        "#,
    )
    .fetch_one(pool)
    .await
}

/// Number of durable realtime demands ready to receive a dispatch token.
/// This is the real backlog metric; the Apalis queue intentionally contains
/// only enough tokens to fill currently available worker slots.
pub async fn ready_latest_demand_count(pool: &PgPool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM public_history_latest_demands
        WHERE next_attempt_at <= NOW()
        "#,
    )
    .fetch_one(pool)
    .await
}

/// Delete the demand only if no newer trigger arrived while the job ran;
/// a survived generation means the dispatcher issues a follow-up token.
pub async fn complete_latest_demand(
    pool: &PgPool,
    account_id: &str,
    source: PublicHistorySource,
    generation: i64,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        r#"
        DELETE FROM public_history_latest_demands
        WHERE account_id = $1
          AND source = $2::public_history_source
          AND generation = $3
        "#,
    )
    .bind(account_id)
    .bind(source.as_str())
    .bind(generation)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Keep the demand after a failed attempt and schedule the exponential
/// retry. `retry_after` overrides the schedule when the provider sent one.
pub async fn defer_latest_demand(
    pool: &PgPool,
    account_id: &str,
    source: PublicHistorySource,
    generation: i64,
    error: &str,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        r#"
        UPDATE public_history_latest_demands
        SET attempts = attempts + 1,
            next_attempt_at = NOW() + make_interval(
                secs => CASE LEAST(GREATEST(attempts, 0), 3)
                    WHEN 0 THEN 15::double precision
                    WHEN 1 THEN 30::double precision
                    WHEN 2 THEN 60::double precision
                    ELSE 120::double precision
                END
            ),
            last_error = LEFT($4, 500),
            updated_at = NOW()
        WHERE account_id = $1
          AND source = $2::public_history_source
          AND generation = $3
        "#,
    )
    .bind(account_id)
    .bind(source.as_str())
    .bind(generation)
    .bind(error)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_schedule_caps_at_the_last_step() {
        assert_eq!(retry_backoff_seconds(0), 15);
        assert_eq!(retry_backoff_seconds(1), 30);
        assert_eq!(retry_backoff_seconds(2), 60);
        assert_eq!(retry_backoff_seconds(3), 120);
        assert_eq!(retry_backoff_seconds(50), 120);
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn newer_trigger_bumps_generation_and_survives_completion(pool: PgPool) {
        crate::jobs::setup_apalis(&pool).await.unwrap();
        upsert_latest_demand(
            &pool,
            "dao.near",
            PublicHistorySource::NearblocksFt,
            100,
            Some("tx1"),
        )
        .await
        .unwrap();
        let demand = &load_ready_latest_demands(&pool, 10).await.unwrap()[0];
        assert_eq!((demand.generation, demand.trigger_block_height), (1, 100));

        // A newer trigger lands while the token job is running.
        upsert_latest_demand(
            &pool,
            "dao.near",
            PublicHistorySource::NearblocksFt,
            105,
            Some("tx2"),
        )
        .await
        .unwrap();

        // The job finishes carrying generation 1 — the demand must survive.
        let completed =
            complete_latest_demand(&pool, "dao.near", PublicHistorySource::NearblocksFt, 1)
                .await
                .unwrap();
        assert!(!completed);
        let demand = &load_ready_latest_demands(&pool, 10).await.unwrap()[0];
        assert_eq!((demand.generation, demand.trigger_block_height), (2, 105));
        assert_eq!(demand.trigger_transaction_hash.as_deref(), Some("tx2"));

        let completed =
            complete_latest_demand(&pool, "dao.near", PublicHistorySource::NearblocksFt, 2)
                .await
                .unwrap();
        assert!(completed);
        assert!(
            load_ready_latest_demands(&pool, 10)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn deferred_demand_leaves_the_ready_set_and_records_the_error(pool: PgPool) {
        crate::jobs::setup_apalis(&pool).await.unwrap();
        upsert_latest_demand(
            &pool,
            "dao.near",
            PublicHistorySource::NearblocksMt,
            100,
            None,
        )
        .await
        .unwrap();
        let deferred = defer_latest_demand(
            &pool,
            "dao.near",
            PublicHistorySource::NearblocksMt,
            1,
            "502 upstream",
        )
        .await
        .unwrap();
        assert!(deferred);

        assert!(
            load_ready_latest_demands(&pool, 10)
                .await
                .unwrap()
                .is_empty()
        );
        let (attempts, error): (i32, Option<String>) = sqlx::query_as(
            "SELECT attempts, last_error FROM public_history_latest_demands WHERE account_id='dao.near'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(attempts, 1);
        assert_eq!(error.as_deref(), Some("502 upstream"));
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn stale_failure_cannot_defer_a_newer_generation(pool: PgPool) {
        crate::jobs::setup_apalis(&pool).await.unwrap();
        upsert_latest_demand(
            &pool,
            "dao.near",
            PublicHistorySource::NearblocksReceipt,
            100,
            Some("tx1"),
        )
        .await
        .unwrap();
        let stale_generation = load_ready_latest_demands(&pool, 10).await.unwrap()[0].generation;

        upsert_latest_demand(
            &pool,
            "dao.near",
            PublicHistorySource::NearblocksReceipt,
            101,
            Some("tx2"),
        )
        .await
        .unwrap();

        let deferred = defer_latest_demand(
            &pool,
            "dao.near",
            PublicHistorySource::NearblocksReceipt,
            stale_generation,
            "stale failure",
        )
        .await
        .unwrap();
        assert!(!deferred);

        let ready = load_ready_latest_demands(&pool, 10).await.unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].generation, stale_generation + 1);
        assert_eq!(ready[0].attempts, 0);
        assert_eq!(ready[0].trigger_transaction_hash.as_deref(), Some("tx2"));
    }
}
