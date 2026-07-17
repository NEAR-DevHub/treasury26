//! Job-health watchdog: detects background jobs that have *stopped running*.
//!
//! Task failures are already captured (per-task `SentryLayer`, task rows on
//! the board), but a stalled job produces no failures at all — a dead cron
//! stream, a stuck worker, or a queue nobody consumes is invisible until
//! someone eyeballs every queue in the board UI. This module closes that gap:
//!
//! - [`spawn_all`](super::spawn_all) registers every queue here with its
//!   expected cadence ([`QueueKind::Cron`]) or as a task queue
//!   ([`QueueKind::Queue`]).
//! - The `job-watchdog` cron worker calls [`evaluate`] each minute and emits
//!   a `tracing::error!` for every stale queue (rate-limited per queue), which
//!   the tracing→Sentry bridge turns into a Sentry event.
//! - The `/api/jobs/health` endpoint ([`jobs_health`]) serves the same
//!   [`evaluate`] output as JSON — one table with last success / failure /
//!   backlog per queue — and answers 503 while anything is stale, so an
//!   external monitor (Oh Dear) catches even a dead process or dead monitor,
//!   which the in-process watchdog cannot report on itself.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use apalis::prelude::*;
use apalis_cron::Tick;
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;

use crate::AppState;

/// How a queue is fed, which decides how staleness is judged.
#[derive(Debug, Clone, Copy)]
pub enum QueueKind {
    /// Cron-driven: a tick lands every `interval_secs`; the queue is stale
    /// when no task has *succeeded* for well over that interval.
    Cron { interval_secs: u64 },
    /// Event-driven task queue: tasks arrive irregularly; the queue is stale
    /// when waiting tasks sit unconsumed for too long (dead worker).
    Queue,
}

/// One registered queue the watchdog knows about.
#[derive(Debug, Clone)]
pub struct JobSpec {
    pub queue: &'static str,
    pub kind: QueueKind,
}

/// Registry installed once by `spawn_all` after all queues are registered.
/// The instant is the boot baseline: before the first success of a job, its
/// staleness is measured from here, so a job that never manages to run still
/// alerts (instead of "no data, no alarm").
static REGISTRY: OnceLock<(DateTime<Utc>, Vec<JobSpec>)> = OnceLock::new();

pub fn install(specs: Vec<JobSpec>) {
    if REGISTRY.set((Utc::now(), specs)).is_err() {
        tracing::warn!("job watchdog registry installed twice; keeping first");
    }
}

/// Seconds between two consecutive fire times of `schedule`. All schedules
/// used by our jobs are uniform, so the gap between the next two ticks is
/// the cadence.
pub fn schedule_interval_secs(schedule: &cron::Schedule) -> Option<u64> {
    let mut upcoming = schedule.upcoming(Utc);
    let first = upcoming.next()?;
    let second = upcoming.next()?;
    Some((second - first).num_seconds().max(1) as u64)
}

/// Health snapshot of one queue, serialized as-is by `/api/jobs/health`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobHealth {
    pub queue: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_secs: Option<u64>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub last_success_age_secs: Option<i64>,
    pub last_failure_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub pending: i64,
    pub running: i64,
    /// Age of the oldest task that is due but not picked up.
    pub oldest_waiting_secs: Option<i64>,
    pub stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(sqlx::FromRow)]
struct QueueAgg {
    job_type: String,
    last_success_at: Option<DateTime<Utc>>,
    last_failure_at: Option<DateTime<Utc>>,
    pending: i64,
    running: i64,
    oldest_waiting_run_at: Option<DateTime<Utc>>,
}

/// A cron queue alerts when no success for `2 × interval + 10 min`: one
/// missed cycle is routine (a failed cycle waits for the next tick by
/// design), two plus grace means the job is not recovering on its own.
fn cron_staleness_threshold(interval_secs: u64) -> Duration {
    Duration::from_secs(interval_secs * 2 + 600)
}

