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
pub use crate::jobs::platform::{QueueKind, QueueSpec};

/// Registry installed once by `spawn_all` after all queues are registered.
/// The instant is the boot baseline: before the first success of a job, its
/// staleness is measured from here, so a job that never manages to run still
/// alerts (instead of "no data, no alarm").
static REGISTRY: OnceLock<(DateTime<Utc>, Vec<QueueSpec>)> = OnceLock::new();

pub fn install(specs: Vec<QueueSpec>) {
    if REGISTRY.set((Utc::now(), specs)).is_err() {
        tracing::warn!("job watchdog registry installed twice; keeping first");
    }
}

pub fn registered_specs() -> &'static [QueueSpec] {
    REGISTRY
        .get()
        .map(|(_, specs)| specs.as_slice())
        .unwrap_or_default()
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
    pub concurrency: usize,
    pub available_slots: usize,
    pub last_success_at: Option<DateTime<Utc>>,
    pub last_success_age_secs: Option<i64>,
    pub last_failure_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub pending: i64,
    pub queued: i64,
    pub running: i64,
    pub failed: i64,
    pub done: i64,
    pub killed: i64,
    pub retryable_failed: i64,
    pub oldest_due_pending_secs: Option<i64>,
    pub oldest_queued_secs: Option<i64>,
    pub oldest_running_secs: Option<i64>,
    /// Compatibility name for the oldest runnable Pending/Failed task.
    pub oldest_waiting_secs: Option<i64>,
    pub start_latency_p50_secs: Option<f64>,
    pub start_latency_p95_secs: Option<f64>,
    pub start_latency_max_secs: Option<f64>,
    pub reclaims_last_hour: i64,
    pub stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_mode: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(sqlx::FromRow)]
struct QueueAgg {
    job_type: String,
    last_success_at: Option<DateTime<Utc>>,
    last_failure_at: Option<DateTime<Utc>>,
    pending: i64,
    queued: i64,
    running: i64,
    failed: i64,
    done: i64,
    killed: i64,
    retryable_failed: i64,
    oldest_pending_run_at: Option<DateTime<Utc>>,
    oldest_claimable_run_at: Option<DateTime<Utc>>,
    oldest_queued_lock_at: Option<DateTime<Utc>>,
    oldest_running_lock_at: Option<DateTime<Utc>>,
    start_latency_p50_secs: Option<f64>,
    start_latency_p95_secs: Option<f64>,
    start_latency_max_secs: Option<f64>,
}

#[derive(sqlx::FromRow)]
struct ReclaimAgg {
    job_type: String,
    reclaims_last_hour: i64,
}

/// A cron queue alerts when no success for `2 × interval + 10 min`: one
/// missed cycle is routine (a failed cycle waits for the next tick by
/// design), two plus grace means the job is not recovering on its own.
fn cron_staleness_threshold(interval_secs: u64) -> Duration {
    Duration::from_secs(interval_secs * 2 + 600)
}

