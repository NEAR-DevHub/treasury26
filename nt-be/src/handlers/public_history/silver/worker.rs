use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt;
use sqlx::PgPool;

use super::cursors::clear_silver_dirty_if_not_advanced;
use super::models::{SilverProjectionCycleStats, SilverProjectionResult};
use super::normalize::normalize_bronze_row;
use super::repository::{
    clear_projection_error, delete_stale_silver_rows, earliest_bronze_time, has_silver_before,
    load_bronze_suffix, load_dirty_accounts, mark_gold_dirty_for_silver_change,
    upsert_projection_error, upsert_silver_leg,
};
use crate::AppState;

const PUBLIC_SILVER_SCHEDULER_TICK: Duration = Duration::from_secs(10);
const PUBLIC_SILVER_WORKERS: usize = 4;

pub async fn project_public_silver_for_account(
    pool: &PgPool,
    account_id: &str,
) -> Result<SilverProjectionResult, sqlx::Error> {
    let mut tx = pool.begin().await?;

    let got_lock: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtext($1))")
        .bind(format!("public-silver:{}", account_id))
        .fetch_one(&mut *tx)
        .await?;
    if !got_lock {
        tx.commit().await?;
        return Ok(SilverProjectionResult {
            skipped_locked: true,
            ..SilverProjectionResult::default()
        });
    }

    let cursor = sqlx::query_as::<
        _,
        (
            chrono::DateTime<chrono::Utc>,
            Option<chrono::DateTime<chrono::Utc>>,
        ),
    >(
        r#"
        SELECT silver_dirty_since, silver_recompute_from
        FROM silver_public_history_cursors
        WHERE account_id = $1
          AND silver_dirty_since IS NOT NULL
        FOR UPDATE
        "#,
    )
    .bind(account_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((dirty_since, cursor_recompute_from)) = cursor else {
        tx.commit().await?;
        return Ok(SilverProjectionResult::default());
    };

    let earliest = earliest_bronze_time(&mut tx, account_id).await?;
    let Some(earliest) = earliest else {
        clear_silver_dirty_if_not_advanced(&mut tx, account_id, dirty_since).await?;
        tx.commit().await?;
        return Ok(SilverProjectionResult::default());
    };

    let mut recompute_from = cursor_recompute_from.unwrap_or(earliest);
    if earliest < recompute_from && !has_silver_before(&mut tx, account_id, recompute_from).await? {
        recompute_from = earliest;
    }

    let rows = load_bronze_suffix(&mut tx, account_id, recompute_from).await?;
    let mut stats = SilverProjectionResult::default();
    let mut preserve_leg_keys: HashSet<String> = HashSet::new();

    for row in rows {
        match normalize_bronze_row(&row) {
            Ok(Some(leg)) => {
                preserve_leg_keys.insert(leg.leg_key.clone());
                upsert_silver_leg(&mut tx, &leg).await?;
                clear_projection_error(&mut tx, row.id).await?;
                stats.rows_projected += 1;
            }
            Ok(None) => {
                clear_projection_error(&mut tx, row.id).await?;
            }
            Err(reason) => {
                upsert_projection_error(&mut tx, row.id, account_id, &reason, &row.raw_payload)
                    .await?;
                stats.errors_written += 1;
            }
        }
    }

    let preserve_leg_keys = preserve_leg_keys.into_iter().collect::<Vec<_>>();
    stats.rows_deleted =
        delete_stale_silver_rows(&mut tx, account_id, recompute_from, &preserve_leg_keys).await?;

    if stats.rows_projected > 0 || stats.rows_deleted > 0 {
        mark_gold_dirty_for_silver_change(&mut tx, account_id, Some(recompute_from)).await?;
    }

    clear_silver_dirty_if_not_advanced(&mut tx, account_id, dirty_since).await?;
    tx.commit().await?;

    Ok(stats)
}

pub async fn project_public_silver_for_dirty_accounts(
    pool: &PgPool,
) -> Result<SilverProjectionCycleStats, sqlx::Error> {
    let dirty_accounts = load_dirty_accounts(pool).await?;
    let accounts_seen = dirty_accounts.len();

    let mut stream = futures::stream::iter(dirty_accounts.into_iter().map(|account| {
        let pool = pool.clone();
        async move {
            let account_id = account.account_id;
            let result = project_public_silver_for_account(&pool, &account_id).await;
            (account_id, result)
        }
    }))
    .buffer_unordered(PUBLIC_SILVER_WORKERS);

    let mut stats = SilverProjectionCycleStats {
        accounts_seen,
        ..SilverProjectionCycleStats::default()
    };

    while let Some((account_id, result)) = stream.next().await {
        match result {
            Ok(account_stats) if account_stats.skipped_locked => {
                stats.accounts_skipped_locked += 1;
            }
            Ok(account_stats) => {
                stats.accounts_projected += 1;
                stats.rows_projected += account_stats.rows_projected;
                stats.rows_deleted += account_stats.rows_deleted;
                stats.errors_written += account_stats.errors_written;
            }
            Err(e) => {
                stats.accounts_failed += 1;
                tracing::warn!(
                    account_id = account_id,
                    error = %e,
                    "public silver projection failed"
                );
            }
        }
    }

    Ok(stats)
}

pub fn spawn_public_silver_worker(state: Arc<AppState>) {
    tokio::spawn(async move {
        tracing::info!(
            "Starting public silver worker ({:?} scheduler tick)",
            PUBLIC_SILVER_SCHEDULER_TICK
        );

        let mut timer = tokio::time::interval(PUBLIC_SILVER_SCHEDULER_TICK);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            timer.tick().await;
            let started_at = Instant::now();
            match project_public_silver_for_dirty_accounts(&state.db_pool).await {
                Ok(stats) if stats.accounts_seen > 0 => {
                    tracing::info!(
                        elapsed_secs = started_at.elapsed().as_secs_f64(),
                        accounts_seen = stats.accounts_seen,
                        accounts_projected = stats.accounts_projected,
                        accounts_skipped_locked = stats.accounts_skipped_locked,
                        accounts_failed = stats.accounts_failed,
                        rows_projected = stats.rows_projected,
                        rows_deleted = stats.rows_deleted,
                        errors_written = stats.errors_written,
                        "public silver cycle finished"
                    );
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::error!(error = %e, "public silver cycle failed");
                }
            }
        }
    });
}