/// A task queue alerts when a due task has been waiting this long with no
/// worker picking it up. Generous enough to absorb backfill bursts.
const QUEUE_WAITING_THRESHOLD: Duration = Duration::from_secs(1800);

/// Builds the health snapshot for every registered queue from `apalis.jobs`.
pub async fn evaluate(pool: &PgPool) -> Result<Vec<JobHealth>, sqlx::Error> {
    let Some((installed_at, specs)) = REGISTRY.get() else {
        return Ok(Vec::new());
    };

    let aggregates: Vec<QueueAgg> = sqlx::query_as(
        r#"
        SELECT
            job_type,
            max(done_at) FILTER (WHERE status = 'Done')                AS last_success_at,
            max(done_at) FILTER (WHERE status IN ('Failed', 'Killed')) AS last_failure_at,
            count(*)     FILTER (WHERE status IN ('Pending', 'Queued')) AS pending,
            count(*)     FILTER (WHERE status = 'Running')             AS running,
            min(run_at)  FILTER (WHERE status IN ('Pending', 'Queued')
                                   AND run_at < now())                 AS oldest_waiting_run_at
        FROM apalis.jobs
        GROUP BY job_type
        "#,
    )
    .fetch_all(pool)
    .await?;

    // apalis stores a task's outcome in `last_result` jsonb: `{"Ok": …}` on
    // success, `{"Err": "message"}` on failure. Pull the newest failure's
    // message per queue.
    let last_errors: Vec<(String, Option<String>)> = sqlx::query_as(
        r#"
        SELECT DISTINCT ON (job_type) job_type, last_result->>'Err' AS last_error
        FROM apalis.jobs
        WHERE status IN ('Failed', 'Killed') AND last_result->>'Err' IS NOT NULL
        ORDER BY job_type, done_at DESC NULLS LAST
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut by_queue: HashMap<String, QueueAgg> = aggregates
        .into_iter()
        .map(|agg| (agg.job_type.clone(), agg))
        .collect();
    let mut errors_by_queue: HashMap<String, Option<String>> = last_errors.into_iter().collect();

    let now = Utc::now();
    let report = specs
        .iter()
        .map(|spec| {
            let agg = by_queue.remove(spec.queue);
            let last_success_at = agg.as_ref().and_then(|a| a.last_success_at);
            let last_success_age_secs = last_success_at.map(|t| (now - t).num_seconds());
            let oldest_waiting_secs = agg
                .as_ref()
                .and_then(|a| a.oldest_waiting_run_at)
                .map(|t| (now - t).num_seconds());

            let (stale, reason) = match spec.kind {
                QueueKind::Cron { interval_secs } => {
                    // Baseline: last success, or boot for a job that has
                    // never succeeded this process lifetime.
                    let baseline = last_success_at.unwrap_or(*installed_at).max(*installed_at);
                    let threshold = cron_staleness_threshold(interval_secs);
                    let age = (now - baseline).num_seconds();
                    if age > threshold.as_secs() as i64 {
                        (
                            true,
                            Some(format!(
                                "no successful run for {age}s (expected every {interval_secs}s)"
                            )),
                        )
                    } else {
                        (false, None)
                    }
                }
                QueueKind::Queue => match oldest_waiting_secs {
                    Some(waiting) if waiting > QUEUE_WAITING_THRESHOLD.as_secs() as i64 => (
                        true,
                        Some(format!(
                            "oldest due task waiting {waiting}s; worker appears stalled"
                        )),
                    ),
                    _ => (false, None),
                },
            };

            JobHealth {
                queue: spec.queue.to_string(),
                kind: match spec.kind {
                    QueueKind::Cron { .. } => "cron",
                    QueueKind::Queue => "queue",
                },
                interval_secs: match spec.kind {
                    QueueKind::Cron { interval_secs } => Some(interval_secs),
                    QueueKind::Queue => None,
                },
                last_success_at,
                last_success_age_secs,
                last_failure_at: agg.as_ref().and_then(|a| a.last_failure_at),
                last_error: errors_by_queue.remove(spec.queue).flatten(),
                pending: agg.as_ref().map_or(0, |a| a.pending),
                running: agg.as_ref().map_or(0, |a| a.running),
                oldest_waiting_secs,
                stale,
                reason,
            }
        })
        .collect();

    Ok(report)
}

/// Re-alert a still-stale queue at most this often.
const ALERT_REPEAT_INTERVAL: Duration = Duration::from_secs(1800);

static LAST_ALERTED: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The `job-watchdog` cron task: evaluates all queues, alerts on stale ones.
pub async fn job_watchdog(_t: Tick, state: Data<Arc<AppState>>) -> Result<String, BoxDynError> {
    let report = evaluate(&state.db_pool).await?;
    let total = report.len();
    let mut stale_count = 0usize;

    let mut last_alerted = LAST_ALERTED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for job in &report {
        if job.stale {
            stale_count += 1;
            let due = last_alerted
                .get(&job.queue)
                .is_none_or(|at| at.elapsed() >= ALERT_REPEAT_INTERVAL);
            if due {
                last_alerted.insert(job.queue.clone(), Instant::now());
                // ERROR on purpose: the tracing→Sentry bridge captures
                // ERROR-level events, so this is the Sentry alert.
                tracing::error!(
                    queue = %job.queue,
                    reason = job.reason.as_deref().unwrap_or(""),
                    last_success_at = ?job.last_success_at,
                    last_error = job.last_error.as_deref().unwrap_or(""),
                    pending = job.pending,
                    running = job.running,
                    "background job stale: not making progress"
                );
            }
        } else if last_alerted.remove(&job.queue).is_some() {
            tracing::info!(queue = %job.queue, "background job recovered");
        }
    }

    if stale_count > 0 {
        return Ok(format!("{total} queues checked, {stale_count} STALE"));
    }
    Ok(format!("{total} queues checked, all healthy"))
}

/// `GET /api/jobs/health` — admin Basic Auth; 503 while any queue is stale
/// so an external uptime monitor can alert on the status code alone.
pub async fn jobs_health(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(denied) = crate::handlers::warnings::admin::require_admin(&headers, &state) {
        return denied.into_response();
    }

    let report = match evaluate(&state.db_pool).await {
        Ok(report) => report,
        Err(e) => {
            tracing::error!(error = %e, "jobs health evaluation failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "health evaluation failed" })),
            )
                .into_response();
        }
    };

    let healthy = report.iter().all(|job| !job.stale);
    let status = if healthy {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(serde_json::json!({
            "healthy": healthy,
            "generatedAt": Utc::now(),
            "jobs": report,
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_derived_from_uniform_schedules() {
        use std::str::FromStr;
        let minutely = cron::Schedule::from_str("0 */1 * * * *").unwrap();
        assert_eq!(schedule_interval_secs(&minutely), Some(60));
        let daily = cron::Schedule::from_str("0 0 0 * * *").unwrap();
        assert_eq!(schedule_interval_secs(&daily), Some(86_400));
        let weekly = cron::Schedule::from_str("0 0 0 * * Mon").unwrap();
        assert_eq!(schedule_interval_secs(&weekly), Some(604_800));
        let six_hourly = cron::Schedule::from_str("0 0 */6 * * *").unwrap();
        assert_eq!(schedule_interval_secs(&six_hourly), Some(21_600));
    }

    #[test]
    fn cron_threshold_has_floor_for_fast_jobs() {
        // 2s job: 2×2+600 = 604s — brief hiccups never alert.
        assert_eq!(cron_staleness_threshold(2), Duration::from_secs(604));
        assert_eq!(
            cron_staleness_threshold(86_400),
            Duration::from_secs(173_400)
        );
    }
}