/// Builds the health snapshot for every registered queue from `apalis.jobs`.
pub async fn evaluate(pool: &PgPool) -> Result<Vec<JobHealth>, sqlx::Error> {
    let Some((installed_at, specs)) = REGISTRY.get() else {
        return Ok(Vec::new());
    };

    let job_types = specs
        .iter()
        .map(|spec| spec.queue.to_owned())
        .collect::<Vec<_>>();
    let aggregates: Vec<QueueAgg> = sqlx::query_as(
        r#"
        SELECT
            job_type,
            max(done_at) FILTER (WHERE status = 'Done')                AS last_success_at,
            max(done_at) FILTER (WHERE status IN ('Failed', 'Killed')) AS last_failure_at,
            count(*)     FILTER (WHERE status = 'Pending')             AS pending,
            count(*)     FILTER (WHERE status = 'Queued')              AS queued,
            count(*)     FILTER (WHERE status = 'Running')             AS running,
            count(*)     FILTER (WHERE status = 'Failed')              AS failed,
            count(*)     FILTER (WHERE status = 'Done')                AS done,
            count(*)     FILTER (WHERE status = 'Killed')              AS killed,
            count(*)     FILTER (WHERE status = 'Failed'
                                   AND attempts < max_attempts)        AS retryable_failed,
            min(run_at)  FILTER (WHERE status = 'Pending'
                                   AND run_at <= NOW())                AS oldest_pending_run_at,
            min(run_at)  FILTER (WHERE (
                                       status = 'Pending'
                                       OR (status = 'Failed' AND attempts < max_attempts)
                                   ) AND run_at <= NOW())              AS oldest_claimable_run_at,
            min(lock_at) FILTER (WHERE status = 'Queued')             AS oldest_queued_lock_at,
            min(lock_at) FILTER (WHERE status = 'Running')            AS oldest_running_lock_at,
            percentile_cont(0.50) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (lock_at - run_at))::double precision
            ) FILTER (WHERE lock_at >= NOW() - INTERVAL '15 minutes'
                        AND lock_at >= run_at)                         AS start_latency_p50_secs,
            percentile_cont(0.95) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (lock_at - run_at))::double precision
            ) FILTER (WHERE lock_at >= NOW() - INTERVAL '15 minutes'
                        AND lock_at >= run_at)                         AS start_latency_p95_secs,
            max(EXTRACT(EPOCH FROM (lock_at - run_at))::double precision)
                FILTER (WHERE lock_at >= NOW() - INTERVAL '15 minutes'
                          AND lock_at >= run_at)                       AS start_latency_max_secs
        FROM apalis.jobs
        WHERE job_type = ANY($1::text[])
        GROUP BY job_type
        "#,
    )
    .bind(&job_types)
    .fetch_all(pool)
    .await?;

    // apalis stores a task's outcome in `last_result` jsonb: `{"Ok": …}` on
    // success, `{"Err": "message"}` on failure. Pull the newest failure's
    // message per queue.
    let last_errors: Vec<(String, Option<String>)> = sqlx::query_as(
        r#"
        SELECT DISTINCT ON (job_type) job_type, last_result->>'Err' AS last_error
        FROM apalis.jobs
        WHERE job_type = ANY($1::text[])
          AND status IN ('Failed', 'Killed')
          AND last_result->>'Err' IS NOT NULL
        ORDER BY job_type, done_at DESC NULLS LAST
        "#,
    )
    .bind(&job_types)
    .fetch_all(pool)
    .await?;

    let reclaim_aggregates: Vec<ReclaimAgg> = sqlx::query_as(
        r#"
        SELECT job_type, COUNT(*)::bigint AS reclaims_last_hour
        FROM background_job_reclaims
        WHERE job_type = ANY($1::text[])
          AND reclaimed_at >= NOW() - INTERVAL '1 hour'
        GROUP BY job_type
        "#,
    )
    .bind(&job_types)
    .fetch_all(pool)
    .await?;

    let mut by_queue: HashMap<String, QueueAgg> = aggregates
        .into_iter()
        .map(|agg| (agg.job_type.clone(), agg))
        .collect();
    let mut errors_by_queue: HashMap<String, Option<String>> = last_errors.into_iter().collect();
    let reclaims_by_queue: HashMap<String, i64> = reclaim_aggregates
        .into_iter()
        .map(|agg| (agg.job_type, agg.reclaims_last_hour))
        .collect();
    let reclaim_error_threshold = env_u64("JOB_RECLAIMS_ERROR_PER_HOUR", 10).max(1) as i64;

    let now = Utc::now();
    let report = specs
        .iter()
        .map(|spec| {
            let agg = by_queue.remove(spec.queue);
            let last_success_at = agg.as_ref().and_then(|a| a.last_success_at);
            let last_success_age_secs = last_success_at.map(|t| (now - t).num_seconds());
            let oldest_waiting_secs = agg
                .as_ref()
                .and_then(|a| a.oldest_claimable_run_at)
                .map(|t| (now - t).num_seconds());
            let oldest_due_pending_secs = agg
                .as_ref()
                .and_then(|a| a.oldest_pending_run_at)
                .map(|t| (now - t).num_seconds());
            let oldest_queued_secs = agg
                .as_ref()
                .and_then(|a| a.oldest_queued_lock_at)
                .map(|t| (now - t).num_seconds());
            let oldest_running_secs = agg
                .as_ref()
                .and_then(|a| a.oldest_running_lock_at)
                .map(|t| (now - t).num_seconds());
            let queued = agg.as_ref().map_or(0, |a| a.queued);
            let running = agg.as_ref().map_or(0, |a| a.running);
            let active = queued.saturating_add(running).max(0) as usize;
            let available_slots = spec.concurrency.saturating_sub(active);
            let reclaims_last_hour = *reclaims_by_queue.get(spec.queue).unwrap_or(&0);

            let progress_failure = match spec.kind {
                QueueKind::Cron { interval_secs } => {
                    let baseline = last_success_at.unwrap_or(*installed_at).max(*installed_at);
                    let threshold = cron_staleness_threshold(interval_secs);
                    let age = (now - baseline).num_seconds();
                    (age > threshold.as_secs() as i64).then(|| {
                        (
                            "progress",
                            format!(
                                "no successful run for {age}s (expected every {interval_secs}s)"
                            ),
                        )
                    })
                }
                QueueKind::Queue => None,
            };

            let failure = if oldest_queued_secs
                .is_some_and(|age| age > spec.reclaim.queued_after.as_secs() as i64)
            {
                Some((
                    "claim_stuck",
                    format!(
                        "oldest Queued claim is {}s old",
                        oldest_queued_secs.unwrap_or_default()
                    ),
                ))
            } else if oldest_running_secs
                .is_some_and(|age| age > spec.reclaim.running_after.as_secs() as i64)
            {
                Some((
                    "execution_stuck",
                    format!(
                        "oldest Running claim is {}s old",
                        oldest_running_secs.unwrap_or_default()
                    ),
                ))
            } else if oldest_waiting_secs.is_some_and(|age| {
                age > spec.claim_alert_after.as_secs() as i64 && available_slots > 0
            }) {
                Some((
                    "wake",
                    format!(
                        "runnable work has waited {}s while {available_slots} worker slots are free",
                        oldest_waiting_secs.unwrap_or_default()
                    ),
                ))
            } else if oldest_waiting_secs.is_some_and(|age| {
                age > spec.backlog_alert_after.as_secs() as i64 && available_slots == 0
            }) {
                Some((
                    "capacity",
                    format!(
                        "runnable backlog is {}s old and all {} worker slots are occupied",
                        oldest_waiting_secs.unwrap_or_default(),
                        spec.concurrency
                    ),
                ))
            } else if reclaims_last_hour >= reclaim_error_threshold {
                Some((
                    "reclaim_rate",
                    format!(
                        "{reclaims_last_hour} claims reclaimed in the last hour (threshold {reclaim_error_threshold})"
                    ),
                ))
            } else {
                progress_failure
            };
            let stale = failure.is_some();
            let failure_mode = failure.as_ref().map(|(mode, _)| *mode);
            let reason = failure.map(|(_, reason)| reason);

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
                concurrency: spec.concurrency,
                available_slots,
                last_success_at,
                last_success_age_secs,
                last_failure_at: agg.as_ref().and_then(|a| a.last_failure_at),
                last_error: errors_by_queue.remove(spec.queue).flatten(),
                pending: agg.as_ref().map_or(0, |a| a.pending),
                queued,
                running,
                failed: agg.as_ref().map_or(0, |a| a.failed),
                done: agg.as_ref().map_or(0, |a| a.done),
                killed: agg.as_ref().map_or(0, |a| a.killed),
                retryable_failed: agg.as_ref().map_or(0, |a| a.retryable_failed),
                oldest_due_pending_secs,
                oldest_queued_secs,
                oldest_running_secs,
                oldest_waiting_secs,
                start_latency_p50_secs: agg.as_ref().and_then(|a| a.start_latency_p50_secs),
                start_latency_p95_secs: agg.as_ref().and_then(|a| a.start_latency_p95_secs),
                start_latency_max_secs: agg.as_ref().and_then(|a| a.start_latency_max_secs),
                reclaims_last_hour,
                stale,
                failure_mode,
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
                    failure_mode = job.failure_mode.unwrap_or("unknown"),
                    reason = job.reason.as_deref().unwrap_or(""),
                    last_success_at = ?job.last_success_at,
                    last_error = job.last_error.as_deref().unwrap_or(""),
                    pending = job.pending,
                    queued = job.queued,
                    running = job.running,
                    available_slots = job.available_slots,
                    oldest_waiting_secs = ?job.oldest_waiting_secs,
                    start_latency_p95_secs = ?job.start_latency_p95_secs,
                    reclaims_last_hour = job.reclaims_last_hour,
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
const LEADER_HEALTH_MAX_AGE_SECS: i64 = 30;

fn global_leader_health(
    leader: Option<&crate::jobs::leadership::GlobalBackgroundJobsSnapshot>,
    now: DateTime<Utc>,
) -> (bool, Option<i64>) {
    let heartbeat_age = leader.map(|leader| (now - leader.heartbeat_at).num_seconds().max(0));
    let healthy = leader.is_some_and(|leader| {
        leader.released_at.is_none()
            && heartbeat_age.is_some_and(|age| age <= LEADER_HEALTH_MAX_AGE_SECS)
    });
    (healthy, heartbeat_age)
}

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

    let global_leader = match crate::jobs::leadership::global_snapshot(&state.db_pool).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            tracing::error!(%error, "jobs health leader evaluation failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "leader health evaluation failed" })),
            )
                .into_response();
        }
    };
    let generated_at = Utc::now();
    let (leader_healthy, leader_heartbeat_age_secs) =
        global_leader_health(global_leader.as_ref(), generated_at);
    let queues_healthy = report.iter().all(|job| !job.stale);
    let healthy = queues_healthy && leader_healthy;
    let status = if healthy {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(serde_json::json!({
            "healthy": healthy,
            "generatedAt": generated_at,
            "globalLeader": {
                "healthy": leader_healthy,
                "heartbeatAgeSecs": leader_heartbeat_age_secs,
                "maxHeartbeatAgeSecs": LEADER_HEALTH_MAX_AGE_SECS,
                "snapshot": global_leader,
            },
            "jobs": report,
        })),
    )
        .into_response()
}

