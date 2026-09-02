use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::AppState;

pub mod model;
mod postgres;
mod scheduler;
mod worker;

pub(crate) use scheduler::{
    run_public_history_backfill_scheduler_cycle, run_public_history_detector_cycle,
    run_public_history_latest_dispatcher_cycle, run_public_history_readiness_scheduler_cycle,
};
pub(crate) use worker::{board_storages, public_history_queue_specs};

/// A public-history consumer supervisor owned and polled by the elected leader
/// runtime. Keeping these as futures (rather than pre-spawned tasks) guarantees
/// that aborting the leader runtime also drops the consumers before the
/// advisory lock is released.
pub(crate) type PublicHistorySupervisorFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// Force a synchronous readiness refresh for one account — drains all 3
/// NearBlocks sources to the current provider head and stamps coverage.
/// Exposed for diagnostics (verification's candidate query requires a fresh
/// watermark); the normal path is the scheduled readiness cycle via
/// `run_public_history_readiness_scheduler_cycle`.
pub async fn refresh_readiness_for_account(
    state: &AppState,
    account_id: &str,
) -> Result<(), String> {
    worker::run_readiness_refresh(state, account_id)
        .await
        .map(|_| ())
        .map_err(|(_, message)| message)
}

pub async fn setup_public_history_queue_workers(state: &AppState) -> Result<(), sqlx::Error> {
    if state.env_vars.nearblocks_api_key.is_none() {
        tracing::warn!("public history queue workers disabled: NEARBLOCKS_API_KEY missing");
        return Ok(());
    }

    postgres::setup_public_history_jobs(&state.db_pool).await?;
    Ok(())
}

pub(crate) fn public_history_queue_worker_futures(
    state: Arc<AppState>,
    shutdown: CancellationToken,
    wake_hub: crate::jobs::platform::JobWakeHub,
) -> Vec<PublicHistorySupervisorFuture> {
    if state.env_vars.nearblocks_api_key.is_none() {
        return Vec::new();
    }
    worker::public_history_job_worker_futures(state, shutdown, wake_hub)
}
