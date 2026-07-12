//! Background job orchestration on apalis.
//!
//! Every recurring worker that used to be a hand-rolled `tokio::spawn` +
//! interval loop in `main.rs` is now an apalis worker fed by an
//! `apalis-cron` schedule piped into a per-job Postgres-backed queue
//! (`apalis.jobs`). That gives us, uniformly and for free:
//!
//! - per-job queues with task history, results, and errors in Postgres
//! - the apalis-board web UI (mounted on the main HTTP service behind
//!   Basic Auth) to inspect queues, workers, and task outcomes, and to
//!   trigger a job manually (PUT a task)
//! - tracing spans per task and `concurrency(1)` so cycles never overlap
//!
//! Schedules keep their old intervals/env-var overrides. Jobs that used to
//! run once at startup (reconciliation, monthly reset, dashboard, FT
//! lockup) get a task pushed at boot in addition to their cron schedule.

pub mod context;
pub mod handlers;

use std::str::FromStr;
use std::sync::Arc;

use apalis::layers::WorkerBuilderExt;
use apalis::layers::sentry::SentryLayer;
use apalis::layers::tracing::{DefaultOnFailure, TraceLayer};
use apalis::prelude::*;
use apalis_core::backend::TaskSink;
use apalis_core::backend::pipe::PipeExt;
use apalis_cron::{CronStream, Tick};
use apalis_postgres::{Config, PostgresStorage};
use axum::Router;
use cron::Schedule;
use sqlx::PgPool;

use crate::AppState;

/// Queue backend shared by all jobs: cron ticks persisted to Postgres.
pub type TickStorage = PostgresStorage<Tick>;