/// True when a large enough fraction of registered queues are stale to call
/// it a *systemic* stall (the whole worker fleet down) rather than one bad job.
fn is_systemic_stall(stale: usize, total: usize, fraction: f64) -> bool {
    total > 0 && (stale as f64) / (total as f64) >= fraction
}

fn env_f64(var: &str, default: f64) -> f64 {
    std::env::var(var)
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|v: &f64| v.is_finite() && *v > 0.0)
        .unwrap_or(default)
}

fn env_u64(var: &str, default: u64) -> u64 {
    std::env::var(var)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

/// Independent liveness monitor for the whole job fleet.
///
/// The `job-watchdog` above runs as an apalis worker, so when the *entire*
/// fleet stalls — e.g. a Postgres restart drops every pooled connection at once
/// and the workers park (heartbeat stops, queue dead) instead of erroring, so
/// the Monitor's exit-triggered `should_restart` never fires — the watchdog
/// stalls with it and can neither alert nor recover. (That is also why such an
/// outage produced no Sentry alert: the alerting job never ran.)
///
/// This runs as a plain background task, independent of the apalis Monitor, so
/// it keeps working when the workers don't. After a startup grace period, it
/// checks every minute whether a large fraction of queues have gone stale (or
/// the DB is unreachable) for several consecutive checks; if so it emits an
/// ERROR (→ Sentry) and **exits the process** so the orchestrator restarts it
/// clean — the only reliable way to unpark workers stuck on dead connections.
///
/// Guards against restart loops: a startup grace period (healthy queues need
/// time to record their first success), and a required run of consecutive bad
/// checks so a momentary blip doesn't restart the process. Config via env:
/// `JOB_LIVENESS_GRACE_SECONDS` (900), `JOB_LIVENESS_CHECK_INTERVAL_SECONDS`
/// (60), `JOB_LIVENESS_STALE_FRACTION` (0.6), `JOB_LIVENESS_CONSECUTIVE` (3).
pub async fn run_liveness_monitor(pool: PgPool) {
    let grace = Duration::from_secs(env_u64("JOB_LIVENESS_GRACE_SECONDS", 900));
    let interval = Duration::from_secs(env_u64("JOB_LIVENESS_CHECK_INTERVAL_SECONDS", 60).max(1));
    let stale_fraction = env_f64("JOB_LIVENESS_STALE_FRACTION", 0.6);
    let needed = env_u64("JOB_LIVENESS_CONSECUTIVE", 3).max(1);

    let start = Instant::now();
    let mut consecutive: u64 = 0;

    loop {
        tokio::time::sleep(interval).await;
        if start.elapsed() < grace {
            continue;
        }

        let bad = match evaluate(&pool).await {
            Ok(report) if !report.is_empty() => {
                let total = report.len();
                let stale = report.iter().filter(|job| job.stale).count();
                if is_systemic_stall(stale, total, stale_fraction) {
                    tracing::warn!(
                        stale,
                        total,
                        consecutive = consecutive + 1,
                        "job fleet appears broadly stalled"
                    );
                    Some(format!("{stale}/{total} queues stale"))
                } else {
                    None
                }
            }
            // Registry not installed yet, or no queues — not a signal.
            Ok(_) => None,
            // DB unreachable is itself a fleet-down signal; restarting
            // re-establishes connections.
            Err(e) => {
                tracing::warn!(error = %e, consecutive = consecutive + 1, "job liveness check failed");
                Some(format!("liveness DB check failed: {e}"))
            }
        };

        match bad {
            Some(reason) => {
                consecutive += 1;
                if consecutive >= needed {
                    // ERROR → Sentry (this task is alive even when the fleet is
                    // not, so unlike the in-process watchdog this alert fires).
                    tracing::error!(
                        reason = %reason,
                        consecutive,
                        "job fleet stalled; restarting process to recover"
                    );
                    // Give the log/Sentry a moment to flush before exit.
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    std::process::exit(1);
                }
            }
            None => consecutive = 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn systemic_stall_needs_a_majority_of_queues() {
        // One bad job in a healthy fleet is not systemic.
        assert!(!is_systemic_stall(1, 30, 0.6));
        assert!(!is_systemic_stall(17, 30, 0.6)); // 56% < 60%
        // The incident: 24/30 stale is systemic.
        assert!(is_systemic_stall(24, 30, 0.6));
        assert!(is_systemic_stall(18, 30, 0.6)); // exactly 60%
        // Never divide by zero on an empty registry.
        assert!(!is_systemic_stall(0, 0, 0.6));
    }

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

    #[test]
    fn leader_health_uses_thirty_second_external_threshold() {
        let now = Utc::now();
        let mut leader = crate::jobs::leadership::GlobalBackgroundJobsSnapshot {
            instance_id: uuid::Uuid::new_v4(),
            generation: 1,
            acquired_at: now - chrono::Duration::minutes(1),
            heartbeat_at: now - chrono::Duration::seconds(30),
            released_at: None,
            active: false,
        };
        assert_eq!(global_leader_health(Some(&leader), now), (true, Some(30)));
        leader.heartbeat_at = now - chrono::Duration::seconds(31);
        assert_eq!(global_leader_health(Some(&leader), now), (false, Some(31)));
        leader.heartbeat_at = now;
        leader.released_at = Some(now);
        assert_eq!(global_leader_health(Some(&leader), now), (false, Some(0)));
        assert_eq!(global_leader_health(None, now), (false, None));
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn health_query_distinguishes_capacity_from_wake_failure(
        pool: PgPool,
    ) -> Result<(), sqlx::Error> {
        crate::jobs::setup_apalis(&pool).await?;
        let spec = QueueSpec::queue("health-test", 1, Duration::from_secs(30))
            .with_backlog_alert_after(Duration::from_secs(1));
        assert!(
            REGISTRY.set((Utc::now(), vec![spec])).is_ok(),
            "test owns the process-wide registry"
        );

        sqlx::query(
            r#"
            INSERT INTO apalis.jobs (job, id, job_type, status, run_at, lock_at)
            VALUES
                (decode('7b7d', 'hex'), 'health-pending', 'health-test', 'Pending',
                 NOW() - INTERVAL '20 seconds', NULL),
                (decode('7b7d', 'hex'), 'health-running', 'health-test', 'Running',
                 NOW() - INTERVAL '20 seconds', NOW())
            "#,
        )
        .execute(&pool)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO background_job_reclaims (
                job_id, job_type, from_status, action, reason
            ) VALUES ('old', 'health-test', 'Queued', 'requeued', 'test')
            "#,
        )
        .execute(&pool)
        .await?;

        let report = evaluate(&pool).await?;
        assert_eq!(report.len(), 1);
        assert_eq!(report[0].failure_mode, Some("capacity"));
        assert_eq!(report[0].available_slots, 0);
        assert_eq!(report[0].reclaims_last_hour, 1);
        assert!(report[0].start_latency_p95_secs.is_some());

        sqlx::query(
            "UPDATE apalis.jobs SET status = 'Done', done_at = NOW() WHERE id = 'health-running'",
        )
        .execute(&pool)
        .await?;
        let report = evaluate(&pool).await?;
        assert_eq!(report[0].failure_mode, Some("wake"));
        assert_eq!(report[0].available_slots, 1);
        Ok(())
    }
}
