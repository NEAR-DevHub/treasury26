//! Background job orchestration on apalis.
//!
//! Every recurring worker that used to be a hand-rolled `tokio::spawn` +
//! interval loop in `main.rs` is now an apalis worker fed by an
//! `apalis-cron` schedule piped into a per-job Postgres-backed queue
//! (`apalis.jobs`). That gives us, uniformly and for free:
//!
//! - per-job queues with task history, results, and errors in Postgres
//! - the apalis-board web UI (`/` on `JOBS_UI_ADDR`) to inspect queues,
//!   workers, and task outcomes, and to trigger a job manually (PUT a task)
//! - tracing spans per task and `concurrency(1)` so cycles never overlap
//!
//! Schedules keep their old intervals/env-var overrides. Jobs that used to
//! run once at startup (reconciliation, monthly reset, dashboard, FT
//! lockup) get a task pushed at boot in addition to their cron schedule.

pub mod handlers;

use std::str::FromStr;
use std::sync::Arc;

use apalis::layers::WorkerBuilderExt;
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
/// Cron can only express intervals that align with clock boundaries, so
/// non-divisor intervals are rounded to the nearest expressible one (with a
/// warning). All defaults used by our jobs divide evenly.
pub fn schedule_every_secs(secs: u64) -> Schedule {
    let secs = secs.max(1);
    let expr = if secs < 60 {
        if 60 % secs != 0 {
            tracing::warn!(
                secs,
                "interval doesn't divide a minute; cron fires at fixed offsets"
            );
        }
        format!("*/{secs} * * * * *")
    } else if secs.is_multiple_of(86_400) {
        if secs > 86_400 {
            tracing::warn!(secs, "multi-day intervals rounded down to daily");
        }
        "0 0 0 * * *".to_string()
    } else if secs.is_multiple_of(3600) {
        let hours = secs / 3600;
        if 24 % hours != 0 {
            tracing::warn!(
                secs,
                "interval doesn't divide a day; cron fires at fixed offsets"
            );
        }
        format!("0 0 */{hours} * * *")
    } else if secs.is_multiple_of(60) {
        let mins = secs / 60;
        if 60 % mins != 0 {
            tracing::warn!(
                secs,
                "interval doesn't divide an hour; cron fires at fixed offsets"
            );
        }
        format!("0 */{mins} * * * *")
    } else {
        let mins = (secs / 60).max(1);
        tracing::warn!(
            secs,
            rounded_to_minutes = mins,
            "interval not expressible in cron; rounded to whole minutes"
        );
        format!("0 */{mins} * * * *")
    };
    Schedule::from_str(&expr).expect("generated cron expression is valid")
}

fn storage(pool: &PgPool, queue: &str) -> TickStorage {
    PostgresStorage::new_with_config(pool, &Config::new(queue))
}

/// Pushes one task now — used for jobs that must also run at startup and
/// for event-driven wakeups (treasury creation sweeper).
async fn push_now(storage: &TickStorage, queue: &'static str) {
    let mut sink = storage.clone();
    if let Err(e) = sink.push(Tick::new(chrono::Utc::now())).await {
        tracing::error!(queue, error = %e, "failed to push startup/wakeup task");
    }
}

/// One cron-scheduled apalis worker: schedule → postgres queue → handler.
macro_rules! spawn_cron_worker {
    ($queues:expr, $state:expr, $name:literal, $schedule:expr, $handler:path) => {{
        let store = storage(&$state.db_pool, $name);
        $queues.push(($name, store.clone()));
        let backend = CronStream::new($schedule).pipe_to(store);
        let worker = WorkerBuilder::new($name)
            .backend(backend)
            .data($state.clone())
            .enable_tracing()
            .concurrency(1)
            .build($handler);
        tokio::spawn(async move {
            if let Err(e) = worker.run().await {
                tracing::error!(worker = $name, error = %e, "job worker exited with error");
            }
        });
    }};
}

