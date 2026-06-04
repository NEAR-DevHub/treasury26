//! Daily gold reconciliation: mark backfilled DAOs dirty, then project.

use std::time::Duration;

use sqlx::PgPool;

use super::cursors::mark_backfilled_confidential_daos_gold_dirty;
use super::history_events::{
    CONFIDENTIAL_GOLD_RECONCILIATION_WORKERS, project_confidential_gold_for_dirty_daos,
};

pub const CONFIDENTIAL_GOLD_RECONCILIATION_INTERVAL: Duration = Duration::from_secs(86_400);

/// Background worker: runs gold reconciliation once at startup, then daily.
pub fn spawn_confidential_gold_reconciliation_worker(pool: PgPool) {
    tokio::spawn(async move {
        log::info!(
            "Starting confidential gold reconciliation ({:?} interval, {} workers)",
            CONFIDENTIAL_GOLD_RECONCILIATION_INTERVAL,
            CONFIDENTIAL_GOLD_RECONCILIATION_WORKERS
        );

        run_reconciliation_pass(&pool, "startup").await;

        let mut timer = tokio::time::interval(CONFIDENTIAL_GOLD_RECONCILIATION_INTERVAL);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        timer.tick().await;
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
