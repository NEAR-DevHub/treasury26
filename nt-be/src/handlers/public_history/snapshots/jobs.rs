//! Durable, deduplicated Apalis work queue for public balance snapshots.
//!
//! The cursor owns the desired generation. Queue payloads only capture that
//! generation and are therefore safe to retry or redeliver: the snapshot
//! publisher re-checks it under the per-DAO transaction lock before writing.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use apalis::layers::WorkerBuilderExt;
use apalis::prelude::*;
use apalis_core::backend::{TaskSink, TaskSinkError};
use apalis_core::task::Task;
use apalis_postgres::{Config, PgContext, PgTask, PgTaskId, PostgresStorage};
use apalis_sql::ext::TaskBuilderExt;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tokio_util::sync::CancellationToken;

use super::repository::load_dirty_snapshot_cursors;
use super::worker::project_public_balance_snapshot_generation;
use crate::AppState;
use crate::jobs::context::JobContext;

pub(crate) const PUBLIC_BALANCE_SNAPSHOT_NAMESPACE: &str = "public_balance_snapshots";
const PUBLIC_BALANCE_SNAPSHOT_WORKER: &str = "public-balance-snapshots";
const PUBLIC_BALANCE_SNAPSHOT_JOB_KEY_FIELD: &str = "job_key";
const PUBLIC_BALANCE_SNAPSHOT_INFLIGHT_INDEX: &str =
    "idx_public_balance_snapshot_jobs_inflight_key";
const SNAPSHOT_JOB_MAX_ATTEMPTS: u32 = 8;
const SNAPSHOT_JOB_CONCURRENCY: usize = 2;

type SnapshotStorage = PostgresStorage<PublicBalanceSnapshotJob>;

/// A payload consumer owned by the elected jobs-leader runtime.
pub(crate) type SnapshotSupervisorFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicBalanceSnapshotJob {
    pub job_key: String,
    pub account_id: String,
    pub generation: i64,
}

impl PublicBalanceSnapshotJob {
    pub fn new(account_id: impl Into<String>, generation: i64) -> Self {
        let account_id = account_id.into();
        Self {
            job_key: snapshot_job_key(&account_id),
            account_id,
            generation,
        }
    }
}

/// Stable across generations so there can be at most one retryable payload
/// for a DAO. A newer generation is picked up by the next sweeper pass after
/// an obsolete payload completes.
pub fn snapshot_job_key(account_id: &str) -> String {
    format!("public-balance-snapshot:{account_id}")
}

fn storage(pool: PgPool) -> SnapshotStorage {
    let config = Config::new(PUBLIC_BALANCE_SNAPSHOT_NAMESPACE)
        .set_buffer_size(SNAPSHOT_JOB_CONCURRENCY.max(1));
    PostgresStorage::new_with_config(&pool, &config)
}

fn task_with_job_key(job: PublicBalanceSnapshotJob) -> PgTask<PublicBalanceSnapshotJob> {
    let mut metadata = serde_json::Map::new();
    metadata.insert(
        PUBLIC_BALANCE_SNAPSHOT_JOB_KEY_FIELD.to_string(),
        serde_json::Value::String(job.job_key.clone()),
    );

    Task::builder(job)
        .with_ctx(PgContext::new().with_meta(metadata))
        .max_attempts(SNAPSHOT_JOB_MAX_ATTEMPTS)
        .build()
}

fn is_inflight_key_conflict(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(error) => {
            error.constraint() == Some(PUBLIC_BALANCE_SNAPSHOT_INFLIGHT_INDEX)
                || error
                    .message()
                    .contains(PUBLIC_BALANCE_SNAPSHOT_INFLIGHT_INDEX)
        }
        _ => false,
    }
}

async fn active_job_exists(pool: &PgPool, job_key: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM apalis.jobs
            WHERE job_type = $1
              AND metadata->>'job_key' = $2
              AND (
                  status IN ('Pending', 'Queued', 'Running')
                  OR (status = 'Failed' AND attempts < max_attempts)
              )
        )
        "#,
    )
    .bind(PUBLIC_BALANCE_SNAPSHOT_NAMESPACE)
    .bind(job_key)
    .fetch_one(pool)
    .await
}

async fn push_job(pool: &PgPool, job: PublicBalanceSnapshotJob) -> Result<bool, sqlx::Error> {
    if active_job_exists(pool, &job.job_key).await? {
        return Ok(false);
    }

    let mut queue = storage(pool.clone());
    match queue.push_task(task_with_job_key(job)).await {
        Ok(_) => Ok(true),
        Err(TaskSinkError::PushError(error)) if is_inflight_key_conflict(&error) => Ok(false),
        Err(TaskSinkError::PushError(error)) => Err(error),
        Err(TaskSinkError::CodecError(error)) => Err(sqlx::Error::Protocol(error.to_string())),
    }
}

