//! Gold projection for confidential 1Click history rows.

mod classify;
mod models;
mod projector;
mod repository;

use std::time::Duration;

use sqlx::PgPool;

pub use projector::{project_confidential_gold_for_dao, project_confidential_gold_for_dirty_daos};
pub use repository::{
    mark_backfilled_confidential_daos_gold_dirty, mark_gold_dirty_for_history_event,
    mark_gold_dirty_tx, refresh_gold_metadata_for_intent,
};

pub const CONFIDENTIAL_GOLD_RECONCILIATION_WORKERS: usize = 8;
pub const CONFIDENTIAL_GOLD_RECONCILIATION_INTERVAL_SECS: u64 = 86_400;

/// Background worker: runs gold reconciliation once at startup, then daily.
/// Each pass marks backfilled cursor rows dirty, then projects all dirty DAOs.
pub fn spawn_confidential_gold_reconciliation_worker(pool: PgPool) {
    tokio::spawn(async move {
        log::info!(
            "Starting confidential gold reconciliation ({}s interval, {} workers)",
            CONFIDENTIAL_GOLD_RECONCILIATION_INTERVAL_SECS,
            CONFIDENTIAL_GOLD_RECONCILIATION_WORKERS
        );

        run_reconciliation_pass(&pool, "startup").await;

        let mut timer = tokio::time::interval(Duration::from_secs(
            CONFIDENTIAL_GOLD_RECONCILIATION_INTERVAL_SECS,
        ));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        timer.tick().await; // immediate tick consumed by the startup run above
        loop {
            timer.tick().await;
            run_reconciliation_pass(&pool, "daily").await;
        }
    });
}

async fn run_reconciliation_pass(pool: &PgPool, phase: &str) {
    match mark_backfilled_confidential_daos_gold_dirty(pool).await {
        Ok(rows) => log::info!(
            "[confidential-gold] {} reconciliation marked {} backfilled cursor rows dirty",
            phase,
            rows
        ),
        Err(e) => log::error!(
            "[confidential-gold] {} reconciliation mark-dirty failed: {}",
            phase,
            e
        ),
    }
    match project_confidential_gold_for_dirty_daos(pool, CONFIDENTIAL_GOLD_RECONCILIATION_WORKERS)
        .await
    {
        Ok(stats) if stats.accounts_seen > 0 => log::info!(
            "[confidential-gold] {} reconciliation seen={} projected={} locked={} failed={} rows={} deleted={} errors={}",
            phase,
            stats.accounts_seen,
            stats.accounts_projected,
            stats.accounts_skipped_locked,
            stats.accounts_failed,
            stats.rows_projected,
            stats.rows_deleted,
            stats.errors_written
        ),
        Ok(_) => {}
        Err(e) => log::error!(
            "[confidential-gold] {} reconciliation projection failed: {}",
            phase,
            e
        ),
    }
}
