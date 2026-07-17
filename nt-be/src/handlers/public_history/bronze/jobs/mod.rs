use std::sync::Arc;

use apalis::prelude::Monitor;

use crate::AppState;

pub mod model;
mod postgres;
mod scheduler;
mod worker;

pub(crate) use scheduler::run_public_history_scheduler_cycle;
pub(crate) use worker::board_storages;

/// Queue names of the two task queues, for watchdog registration.
pub(crate) const QUEUE_NAMES: [&str; 2] = [
    postgres::PUBLIC_HISTORY_LATEST_NAMESPACE,
    postgres::PUBLIC_HISTORY_BACKFILL_NAMESPACE,
];

/// Registers the latest/backfill queue workers on the shared jobs [`Monitor`]
/// (restart-on-exit, catch_panic, Sentry — same supervision as cron jobs).
pub async fn start_public_history_queue_workers(
    monitor: Monitor,
    state: Arc<AppState>,
) -> Result<Monitor, sqlx::Error> {
    if state.env_vars.nearblocks_api_key.is_none() {
        tracing::warn!("public history queue workers disabled: NEARBLOCKS_API_KEY missing");
        return Ok(monitor);
    }

    postgres::setup_public_history_jobs(&state.db_pool).await?;
    Ok(worker::register_public_history_job_workers(monitor, state))
}
