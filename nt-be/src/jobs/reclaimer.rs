//! Bounded, audited recovery of claims that can no longer make progress.
//!
//! Pending age is never used as a deletion signal. A stale Queued row has not
//! entered its handler and is safe to put back; a stale Running row has
//! ambiguous side effects and is made terminal instead of retried.

use apalis::prelude::*;
use apalis_cron::Tick;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{PgPool, Postgres, Transaction};

use crate::AppState;
use crate::jobs::platform::QueueSpec;

const RECLAIM_BATCH_SIZE: i64 = 256;
const AUDIT_RETENTION_DAYS: i32 = 7;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReclaimerMode {
    Report,
    Enforce,
}

impl ReclaimerMode {
    fn from_env() -> Self {
        match std::env::var("APALIS_RECLAIMER_MODE") {
            Ok(value) if value.eq_ignore_ascii_case("enforce") => Self::Enforce,
            Ok(value) if !value.eq_ignore_ascii_case("report") => {
                tracing::warn!(
                    value,
                    "invalid APALIS_RECLAIMER_MODE; using report-only mode"
                );
                Self::Report
            }
            _ => Self::Report,
        }
    }
}

#[derive(Debug, Default, Eq, PartialEq)]
pub struct ReclaimStats {
    pub stale_queued: usize,
    pub stale_running: usize,
    pub requeued: usize,
    pub killed: usize,
}

#[derive(Serialize)]
struct SqlPolicy {
    job_type: &'static str,
    queued_seconds: i64,
    running_seconds: i64,
}

#[derive(sqlx::FromRow)]
struct Candidate {
    id: String,
    job_type: String,
    lock_at: DateTime<Utc>,
}

fn policies_json(specs: &[QueueSpec]) -> serde_json::Value {
    serde_json::to_value(
        specs
            .iter()
            .map(|spec| SqlPolicy {
                job_type: spec.queue,
                queued_seconds: spec.reclaim.queued_after.as_secs().min(i64::MAX as u64) as i64,
                running_seconds: spec.reclaim.running_after.as_secs().min(i64::MAX as u64) as i64,
            })
            .collect::<Vec<_>>(),
    )
    .expect("queue reclaim policies are serializable")
}

async fn select_queued(
    tx: &mut Transaction<'_, Postgres>,
    policies: &serde_json::Value,
) -> Result<Vec<Candidate>, sqlx::Error> {
    sqlx::query_as(
        r#"
        WITH policies AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb)
                 AS p(job_type text, queued_seconds bigint, running_seconds bigint)
        )
        SELECT jobs.id, jobs.job_type, jobs.lock_at
        FROM apalis.jobs AS jobs
        JOIN policies ON policies.job_type = jobs.job_type
        WHERE jobs.status = 'Queued'
          AND jobs.lock_at IS NOT NULL
          AND jobs.lock_at < NOW() - make_interval(
              secs => policies.queued_seconds::double precision
          )
        ORDER BY jobs.lock_at ASC, jobs.id ASC
        LIMIT $2
        FOR UPDATE OF jobs SKIP LOCKED
        "#,
    )
    .bind(policies)
    .bind(RECLAIM_BATCH_SIZE)
    .fetch_all(&mut **tx)
    .await
}

async fn select_running(
    tx: &mut Transaction<'_, Postgres>,
    policies: &serde_json::Value,
) -> Result<Vec<Candidate>, sqlx::Error> {
    sqlx::query_as(
        r#"
        WITH policies AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb)
                 AS p(job_type text, queued_seconds bigint, running_seconds bigint)
        )
        SELECT jobs.id, jobs.job_type, jobs.lock_at
        FROM apalis.jobs AS jobs
        JOIN policies ON policies.job_type = jobs.job_type
        WHERE jobs.status = 'Running'
          AND jobs.lock_at IS NOT NULL
          AND jobs.lock_at < NOW() - make_interval(
              secs => policies.running_seconds::double precision
          )
        ORDER BY jobs.lock_at ASC, jobs.id ASC
        LIMIT $2
        FOR UPDATE OF jobs SKIP LOCKED
        "#,
    )
    .bind(policies)
    .bind(RECLAIM_BATCH_SIZE)
    .fetch_all(&mut **tx)
    .await
}