/// Registers and spawns every background job. Returns the queue registry
/// used to serve the apalis-board UI.
pub async fn spawn_all(state: Arc<AppState>) -> JobQueues {
    // apalis schema + tables (idempotent).
    PostgresStorage::setup(&state.db_pool)
        .await
        .expect("failed to run apalis migrations");

    let mut queues: Vec<(&'static str, TickStorage)> = Vec::new();

    if !state.env_vars.disable_balance_monitoring {
        spawn_cron_worker!(
            queues,
            state,
            "account-maintenance",
            schedule_every_secs(env_secs("MAINTENANCE_INTERVAL_SECONDS", 60)),
            handlers::account_maintenance
        );
        spawn_cron_worker!(
            queues,
            state,
            "confidential-poll",
            schedule_every_secs(env_secs("CONFIDENTIAL_POLL_INTERVAL_SECONDS", 300)),
            handlers::confidential_poll
        );
    }

    spawn_cron_worker!(
        queues,
        state,
        "price-sync",
        schedule_every_secs(60),
        handlers::price_sync
    );

    spawn_cron_worker!(
        queues,
        state,
        "confidential-history-ingest",
        schedule_every_secs(10),
        handlers::confidential_history_ingest
    );

    spawn_cron_worker!(
        queues,
        state,
        "confidential-snapshots",
        schedule_every_secs(3600),
        handlers::confidential_snapshots
    );

    spawn_cron_worker!(
        queues,
        state,
        "confidential-gold-reconciliation",
        schedule_every_secs(86_400),
        handlers::confidential_gold_reconciliation
    );

    spawn_cron_worker!(
        queues,
        state,
        "bulk-payment-payout",
        schedule_every_secs(5),
        handlers::bulk_payment_payout
    );

    if state.goldsky_pool.is_some() {
        spawn_cron_worker!(
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
        spawn_cron_worker!(
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

    spawn_cron_worker!(
        queues,
        state,
        "status-monitor",
        schedule_every_secs(60),
        handlers::status_monitor
    );

    spawn_cron_worker!(
        queues,
        state,
        "notifications",
        schedule_every_secs(15),
        handlers::notifications
    );

    spawn_cron_worker!(
        queues,
        state,
        "sponsor-balance-monitor",
        schedule_every_secs(env_secs("SPONSOR_BALANCE_POLL_INTERVAL_SECONDS", 60)),
        handlers::sponsor_balance_monitor
    );

    spawn_cron_worker!(
        queues,
        state,
        "dao-list-sync",
        schedule_every_secs(1800),
        handlers::dao_list_sync
    );

    // Was a 1s poll; 5s keeps dirty-DAO latency low without writing a task
    // row to Postgres every second.
    spawn_cron_worker!(
        queues,
        state,
        "dao-policy-dirty",
        schedule_every_secs(5),
        handlers::dao_policy_dirty
    );

    spawn_cron_worker!(
        queues,
        state,
        "dao-policy-stale",
        schedule_every_secs(60),
        handlers::dao_policy_stale
    );

    spawn_cron_worker!(
        queues,
        state,
        "subscription-monthly-reset",
        Schedule::from_str("0 0 0 * * *").expect("valid cron"),
        handlers::subscription_monthly_reset
    );

    if !state.env_vars.disable_stats_generation {
        spawn_cron_worker!(
            queues,
            state,
            "public-dashboard-refresh",
            Schedule::from_str("0 0 0 * * Mon").expect("valid cron"),
            handlers::public_dashboard_refresh
        );
    }

    if !state.env_vars.disable_ft_lockup_scheduler {
        spawn_cron_worker!(
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
    spawn_cron_worker!(
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

/// apalis-board: REST API + web UI over every registered queue, gated by
/// HTTP Basic Auth against the admin credentials.
pub fn board_router(queues: &JobQueues, state: Arc<AppState>) -> Router {
    use apalis_board::axum::framework::{ApiBuilder, RegisterRoute};
    use apalis_board::axum::ui::ServeUI;

    let mut api = ApiBuilder::new(Router::new());
    for (_, store) in &queues.entries {
        api = api.register(store.clone());
    }

    Router::new()
        .nest("/api/v1", api.build())
        .fallback_service(ServeUI::new())
        .layer(axum::middleware::from_fn_with_state(
            state,
            board_basic_auth,
        ))
}

/// Serves the board on its own listener when `JOBS_UI_ADDR` is set
/// (e.g. `127.0.0.1:3003`), gated by Basic Auth against `ADMIN_USERS`.
pub fn spawn_board_server(queues: &JobQueues, state: Arc<AppState>) {
    let Ok(addr) = std::env::var("JOBS_UI_ADDR") else {
        tracing::info!("apalis board UI disabled (JOBS_UI_ADDR not set)");
        return;
    };
    let router = board_router(queues, state);
    tokio::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(&addr).await {
            Ok(listener) => listener,
            Err(e) => {
                tracing::error!(addr, error = %e, "failed to bind jobs UI listener");
                return;
            }
        };
        tracing::info!(addr = %addr, "apalis board UI running");
        if let Err(e) = axum::serve(listener, router).await {
            tracing::error!(error = %e, "jobs UI server exited");
        }
    });
}
