use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::AppState;

pub mod model;
mod postgres;
mod scheduler;
mod worker;

pub(crate) use scheduler::run_public_history_scheduler_cycle;
pub(crate) use worker::board_storages;

/// Queue names of the two event-driven workers, for watchdog registration.
pub(crate) const QUEUE_NAMES: [&str; 2] = [
    postgres::PUBLIC_HISTORY_LATEST_NAMESPACE,
    postgres::PUBLIC_HISTORY_BACKFILL_NAMESPACE,
];

pub async fn setup_public_history_queue_workers(state: &AppState) -> Result<(), sqlx::Error> {
    if state.env_vars.nearblocks_api_key.is_none() {
        tracing::warn!("public history queue workers disabled: NEARBLOCKS_API_KEY missing");
        return Ok(());
    }

    postgres::setup_public_history_jobs(&state.db_pool).await?;
    Ok(())
}

pub fn spawn_public_history_queue_workers(
    state: Arc<AppState>,
    shutdown: CancellationToken,
) -> Vec<tokio::task::JoinHandle<()>> {
    if state.env_vars.nearblocks_api_key.is_none() {
        return Vec::new();
    }
    worker::spawn_public_history_job_workers(state, shutdown)
}
