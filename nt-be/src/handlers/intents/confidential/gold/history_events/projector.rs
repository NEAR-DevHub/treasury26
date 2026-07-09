use std::collections::HashSet;

use futures::StreamExt;
use sqlx::PgPool;

use super::convert::bronze_to_gold;
use super::models::{ConfidentialDepositCorrectionIndex, DaoProjectionStats, ProjectionCycleStats};
use super::repository::{
    clear_projection_error, delete_stale_gold_rows, earliest_success_for_dao, has_gold_before,
    load_bronze_suffix, load_confidential_deposit_corrections, load_dirty_daos, seed_ledger_before,
    upsert_projection, upsert_projection_error,
};
use crate::handlers::intents::confidential::gold::cursors::clear_gold_dirty_if_not_advanced;

/// Env flag (default ON) gating the confidential deposit-amount correction.
/// Set `CORRECT_CONFIDENTIAL_DEPOSIT_AMOUNTS=false` to revert to raw 1Click
/// history amounts; re-project (reconciliation or manual dirty) to apply.
pub(crate) fn confidential_deposit_corrections_enabled() -> bool {
    !matches!(
        std::env::var("CORRECT_CONFIDENTIAL_DEPOSIT_AMOUNTS").as_deref(),
        Ok("false") | Ok("0")
    )
}

#[tracing::instrument(level = "info", skip_all, fields(dao_id = dao_id))]
pub async fn project_confidential_gold_for_dao(
    pool: &PgPool,
    dao_id: &str,
) -> Result<DaoProjectionStats, sqlx::Error> {
    let mut tx = pool.begin().await?;

    let got_lock: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtext($1))")
        .bind(dao_id)
        .fetch_one(&mut *tx)
        .await?;
    if !got_lock {
        tx.commit().await?;
        return Ok(DaoProjectionStats {
            skipped_locked: true,
            ..DaoProjectionStats::default()
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
        SELECT gold_dirty_since, gold_recompute_from
        FROM gold_confidential_history_cursors
        WHERE account_id = $1
          AND gold_dirty_since IS NOT NULL
        FOR UPDATE
        "#,
    )
    .bind(dao_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((dirty_since, cursor_recompute_from)) = cursor else {
        tx.commit().await?;
        return Ok(DaoProjectionStats::default());
    };

    let earliest_success = earliest_success_for_dao(&mut tx, dao_id).await?;
    let Some(earliest_success) = earliest_success else {
        clear_gold_dirty_if_not_advanced(&mut tx, dao_id, dirty_since).await?;
        tx.commit().await?;
        return Ok(DaoProjectionStats::default());
    };

    let mut recompute_from = cursor_recompute_from.unwrap_or(earliest_success);
    if earliest_success < recompute_from
        && !has_gold_before(&mut tx, dao_id, recompute_from).await?
    {
        recompute_from = earliest_success;
    }

    let mut stats = DaoProjectionStats::default();
    let mut ledger = seed_ledger_before(&mut tx, dao_id, recompute_from).await?;
    let rows = load_bronze_suffix(&mut tx, dao_id, recompute_from).await?;
    let corrections = if confidential_deposit_corrections_enabled() {
        load_confidential_deposit_corrections(&mut tx, dao_id, recompute_from).await?
    } else {
        ConfidentialDepositCorrectionIndex::empty_disabled()
    };

    // Preserve gold rows for any bronze event we *considered* and either
    // projected successfully or could not project (errored). A transient
    // projection failure must not wipe out a previously good gold row.
    // Skipped events (Ok(None)) are intentionally excluded — they represent
    // bronze events that should not have a gold row at all.

    let mut preserve_ids: HashSet<i64> = HashSet::new();

    for row in rows {
        match bronze_to_gold(&row, &mut ledger, &corrections) {
            Ok(Some(projected)) => {
                preserve_ids.insert(projected.history_event_id);
                upsert_projection(&mut tx, &projected).await?;
                stats.rows_projected += 1;
            }
            Ok(None) => {
                clear_projection_error(&mut tx, row.id).await?;
            }
            Err(reason) => {
                preserve_ids.insert(row.id);
                upsert_projection_error(&mut tx, row.id, dao_id, &reason, &row.raw_payload).await?;
                stats.errors_written += 1;
            }
        }
    }

    let preserve_ids: Vec<i64> = preserve_ids.into_iter().collect();
    stats.rows_deleted =
        delete_stale_gold_rows(&mut tx, dao_id, recompute_from, &preserve_ids).await?;

    clear_gold_dirty_if_not_advanced(&mut tx, dao_id, dirty_since).await?;

    tx.commit().await?;
    Ok(stats)
}

#[tracing::instrument(
    level = "info",
    skip_all,
    fields(job = "confidential_gold_projection", worker_limit = worker_limit)
)]
pub async fn project_confidential_gold_for_dirty_daos(
    pool: &PgPool,
    worker_limit: usize,
) -> Result<ProjectionCycleStats, sqlx::Error> {
    let dirty_daos = load_dirty_daos(pool).await?;
    let accounts_seen = dirty_daos.len();
    let worker_limit = worker_limit.max(1);

    let mut stream = futures::stream::iter(dirty_daos.into_iter().map(|dao| {
        let pool = pool.clone();
        async move {
            let dao_id = dao.account_id;
            let dirty_since = dao.gold_dirty_since;
            let recompute_from = dao.gold_recompute_from;
            let result = project_confidential_gold_for_dao(&pool, &dao_id).await;
            (dao_id, dirty_since, recompute_from, result)
        }
    }))
    .buffer_unordered(worker_limit);

    let mut stats = ProjectionCycleStats {
        accounts_seen,
        ..ProjectionCycleStats::default()
    };

    while let Some((dao_id, dirty_since, recompute_from, result)) = stream.next().await {
        match result {
            Ok(dao_stats) if dao_stats.skipped_locked => {
                stats.accounts_skipped_locked += 1;
            }
            Ok(dao_stats) => {
                if dao_stats.rows_projected > 0 || dao_stats.rows_deleted > 0 {
                    stats.changed_accounts.push(dao_id.clone());
                }
                stats.accounts_projected += 1;
                stats.rows_projected += dao_stats.rows_projected;
                stats.rows_deleted += dao_stats.rows_deleted;
                stats.errors_written += dao_stats.errors_written;
                tracing::info!(
                    "projected dao={} dirty_since={} recompute_from={:?} rows={} deleted={} errors={}",
                    dao_id,
                    dirty_since,
                    recompute_from,
                    dao_stats.rows_projected,
                    dao_stats.rows_deleted,
                    dao_stats.errors_written
                );
            }
            Err(e) => {
                stats.accounts_failed += 1;
                tracing::warn!(
                    "projection failed for dao={} dirty_since={} recompute_from={:?}: {}",
                    dao_id,
                    dirty_since,
                    recompute_from,
                    e
                );
            }
        }
    }

    Ok(stats)
}