pub async fn enqueue_snapshot_job(
    pool: &PgPool,
    account_id: impl Into<String>,
    generation: i64,
) -> Result<bool, sqlx::Error> {
    push_job(pool, PublicBalanceSnapshotJob::new(account_id, generation)).await
}

/// Enqueue every currently buildable dirty cursor. This is both the periodic
/// crash-recovery sweep and the cheap post-Silver commit nudge.
pub async fn enqueue_dirty_snapshot_jobs(pool: &PgPool) -> Result<usize, sqlx::Error> {
    let cursors = load_dirty_snapshot_cursors(pool).await?;
    let mut enqueued = 0usize;
    for cursor in cursors {
        if enqueue_snapshot_job(pool, cursor.account_id, cursor.snapshot_dirty_generation).await? {
            enqueued += 1;
        }
    }
    Ok(enqueued)
}

/// Account-scoped nudge used after the inline latest-refresh Silver
/// projection commits. Readiness filtering prevents premature archival work.
pub async fn enqueue_snapshot_job_if_dirty(
    pool: &PgPool,
    account_id: &str,
) -> Result<bool, sqlx::Error> {
    let Some(cursor) = load_dirty_snapshot_cursors(pool)
        .await?
        .into_iter()
        .find(|cursor| cursor.account_id == account_id)
    else {
        return Ok(false);
    };
    enqueue_snapshot_job(pool, cursor.account_id, cursor.snapshot_dirty_generation).await
}

pub async fn setup_public_balance_snapshot_jobs(pool: &PgPool) -> Result<(), sqlx::Error> {
    let bootstrap = super::repository::bootstrap_public_balance_snapshot_cursors(pool).await?;
    if bootstrap.cursors_seeded > 0 {
        tracing::info!(
            cursors_seeded = bootstrap.cursors_seeded,
            multi_token_reprojections = bootstrap.multi_token_reprojections,
            "bootstrapped public balance snapshot cursors"
        );
    }

    sqlx::query(
        r#"
        CREATE UNIQUE INDEX IF NOT EXISTS idx_public_balance_snapshot_jobs_inflight_key
        ON apalis.jobs (job_type, ((metadata->>'job_key')))
        WHERE job_type = 'public_balance_snapshots'
          AND (
              status IN ('Pending', 'Queued', 'Running')
              OR (status = 'Failed' AND attempts < max_attempts)
          )
          AND metadata ? 'job_key'
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn handle_snapshot_job(
    job: PublicBalanceSnapshotJob,
    attempt: Attempt,
    task_id: PgTaskId,
    context: Data<JobContext>,
) -> Result<String, BoxDynError> {
    let result = match project_public_balance_snapshot_generation(
        &context.state,
        &job.account_id,
        job.generation,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            // apalis-postgres reclaims Failed rows while attempts remain.
            // Persisting run_at before the ACK makes that retry backoff
            // durable across process exits and leadership hand-offs.
            let delay = retry_delay(attempt.current());
            if let Err(schedule_error) =
                schedule_retry(&context.state.db_pool, &task_id, delay).await
            {
                tracing::warn!(
                    account_id = job.account_id,
                    generation = job.generation,
                    error = %schedule_error,
                    "could not persist public snapshot retry delay"
                );
            }
            return Err(error.to_string().into());
        }
    };

    match result {
        Some(outcome) => {
            if outcome.seeded_rows > 0 {
                match crate::jobs::push_now_if_not_queued(
                    &context.state.db_pool,
                    "public-balance-snapshot-usd-repair",
                )
                .await
                {
                    Ok(true) => tracing::info!(
                        account_id = job.account_id,
                        "queued snapshot USD enrichment after historical seed"
                    ),
                    Ok(false) => {}
                    Err(error) => tracing::warn!(
                        account_id = job.account_id,
                        error = %error,
                        "could not queue snapshot USD enrichment after historical seed"
                    ),
                }
            }
            Ok(format!(
                "account={} generation={} rows={} seeded_rows={}",
                job.account_id, job.generation, outcome.rows_written, outcome.seeded_rows
            ))
        }
        None => Ok(format!(
            "account={} generation={} obsolete_or_already_applied",
            job.account_id, job.generation
        )),
    }
}

fn retry_delay(attempt: usize) -> Duration {
    let exponent = attempt.saturating_sub(1).min(16) as u32;
    Duration::from_secs(
        5u64.saturating_mul(2u64.saturating_pow(exponent))
            .min(5 * 60),
    )
}

async fn schedule_retry(
    pool: &PgPool,
    task_id: &PgTaskId,
    delay: Duration,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE apalis.jobs
        SET run_at = NOW() + make_interval(secs => $2::double precision)
        WHERE id = $1
          AND job_type = $3
        "#,
    )
    .bind(task_id.to_string())
    .bind(delay.as_secs_f64())
    .bind(PUBLIC_BALANCE_SNAPSHOT_NAMESPACE)
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) fn snapshot_queue_worker_future(
    state: Arc<AppState>,
    shutdown: CancellationToken,
) -> SnapshotSupervisorFuture {
    Box::pin(async move {
        let queue = storage(state.db_pool.clone());
        let result = WorkerBuilder::new(PUBLIC_BALANCE_SNAPSHOT_WORKER)
            .backend(queue)
            .data(JobContext::new(state))
            .timeout(crate::jobs::job_timeout())
            .catch_panic()
            .enable_tracing()
            .concurrency(SNAPSHOT_JOB_CONCURRENCY)
            .build(handle_snapshot_job)
            .run_until(async move {
                shutdown.cancelled().await;
                Ok::<(), WorkerError>(())
            })
            .await;

        if let Err(error) = result {
            tracing::error!(error = %error, "public balance snapshot consumer exited");
        }
    })
}