/// Storages of every registered queue, in registration order. Held so the
/// board router can be built and manual/startup tasks can be pushed.
pub struct JobQueues {
    pub entries: Vec<(&'static str, TickStorage)>,
}

impl JobQueues {
    pub fn storage(&self, name: &str) -> Option<&TickStorage> {
        self.entries
            .iter()
            .find(|(queue, _)| *queue == name)
            .map(|(_, storage)| storage)
    }
}

fn env_secs(var: &str, default: u64) -> u64 {
    std::env::var(var)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

/// Builds a cron schedule that fires every `secs` seconds.
///
/// A 6-field cron `*/n` step only expresses intervals that divide their
/// field's range (seconds/minutes 0–59, hours 0–23). An interval that
/// doesn't map cleanly is rounded **down** to the largest expressible
/// interval — a *shorter* one, so the job runs at least as often as asked
/// (e.g. 90 min → 60 min, 61 s → 60 s) — with a warning naming the
/// effective interval, rather than silently collapsing to hourly. All
/// defaults our jobs use divide evenly.
pub fn schedule_every_secs(secs: u64) -> Schedule {
    Schedule::from_str(&cron_every_secs(secs)).expect("generated cron expression is valid")
}

/// Largest divisor of `base` that is `<= n` (and `>= 1`).
fn largest_divisor_at_most(base: u64, n: u64) -> u64 {
    (1..=n.min(base))
        .rev()
        .find(|d| base.is_multiple_of(*d))
        .unwrap_or(1)
}

/// Largest interval `<= secs` that `cron_every_secs` can express exactly.
fn round_down_to_expressible(secs: u64) -> u64 {
    if secs < 60 {
        largest_divisor_at_most(60, secs).max(1)
    } else if secs < 3600 {
        largest_divisor_at_most(60, secs / 60).max(1) * 60
    } else if secs < 86_400 {
        largest_divisor_at_most(24, secs / 3600).max(1) * 3600
    } else {
        86_400
    }
}

/// Interval-to-cron translation, split out for testing.
fn cron_every_secs(secs: u64) -> String {
    let secs = secs.max(1);

    // Sub-minute: a `*/n` seconds step, only clean when it divides 60.
    if secs < 60 {
        if 60u64.is_multiple_of(secs) {
            return format!("*/{secs} * * * * *");
        }
        let rounded = largest_divisor_at_most(60, secs);
        tracing::warn!(
            secs,
            effective_secs = rounded,
            "sub-minute interval not expressible in cron; rounded down"
        );
        return format!("*/{rounded} * * * * *");
    }

    // Whole minutes that divide an hour (mins in 1..=59, mins | 60).
    if secs.is_multiple_of(60) {
        let mins = secs / 60;
        if mins < 60 && 60u64.is_multiple_of(mins) {
            return format!("0 */{mins} * * * *");
        }
    }

    // Whole hours that divide a day (hours in 1..=23, hours | 24).
    if secs.is_multiple_of(3600) {
        let hours = secs / 3600;
        if hours < 24 && 24u64.is_multiple_of(hours) {
            return format!("0 0 */{hours} * * *");
        }
    }

    // Whole days -> daily (multi-day rounded down to daily).
    if secs.is_multiple_of(86_400) {
        if secs > 86_400 {
            tracing::warn!(secs, "multi-day interval rounded down to daily");
        }
        return "0 0 0 * * *".to_string();
    }

    // Anything else (e.g. 90 min, 61 s): round down to the nearest
    // expressible interval and translate that. The rounded value always
    // hits one of the clean branches above, so this recurses at most once.
    let rounded = round_down_to_expressible(secs);
    tracing::warn!(
        secs,
        effective_secs = rounded,
        "interval not expressible in cron; rounded down"
    );
    cron_every_secs(rounded)
}

/// Runs apalis's own sqlx migrations, tracking them in a dedicated
/// `apalis_migrations` schema instead of the default `public._sqlx_migrations`.
///
/// The app runs its own sqlx migrator (`app_state`), and sqlx records every
/// migrator's applied versions in an unqualified `_sqlx_migrations` table.
/// If apalis and the app share that table, each migrator sees the other's
/// versions as unknown and aborts with `VersionMissing`. All apalis objects
/// are fully schema-qualified (`apalis.*`), so only the bookkeeping table's
/// placement matters — pointing the connection's `search_path` at a private
/// schema keeps the two migration lineages isolated.
async fn setup_apalis(pool: &PgPool) -> Result<(), sqlx::Error> {
    use sqlx::Executor as _;

    pool.execute("CREATE SCHEMA IF NOT EXISTS apalis_migrations")
        .await?;

    let mut conn = pool.acquire().await?;
    // Session-level; persists across the migrator's per-migration
    // transactions so `_sqlx_migrations` is created in `apalis_migrations`.
    conn.execute("SET search_path TO apalis_migrations, public")
        .await?;
    PostgresStorage::migrations().run(&mut *conn).await?;
    Ok(())
}

fn storage(pool: &PgPool, queue: &str) -> TickStorage {
    PostgresStorage::new_with_config(pool, &Config::new(queue))
}

/// Resolves on the first shutdown signal so the monitor can drain in-flight
/// tasks. On Unix that's SIGINT **or** SIGTERM — SIGTERM is what
/// containers/systemd send to stop the process, so waiting only on Ctrl-C
/// (SIGINT) would skip the graceful drain in production.
async fn jobs_shutdown_signal() -> std::io::Result<()> {
    // NOTE: `run_with_signal` treats *any* completion of this future — Ok or
    // Err — as a shutdown request. So on failure to install the signal
    // handlers we must NOT return (that would stop the whole jobs monitor at
    // startup); instead log and never resolve, leaving the process killable.
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let handlers = signal(SignalKind::interrupt())
            .and_then(|int| Ok((int, signal(SignalKind::terminate())?)));
        let (mut sigint, mut sigterm) = match handlers {
            Ok(pair) => pair,
            Err(e) => {
                tracing::error!(
                    error = %e,
                    "failed to install unix signal handlers; jobs graceful-shutdown signal disabled"
                );
                std::future::pending::<()>().await;
                unreachable!("pending future never resolves");
            }
        };
        tokio::select! {
            _ = sigint.recv() => {}
            _ = sigterm.recv() => {}
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::error!(
                error = %e,
                "failed to listen for ctrl_c; jobs graceful-shutdown signal disabled"
            );
            std::future::pending::<()>().await;
        }
        Ok(())
    }
}

/// Pushes one task now — used for jobs that must also run at startup and
/// for event-driven wakeups (treasury creation sweeper).
async fn push_now(storage: &TickStorage, queue: &'static str) {
    let mut sink = storage.clone();
    if let Err(e) = sink.push(Tick::new(chrono::Utc::now())).await {
        tracing::error!(queue, error = %e, "failed to push startup/wakeup task");
    }
}

/// Registers one cron-scheduled apalis worker on the [`Monitor`]:
/// schedule → postgres queue → handler.
///
/// Failure containment, inside out:
/// 1. **Task errors** → the failure is recorded and the job waits for its
///    next cron tick, which starts a fresh task — one bad cycle never stops
///    the job. There is deliberately **no automatic task-level retry**:
///    several handlers have non-idempotent side effects (on-chain
///    `payout_batch` / `claim` txs, Telegram sends), so re-running the whole
///    handler on any error could duplicate them. The cron schedule is the
///    retry, and apalis-postgres already retries transient DB/poll errors at
///    the backend with its own backoff.
/// 2. **Handler panics** → `catch_panic` converts a panic into a task error
///    (same path as #1) instead of tearing down the worker.
/// 3. **Worker exit** (sustained backend/storage failure) → the `Monitor`
///    rebuilds and restarts the worker (see `should_restart` in
///    [`spawn_all`]); a clean exit on shutdown is honoured so in-flight
///    tasks drain instead of being fought by a restart.
///
/// The `Monitor` is passed by value and reassigned (`register` is
/// builder-style), so this must be used as `monitor = register_cron_worker!(monitor, …)`.
macro_rules! register_cron_worker {
    ($monitor:expr, $queues:expr, $state:expr, $name:literal, $schedule:expr, $handler:path) => {{
        let store = storage(&$state.db_pool, $name);
        $queues.push(($name, store.clone()));
        let schedule = $schedule;
        let state = $state.clone();
        // `register` takes a factory `Fn(attempt) -> Worker`: the Monitor
        // calls it to (re)build the worker, so a restart gets a fresh
        // backend/connection.
        $monitor.register(move |_attempt| {
            WorkerBuilder::new($name)
                .backend(CronStream::new(schedule.clone()).pipe_to(store.clone()))
                .data(state.clone())
                .catch_panic()
                // apalis's Sentry integration: captures a task failure once
                // (after catch_panic has converted any panic to an error) with
                // the task's queue / id / attempt as Sentry context, plus a
                // per-task performance transaction. No-op when Sentry is off.
                .layer(SentryLayer::new())
                // Trace failures at WARN, not the default ERROR: a single
                // failed cycle is retried by the next cron tick and is a
                // warning, and this keeps the tracing→Sentry bridge
                // (ERROR→event) from emitting a *second* event for the same
                // failure the SentryLayer already captured. Persistent failures
                // still surface via Sentry + the board.
                .layer(
                    TraceLayer::new()
                        .on_failure(DefaultOnFailure::new().level(tracing::Level::WARN)),
                )
                .concurrency(1)
                .build($handler)
        })
    }};
}

/// Registers and spawns every background job. Returns the queue registry
/// used to serve the apalis-board UI.
pub async fn spawn_all(state: Arc<AppState>) -> JobQueues {
    // apalis schema + tables (idempotent).
    setup_apalis(&state.db_pool)
        .await
        .expect("failed to run apalis migrations");

    let mut queues: Vec<(&'static str, TickStorage)> = Vec::new();

    // apalis's own supervisor: runs every worker, restarts one that exits
    // (backend/storage failure) via `should_restart`, and drains in-flight
    // tasks on shutdown. Replaces the old per-worker `tokio::spawn` loops.
    //
    // The restart is immediate (the `should_restart` hook is synchronous, so
    // it can't back off). That doesn't hot-loop in practice: transient DB
    // outages are absorbed by apalis-postgres's own fetcher backoff
    // (1s→5min) *inside* `worker.run()`, so a worker rarely exits at all on a
    // blip; it only exits on a terminal condition, which is rare. A restart
    // then re-establishes the connection. (If a cooldown on repeated exits is
    // ever needed, apalis's `circuit_breaker` worker ext is the native tool.)
    let mut monitor = Monitor::new().should_restart(|ctx, err, attempt| {
        tracing::error!(
            worker = %ctx.name(),
            error = %err,
            attempt,
            "job worker exited; monitor restarting it"
        );
        true
    });

    if !state.env_vars.disable_balance_monitoring {
        monitor = register_cron_worker!(
            monitor,
            queues,
            state,
            "account-maintenance",
            schedule_every_secs(env_secs("MAINTENANCE_INTERVAL_SECONDS", 60)),
            handlers::account_maintenance
        );
        monitor = register_cron_worker!(
            monitor,
            queues,
            state,
            "confidential-poll",
            schedule_every_secs(env_secs("CONFIDENTIAL_POLL_INTERVAL_SECONDS", 300)),
            handlers::confidential_poll
        );
    }

    if state.env_vars.nearblocks_api_key.is_some() {
        crate::handlers::public_history::bronze::jobs::start_public_history_queue_workers(
            state.clone(),
        )
        .await
        .expect("failed to start public history queue workers");

        monitor = register_cron_worker!(
            monitor,
            queues,
            state,
            "public-history-scheduler",
            schedule_every_secs(2),
            handlers::public_history_scheduler
        );
        monitor = register_cron_worker!(
            monitor,
            queues,
            state,
            "public-silver-projection",
            schedule_every_secs(5),
            handlers::public_silver_projection
        );
        monitor = register_cron_worker!(
            monitor,
            queues,
            state,
            "public-gold-projection",
            schedule_every_secs(5),
            handlers::public_gold_projection
        );
        monitor = register_cron_worker!(
            monitor,
            queues,
            state,
            "public-proposal-reconciliation",
            schedule_every_secs(600),
            handlers::public_proposal_reconciliation
        );
    } else {
        tracing::warn!("public history workers disabled: NEARBLOCKS_API_KEY missing");
    }

    monitor = register_cron_worker!(
        monitor,
        queues,
        state,
        "price-sync",
        schedule_every_secs(60),
        handlers::price_sync
    );

    monitor = register_cron_worker!(
        monitor,
        queues,
        state,
        "token-price-ingest",
        schedule_every_secs(60),
        handlers::token_price_ingest
    );

    monitor = register_cron_worker!(
        monitor,
        queues,
        state,
        "confidential-history-ingest",
        schedule_every_secs(10),
        handlers::confidential_history_ingest
    );

    monitor = register_cron_worker!(
        monitor,
        queues,
        state,
        "confidential-snapshots",
        schedule_every_secs(3600),
        handlers::confidential_snapshots
    );

    monitor = register_cron_worker!(
        monitor,
        queues,
        state,
        "confidential-gold-reconciliation",
        schedule_every_secs(86_400),
        handlers::confidential_gold_reconciliation
    );

    monitor = register_cron_worker!(
        monitor,
        queues,
        state,
        "bulk-payment-payout",
        schedule_every_secs(5),
        handlers::bulk_payment_payout
    );

    if state.goldsky_pool.is_some() {
        monitor = register_cron_worker!(
            monitor,
            queues,
            state,
            "goldsky-enrichment",
            schedule_every_secs(env_secs("ENRICHMENT_INTERVAL_SECONDS", 15)),
            handlers::goldsky_enrichment
        );
    } else {
        tracing::info!("Goldsky enrichment worker disabled (GOLDSKY_DATABASE_URL not set)");
    }

    let sweeper_disabled = std::env::var("DISABLE_TREASURY_CREATION_SWEEPER")
        .is_ok_and(|v| v.eq_ignore_ascii_case("true") || v == "1");
    if sweeper_disabled {
        tracing::info!(
            "Treasury creation sweeper disabled (DISABLE_TREASURY_CREATION_SWEEPER=true)"
        );
    } else {
        monitor = register_cron_worker!(
            monitor,
            queues,
            state,
            "treasury-creation-sweeper",
            schedule_every_secs(15),
            handlers::treasury_creation_sweeper
        );
        // Event-driven wake: a failed creation attempt pings the Notify so
        // the sweep runs within moments instead of waiting for the poll.
        // Look the queue up by name — relying on `last()` breaks silently
        // if another queue is later registered below this block.
        if let Some(store) = queues
            .iter()
            .find(|(name, _)| *name == "treasury-creation-sweeper")
            .map(|(_, s)| s.clone())
        {
            let notify = state.creation_sweep_notify.clone();
            tokio::spawn(async move {
                loop {
                    notify.notified().await;
                    push_now(&store, "treasury-creation-sweeper").await;
                }
            });
        }
    }

    monitor = register_cron_worker!(
        monitor,
        queues,
        state,
        "status-monitor",
        schedule_every_secs(60),
        handlers::status_monitor
    );

    monitor = register_cron_worker!(
        monitor,
        queues,
        state,
        "notifications",
        schedule_every_secs(15),
        handlers::notifications
    );

    monitor = register_cron_worker!(
        monitor,
        queues,
        state,
        "sponsor-balance-monitor",
        schedule_every_secs(env_secs("SPONSOR_BALANCE_POLL_INTERVAL_SECONDS", 60)),
        handlers::sponsor_balance_monitor
    );

    monitor = register_cron_worker!(
        monitor,
        queues,
        state,
        "dao-list-sync",
        schedule_every_secs(1800),
        handlers::dao_list_sync
    );

    // Was a 1s poll; 5s keeps dirty-DAO latency low without writing a task
    // row to Postgres every second.
    monitor = register_cron_worker!(
        monitor,
        queues,
        state,
        "dao-policy-dirty",
        schedule_every_secs(5),
        handlers::dao_policy_dirty
    );

    monitor = register_cron_worker!(
        monitor,
        queues,
        state,
        "dao-policy-stale",
        schedule_every_secs(60),
        handlers::dao_policy_stale
    );

    monitor = register_cron_worker!(
        monitor,
        queues,
        state,
        "subscription-monthly-reset",
        Schedule::from_str("0 0 0 * * *").expect("valid cron"),
        handlers::subscription_monthly_reset
    );

    if !state.env_vars.disable_stats_generation {
        monitor = register_cron_worker!(
            monitor,
            queues,
            state,
            "public-dashboard-refresh",
            Schedule::from_str("0 0 0 * * Mon").expect("valid cron"),
            handlers::public_dashboard_refresh
        );
    }

    if !state.env_vars.disable_ft_lockup_scheduler {
        monitor = register_cron_worker!(
            monitor,
            queues,
            state,
            "ft-lockup-refresh",
            Schedule::from_str("0 0 */6 * * *").expect("valid cron"),
            handlers::ft_lockup_refresh
        );
    } else {
        tracing::info!("FT lockup scheduler disabled (DISABLE_FT_LOCKUP_SCHEDULER=true)");
    }

    // Retention: prune finished apalis tasks so high-frequency queues don't
    // grow unbounded. Daily at 03:30 UTC.
    monitor = register_cron_worker!(
        monitor,
        queues,
        state,
        "apalis-prune",
        Schedule::from_str("0 30 3 * * *").expect("valid cron"),
        handlers::apalis_prune
    );

    let queues = JobQueues { entries: queues };

    // Jobs that previously ran once at startup, in addition to their cron
    // schedule. Pushed as regular tasks so they show up on the board.
    for queue in [
        "confidential-gold-reconciliation",
        "subscription-monthly-reset",
        "public-dashboard-refresh",
        "ft-lockup-refresh",
    ] {
        if let Some(store) = queues.storage(queue) {
            // Label the push with the real queue name so a failed push is
            // attributed to the right queue in the logs.
            push_now(store, queue).await;
        }
    }

    // Drive all workers under the monitor on one supervised task. It runs
    // until a shutdown signal, then drains in-flight tasks (see
    // `shutdown_timeout` if a bound is needed).
    tokio::spawn(async move {
        if let Err(e) = monitor.run_with_signal(jobs_shutdown_signal()).await {
            tracing::error!(error = %e, "jobs monitor exited");
        }
    });

    queues
}

const BOARD_AUTH_REALM: &str = "Trezu Jobs Board";

/// HTTP Basic Auth gate for the board, reusing the same admin credentials
/// (`ADMIN_USERS`) and check as the warnings admin pages
/// (`handlers::warnings::admin`).
async fn board_basic_auth(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::{
        StatusCode,
        header::{AUTHORIZATION, WWW_AUTHENTICATE},
    };
    use axum::response::IntoResponse;
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    let unauthorized = || {
        (
            StatusCode::UNAUTHORIZED,
            [(
                WWW_AUTHENTICATE,
                format!("Basic realm=\"{BOARD_AUTH_REALM}\""),
            )],
            "Unauthorized",
        )
            .into_response()
    };

    if state.env_vars.admin_users.is_empty() {
        tracing::warn!("apalis board UI blocked: no ADMIN_USERS configured");
        return unauthorized();
    }

    let credentials = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Basic "))
        .and_then(|encoded| STANDARD.decode(encoded).ok())
        .and_then(|decoded| String::from_utf8(decoded).ok());

    let authenticated = credentials
        .as_deref()
        .and_then(|creds| creds.split_once(':'))
        .and_then(|(username, password)| {
            crate::utils::admin_auth::authenticate_admin(
                &state.env_vars.admin_users,
                username,
                password,
            )
        })
        .is_some();

    if authenticated {
        next.run(request).await
    } else {
        unauthorized()
    }
}

/// Keeps unknown `/api/*` requests a plain 404 instead of letting the
/// board's UI fallback answer them. The board's own API lives at
/// `/api/v1`; every other `/api/*` path belongs to the public API and must
/// not be shadowed (or challenged for board auth) by mounting the board.
/// True for `/api/*` paths that belong to the public API, not the board.
/// The board owns exactly `/api/v1` and everything under `/api/v1/`.
fn is_foreign_api_path(path: &str) -> bool {
    path.starts_with("/api/") && path != "/api/v1" && !path.starts_with("/api/v1/")
}

async fn board_api_guard(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    if is_foreign_api_path(request.uri().path()) {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    }
    next.run(request).await
}

/// apalis-board: REST API + web UI over every registered queue, gated by
/// HTTP Basic Auth against the admin credentials.
///
/// Mounted as the main HTTP service's `fallback_service` (see `main.rs`)
/// rather than on a separate port, so it lives behind the same listener as
/// the rest of the API — like the warnings admin pages. The board frontend
/// (apalis-board) is a root-mounted SPA (absolute asset paths +
/// `origin`-based API base), so it must be served from `/`; the API guard
/// above preserves the public API's 404 behaviour, and Basic Auth gates
/// every board route (API, UI, and static assets).
pub fn board_router(queues: &JobQueues, state: Arc<AppState>) -> Router {
    use apalis_board::axum::framework::{ApiBuilder, RegisterRoute};
    use apalis_board::axum::ui::ServeUI;

    let mut api = ApiBuilder::new(Router::new());
    for (_, store) in &queues.entries {
        api = api.register(store.clone());
    }

    // The board registers an `/api/v1/events` SSE route (apalis-board's
    // `events` feature, on by default) whose handler extracts an
    // `Extension<Arc<Mutex<TracingBroadcaster>>>`. Without it, opening the
    // dashboard 500s with "Missing request extension … TracingBroadcaster".
    // Supply the process-wide broadcaster that the tracing subscriber writes
    // to (see `observability::LOG_BROADCASTER`), so the dashboard's live-log
    // pane streams the app's logs.
    let broadcaster = crate::observability::LOG_BROADCASTER.clone();

    Router::new()
        .nest("/api/v1", api.build())
        .fallback_service(ServeUI::new())
        .layer(axum::Extension(broadcaster))
        // Auth gates every board route. Applied inside the guard so that an
        // unknown public `/api/*` path 404s without an auth challenge.
        .layer(axum::middleware::from_fn_with_state(
            state,
            board_basic_auth,
        ))
        .layer(axum::middleware::from_fn(board_api_guard))
}

#[cfg(test)]
mod tests {
    use super::{cron_every_secs, is_foreign_api_path, schedule_every_secs};

    #[test]
    fn cron_every_secs_expressible_intervals() {
        assert_eq!(cron_every_secs(10), "*/10 * * * * *"); // sub-minute
        assert_eq!(cron_every_secs(60), "0 */1 * * * *"); // 1 min
        assert_eq!(cron_every_secs(300), "0 */5 * * * *"); // 5 min
        assert_eq!(cron_every_secs(1800), "0 */30 * * * *"); // 30 min
        assert_eq!(cron_every_secs(3600), "0 0 */1 * * *"); // hourly
        assert_eq!(cron_every_secs(21_600), "0 0 */6 * * *"); // 6h
        assert_eq!(cron_every_secs(86_400), "0 0 0 * * *"); // daily
    }

    #[test]
    fn cron_every_secs_rounds_down_non_divisors() {
        // 61s is not a clean sub-hour step -> nearest minute (60s).
        assert_eq!(cron_every_secs(61), "0 */1 * * * *");
        // 90 min would previously produce "0 */90 ..." (cron caps the
        // minute field at 59, so it silently ran hourly). Now rounded down
        // to a real 60-min schedule instead of a misleading one.
        assert_eq!(cron_every_secs(5400), "0 0 */1 * * *");
        // Multi-day collapses to daily.
        assert_eq!(cron_every_secs(2 * 86_400), "0 0 0 * * *");
        // 45s (doesn't divide 60) -> largest divisor of 60 <= 45 = 30s.
        assert_eq!(cron_every_secs(45), "*/30 * * * * *");
    }

    #[test]
    fn schedule_every_secs_produces_valid_cron() {
        // Every branch (incl. rounded ones) must parse as a real schedule.
        for secs in [
            1u64, 5, 10, 45, 60, 61, 300, 3600, 5400, 21_600, 86_400, 200_000,
        ] {
            let _ = schedule_every_secs(secs);
        }
    }

    /// Regression: apalis migrations must not collide with the app's
    /// `public._sqlx_migrations`. Runs only when `DATABASE_URL` is set.
    #[tokio::test]
    async fn setup_apalis_coexists_with_app_migrations() {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return;
        };
        let pool = sqlx::PgPool::connect(&url).await.expect("connect");

        // Isolated + idempotent.
        super::setup_apalis(&pool).await.expect("first setup");
        super::setup_apalis(&pool).await.expect("idempotent re-run");

        // apalis objects exist, and its bookkeeping is in its own schema.
        let apalis_tables: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'apalis'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(apalis_tables > 0, "apalis schema should have tables");

        let apalis_tracking: i64 =
            sqlx::query_scalar("SELECT count(*) FROM apalis_migrations._sqlx_migrations")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(apalis_tracking > 0, "apalis migrations tracked separately");
    }

    #[test]
    fn board_owns_only_api_v1() {
        // Board's own API — must reach the board (not a public 404).
        assert!(!is_foreign_api_path("/api/v1"));
        assert!(!is_foreign_api_path("/api/v1/queues"));
        assert!(!is_foreign_api_path("/api/v1/queues/price-sync/tasks"));

        // Public API namespace — must stay a 404, never shadowed by the
        // board or challenged for board auth.
        assert!(is_foreign_api_path("/api/warnings"));
        assert!(is_foreign_api_path("/api/user/create"));
        assert!(is_foreign_api_path("/api/v10/x")); // not a v1 subpath

        // Non-API paths belong to the board UI (served after auth).
        assert!(!is_foreign_api_path("/"));
        assert!(!is_foreign_api_path("/queues"));
        assert!(!is_foreign_api_path("/apalis-board-web-abc.js"));
    }
}
