use std::sync::Arc;

use crate::AppState;

pub mod model;
mod postgres;
mod scheduler;
mod worker;

pub fn spawn_public_history_queue_workers(state: Arc<AppState>) {
    if state.env_vars.nearblocks_api_key.is_none() {
        tracing::warn!("public history queue workers disabled: NEARBLOCKS_API_KEY missing");
        return;
    }

    tokio::spawn(async move {
        if let Err(error) = postgres::setup_public_history_jobs(&state.db_pool).await {
            tracing::error!(error = %error, "public history Apalis setup failed");
            return;
        }

        worker::spawn_public_history_job_workers(state.clone());
        scheduler::spawn_public_history_scheduler(state);
    });
}