pub(crate) fn board_storage(pool: PgPool) -> SnapshotStorage {
    storage(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logical_key_is_stable_across_generations() {
        let first = PublicBalanceSnapshotJob::new("widgets.sputnik-dao.near", 1);
        let later = PublicBalanceSnapshotJob::new("widgets.sputnik-dao.near", 99);
        assert_eq!(first.job_key, later.job_key);
        assert_ne!(first.generation, later.generation);
    }

    #[test]
    fn logical_key_is_scoped_per_dao() {
        assert_ne!(snapshot_job_key("a.near"), snapshot_job_key("b.near"));
    }

    #[test]
    fn task_metadata_carries_dedupe_key_and_retry_budget() {
        let task = task_with_job_key(PublicBalanceSnapshotJob::new("a.near", 7));
        assert_eq!(
            task.parts
                .ctx
                .meta()
                .get(PUBLIC_BALANCE_SNAPSHOT_JOB_KEY_FIELD),
            Some(&serde_json::Value::String(snapshot_job_key("a.near")))
        );
        assert_eq!(
            task.parts.ctx.max_attempts(),
            SNAPSHOT_JOB_MAX_ATTEMPTS as i32
        );
    }

    #[test]
    fn retry_backoff_is_exponential_and_capped() {
        let seconds = (1..=9)
            .map(|attempt| retry_delay(attempt).as_secs())
            .collect::<Vec<_>>();
        assert_eq!(seconds, vec![5, 10, 20, 40, 80, 160, 300, 300, 300]);
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn enqueue_deduplicates_active_jobs_per_dao(pool: PgPool) {
        crate::jobs::setup_apalis(&pool)
            .await
            .expect("set up Apalis schema");
        setup_public_balance_snapshot_jobs(&pool)
            .await
            .expect("set up snapshot queue");

        assert!(
            enqueue_snapshot_job(&pool, "dedupe.sputnik-dao.near", 1)
                .await
                .expect("first enqueue")
        );
        assert!(
            !enqueue_snapshot_job(&pool, "dedupe.sputnik-dao.near", 2)
                .await
                .expect("duplicate enqueue")
        );

        sqlx::query(
            r#"
            UPDATE apalis.jobs
            SET status = 'Failed', attempts = 1
            WHERE job_type = $1
              AND metadata->>'job_key' = $2
            "#,
        )
        .bind(PUBLIC_BALANCE_SNAPSHOT_NAMESPACE)
        .bind(snapshot_job_key("dedupe.sputnik-dao.near"))
        .execute(&pool)
        .await
        .expect("mark retryable failure");
        assert!(
            !enqueue_snapshot_job(&pool, "dedupe.sputnik-dao.near", 3)
                .await
                .expect("retryable failure remains inflight")
        );

        sqlx::query(
            r#"
            UPDATE apalis.jobs
            SET attempts = max_attempts
            WHERE job_type = $1
              AND metadata->>'job_key' = $2
            "#,
        )
        .bind(PUBLIC_BALANCE_SNAPSHOT_NAMESPACE)
        .bind(snapshot_job_key("dedupe.sputnik-dao.near"))
        .execute(&pool)
        .await
        .expect("exhaust retry budget");
        assert!(
            enqueue_snapshot_job(&pool, "dedupe.sputnik-dao.near", 4)
                .await
                .expect("terminal failure permits replacement")
        );

        let active: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM apalis.jobs
            WHERE job_type = $1
              AND metadata->>'job_key' = $2
              AND status IN ('Pending', 'Queued', 'Running')
            "#,
        )
        .bind(PUBLIC_BALANCE_SNAPSHOT_NAMESPACE)
        .bind(snapshot_job_key("dedupe.sputnik-dao.near"))
        .fetch_one(&pool)
        .await
        .expect("count active jobs");
        assert_eq!(active, 1);
    }
}
