//! Daily gold reconciliation: mark backfilled DAOs dirty, then project.

use std::time::Duration;

use sqlx::PgPool;

use super::cursors::mark_backfilled_confidential_daos_gold_dirty;
use super::deposit_corrections::ConfidentialDepositCorrector;
use super::history_events::{
    CONFIDENTIAL_GOLD_RECONCILIATION_WORKERS, confidential_deposit_corrections_enabled,
    project_confidential_gold_for_dirty_daos,
};

pub const CONFIDENTIAL_GOLD_RECONCILIATION_INTERVAL: Duration = Duration::from_secs(86_400);

/// Background worker: runs gold reconciliation once at startup, then daily.
pub fn spawn_confidential_gold_reconciliation_worker(pool: PgPool) {
    tokio::spawn(async move {
        tracing::info!(
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
        Ok(rows) => tracing::info!(
            "{} reconciliation marked {} backfilled cursor rows dirty",
            phase,
            rows
        ),
        Err(e) => tracing::error!("{} reconciliation mark-dirty failed: {}", phase, e),
    }

    project_dirty_daos(pool, phase, "pre-correction").await;

    // Corrections are paired against gold deposit rows, so a freshly rebuilt or
    // truncated database needs the base gold projection before this backfill can
    // write anything. Any written correction marks gold dirty for the replay
    // below.
    if confidential_deposit_corrections_enabled() {
        let corrections_written =
            match ConfidentialDepositCorrector::reconcile_backfilled_daos(pool).await {
                Ok(written) => {
                    tracing::info!(
                        "{} reconciliation wrote {} confidential deposit corrections",
                        phase,
                        written
                    );
                    written
                }
                Err(e) => {
                    tracing::error!("{} deposit correction backfill failed: {}", phase, e);
                    0
                }
            };

        if corrections_written > 0 {
            project_dirty_daos(pool, phase, "post-correction").await;
        }
    }
}

async fn project_dirty_daos(pool: &PgPool, phase: &str, step: &str) {
    match project_confidential_gold_for_dirty_daos(pool, CONFIDENTIAL_GOLD_RECONCILIATION_WORKERS)
        .await
    {
        Ok(stats) if stats.accounts_seen > 0 => tracing::info!(
            "{} reconciliation {} projection seen={} projected={} locked={} failed={} rows={} deleted={} errors={}",
            phase,
            step,
            stats.accounts_seen,
            stats.accounts_projected,
            stats.accounts_skipped_locked,
            stats.accounts_failed,
            stats.rows_projected,
            stats.rows_deleted,
            stats.errors_written
        ),
        Ok(_) => {}
        Err(e) => tracing::error!("{} reconciliation projection failed: {}", phase, e),
    }
}