async fn insert_audit(
    tx: &mut Transaction<'_, Postgres>,
    candidates: &[Candidate],
    from_status: &str,
    action: &str,
    reason: &str,
) -> Result<(), sqlx::Error> {
    if candidates.is_empty() {
        return Ok(());
    }
    let ids = candidates
        .iter()
        .map(|candidate| candidate.id.clone())
        .collect::<Vec<_>>();
    let job_types = candidates
        .iter()
        .map(|candidate| candidate.job_type.clone())
        .collect::<Vec<_>>();
    let lock_ats = candidates
        .iter()
        .map(|candidate| candidate.lock_at)
        .collect::<Vec<_>>();

    sqlx::query(
        r#"
        INSERT INTO background_job_reclaims (
            job_id, job_type, from_status, action, reason, lock_at
        )
        SELECT rows.job_id, rows.job_type, $4, $5, $6, rows.lock_at
        FROM UNNEST($1::text[], $2::text[], $3::timestamptz[])
             AS rows(job_id, job_type, lock_at)
        "#,
    )
    .bind(ids)
    .bind(job_types)
    .bind(lock_ats)
    .bind(from_status)
    .bind(action)
    .bind(reason)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn wake_requeued(
    tx: &mut Transaction<'_, Postgres>,
    candidates: &[Candidate],
) -> Result<(), sqlx::Error> {
    if candidates.is_empty() {
        return Ok(());
    }
    let ids = candidates
        .iter()
        .map(|candidate| candidate.id.clone())
        .collect::<Vec<_>>();
    let job_types = candidates
        .iter()
        .map(|candidate| candidate.job_type.clone())
        .collect::<Vec<_>>();
    sqlx::query(
        r#"
        SELECT pg_notify(
            'apalis::job::insert',
            json_build_object(
                'job_type', rows.job_type,
                'id', rows.job_id,
                'run_at', NOW()
            )::text
        )
        FROM UNNEST($1::text[], $2::text[]) AS rows(job_id, job_type)
        "#,
    )
    .bind(ids)
    .bind(job_types)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn reclaim_stale_jobs(
    pool: &PgPool,
    specs: &[QueueSpec],
    mode: ReclaimerMode,
) -> Result<ReclaimStats, sqlx::Error> {
    if specs.is_empty() {
        return Ok(ReclaimStats::default());
    }

    let policies = policies_json(specs);
    let mut tx = pool.begin().await?;
    let queued = select_queued(&mut tx, &policies).await?;
    let running = select_running(&mut tx, &policies).await?;
    let mut stats = ReclaimStats {
        stale_queued: queued.len(),
        stale_running: running.len(),
        ..ReclaimStats::default()
    };

    if mode == ReclaimerMode::Report {
        tx.rollback().await?;
        return Ok(stats);
    }

    if !queued.is_empty() {
        let ids = queued
            .iter()
            .map(|candidate| candidate.id.clone())
            .collect::<Vec<_>>();
        stats.requeued = sqlx::query(
            r#"
            UPDATE apalis.jobs
            SET status = 'Pending',
                lock_by = NULL,
                lock_at = NULL,
                done_at = NULL
            WHERE id = ANY($1::text[]) AND status = 'Queued'
            "#,
        )
        .bind(ids)
        .execute(&mut *tx)
        .await?
        .rows_affected() as usize;
        insert_audit(
            &mut tx,
            &queued,
            "Queued",
            "requeued",
            "claim exceeded queue reclaim threshold before handler start",
        )
        .await?;
        wake_requeued(&mut tx, &queued).await?;
    }

    if !running.is_empty() {
        let ids = running
            .iter()
            .map(|candidate| candidate.id.clone())
            .collect::<Vec<_>>();
        stats.killed = sqlx::query(
            r#"
            UPDATE apalis.jobs
            SET status = 'Killed',
                lock_by = NULL,
                lock_at = NULL,
                done_at = NOW(),
                last_result = jsonb_build_object(
                    'Err',
                    'Platform reclaimer: Running claim exceeded handler safety threshold'
                )
            WHERE id = ANY($1::text[]) AND status = 'Running'
            "#,
        )
        .bind(ids)
        .execute(&mut *tx)
        .await?
        .rows_affected() as usize;
        insert_audit(
            &mut tx,
            &running,
            "Running",
            "killed",
            "execution exceeded running safety threshold; side effects are ambiguous",
        )
        .await?;
    }

    tx.commit().await?;
    Ok(stats)
}

pub async fn apalis_reclaimer(
    _tick: Tick,
    state: Data<std::sync::Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let mode = ReclaimerMode::from_env();
    let stats = reclaim_stale_jobs(
        &state.db_pool,
        crate::jobs::watchdog::registered_specs(),
        mode,
    )
    .await?;

    if stats.stale_queued > 0 || stats.stale_running > 0 {
        match mode {
            ReclaimerMode::Report => tracing::warn!(
                stale_queued = stats.stale_queued,
                stale_running = stats.stale_running,
                "background-job reclaimer found stale claims (report-only)"
            ),
            ReclaimerMode::Enforce => tracing::warn!(
                stale_queued = stats.stale_queued,
                stale_running = stats.stale_running,
                requeued = stats.requeued,
                killed = stats.killed,
                "background-job reclaimer recovered stale claims"
            ),
        }
    }

    Ok(format!(
        "mode={mode:?}, stale queued={}, stale running={}, requeued={}, killed={}",
        stats.stale_queued, stats.stale_running, stats.requeued, stats.killed
    ))
}

pub async fn prune_reclaim_audit(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        DELETE FROM background_job_reclaims
        WHERE id IN (
            SELECT id
            FROM background_job_reclaims
            WHERE reclaimed_at < NOW() - make_interval(days => $1)
            ORDER BY reclaimed_at ASC
            LIMIT 10000
        )
        "#,
    )
    .bind(AUDIT_RETENTION_DAYS)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn test_spec(queue: &'static str) -> QueueSpec {
        QueueSpec::queue(queue, 1, Duration::from_secs(30))
    }

    async fn insert_job(
        pool: &PgPool,
        id: &str,
        queue: &str,
        status: &str,
        old: bool,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO apalis.jobs (job, id, job_type, status, attempts, run_at, lock_at)
            VALUES (
                decode('7b7d', 'hex'), $1, $2, $3, 3,
                NOW() - INTERVAL '2 hours',
                CASE
                    WHEN $3 IN ('Queued', 'Running') AND $4
                        THEN NOW() - INTERVAL '2 hours'
                    WHEN $3 IN ('Queued', 'Running') THEN NOW()
                    ELSE NULL
                END
            )
            "#,
        )
        .bind(id)
        .bind(queue)
        .bind(status)
        .bind(old)
        .execute(pool)
        .await?;
        Ok(())
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn enforce_requeues_queued_kills_running_and_preserves_pending(
        pool: PgPool,
    ) -> Result<(), sqlx::Error> {
        crate::jobs::setup_apalis(&pool).await?;
        insert_job(&pool, "pending", "recover-me", "Pending", true).await?;
        insert_job(&pool, "queued", "recover-me", "Queued", true).await?;
        insert_job(&pool, "running", "recover-me", "Running", true).await?;
        insert_job(&pool, "failed", "recover-me", "Failed", true).await?;
        insert_job(&pool, "fresh", "recover-me", "Queued", false).await?;
        insert_job(&pool, "foreign", "foreign", "Queued", true).await?;

        let stats =
            reclaim_stale_jobs(&pool, &[test_spec("recover-me")], ReclaimerMode::Enforce).await?;
        assert_eq!(
            stats,
            ReclaimStats {
                stale_queued: 1,
                stale_running: 1,
                requeued: 1,
                killed: 1,
            }
        );

        let rows: Vec<(String, String, i32, Option<DateTime<Utc>>)> =
            sqlx::query_as("SELECT id, status, attempts, lock_at FROM apalis.jobs ORDER BY id")
                .fetch_all(&pool)
                .await?;
        assert!(rows.contains(&("pending".to_owned(), "Pending".to_owned(), 3, None)));
        assert!(rows.contains(&("queued".to_owned(), "Pending".to_owned(), 3, None)));
        assert!(
            rows.iter()
                .any(|row| row.0 == "running" && row.1 == "Killed" && row.3.is_none())
        );
        assert!(
            rows.iter()
                .any(|row| row.0 == "failed" && row.1 == "Failed")
        );
        assert!(rows.iter().any(|row| row.0 == "fresh" && row.1 == "Queued"));
        assert!(
            rows.iter()
                .any(|row| row.0 == "foreign" && row.1 == "Queued")
        );

        let audit: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT job_id, from_status, action FROM background_job_reclaims ORDER BY job_id",
        )
        .fetch_all(&pool)
        .await?;
        assert_eq!(
            audit,
            vec![
                (
                    "queued".to_owned(),
                    "Queued".to_owned(),
                    "requeued".to_owned()
                ),
                (
                    "running".to_owned(),
                    "Running".to_owned(),
                    "killed".to_owned()
                ),
            ]
        );
        Ok(())
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn report_mode_does_not_mutate(pool: PgPool) -> Result<(), sqlx::Error> {
        crate::jobs::setup_apalis(&pool).await?;
        insert_job(&pool, "queued", "report-only", "Queued", true).await?;
        let stats =
            reclaim_stale_jobs(&pool, &[test_spec("report-only")], ReclaimerMode::Report).await?;
        assert_eq!(stats.stale_queued, 1);
        assert_eq!(stats.requeued, 0);
        let status: String =
            sqlx::query_scalar("SELECT status FROM apalis.jobs WHERE id = 'queued'")
                .fetch_one(&pool)
                .await?;
        assert_eq!(status, "Queued");
        let audits: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM background_job_reclaims")
            .fetch_one(&pool)
            .await?;
        assert_eq!(audits, 0);
        Ok(())
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn recovery_is_bounded_and_oldest_first(pool: PgPool) -> Result<(), sqlx::Error> {
        crate::jobs::setup_apalis(&pool).await?;
        sqlx::query(
            r#"
            INSERT INTO apalis.jobs (job, id, job_type, status, run_at, lock_at)
            SELECT
                decode('7b7d', 'hex'),
                'bounded-' || to_char(value, 'FM000'),
                'bounded',
                'Queued',
                NOW() - INTERVAL '3 hours',
                NOW() - INTERVAL '3 hours' + value * INTERVAL '1 second'
            FROM generate_series(1, 300) AS value
            "#,
        )
        .execute(&pool)
        .await?;

        let first =
            reclaim_stale_jobs(&pool, &[test_spec("bounded")], ReclaimerMode::Enforce).await?;
        assert_eq!(first.requeued, RECLAIM_BATCH_SIZE as usize);
        let oldest_status: String =
            sqlx::query_scalar("SELECT status FROM apalis.jobs WHERE id = 'bounded-001'")
                .fetch_one(&pool)
                .await?;
        let newest_status: String =
            sqlx::query_scalar("SELECT status FROM apalis.jobs WHERE id = 'bounded-300'")
                .fetch_one(&pool)
                .await?;
        assert_eq!(oldest_status, "Pending");
        assert_eq!(newest_status, "Queued");

        let second =
            reclaim_stale_jobs(&pool, &[test_spec("bounded")], ReclaimerMode::Enforce).await?;
        assert_eq!(second.requeued, 44);
        Ok(())
    }
}
