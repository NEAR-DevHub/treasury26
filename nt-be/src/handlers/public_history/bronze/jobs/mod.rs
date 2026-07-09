use std::sync::Arc;

use crate::AppState;

pub mod model;
mod postgres;
mod scheduler;
mod worker;

pub(crate) use scheduler::run_public_history_scheduler_cycle;

pub async fn start_public_history_queue_workers(state: Arc<AppState>) -> Result<(), sqlx::Error> {
    if state.env_vars.nearblocks_api_key.is_none() {
        tracing::warn!("public history queue workers disabled: NEARBLOCKS_API_KEY missing");
        return Ok(());
    }

    postgres::setup_public_history_jobs(&state.db_pool).await?;
    worker::spawn_public_history_job_workers(state);
    Ok(())
}
