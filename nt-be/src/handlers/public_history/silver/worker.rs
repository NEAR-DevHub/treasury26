use futures::StreamExt;
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};

use super::cursors::clear_silver_dirty_if_not_advanced;
use super::models::{SilverProjectionCycleStats, SilverProjectionResult};
use super::normalize::normalize_bronze_row;
use super::quote_pending::build_quote_pending_legs;
use super::repository::{
    clear_projection_errors, delete_stale_silver_rows, earliest_bronze_time, has_silver_before,
    load_bronze_suffix, load_dirty_accounts, mark_gold_dirty_for_silver_change,
    upsert_projection_errors, upsert_silver_legs,
};
use crate::handlers::public_history::bronze::store::is_public_history_backfill_complete;
const PUBLIC_SILVER_WORKERS: usize = 2;

pub async fn project_public_silver_for_account(
    pool: &PgPool,
    account_id: &str,
) -> Result<SilverProjectionResult, sqlx::Error> {
    if !is_public_history_backfill_complete(pool, account_id).await? {
        return Ok(SilverProjectionResult::default());
    }

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
        mark_gold_dirty_for_silver_change(&mut tx, account_id, None).await?;
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
    let mut legs = Vec::new();
    let mut leg_positions = HashMap::new();
    let mut preserve_leg_keys: HashSet<String> = HashSet::new();
    let mut clear_error_source_event_ids = Vec::new();
    let mut projection_errors = Vec::new();

    for row in rows {
        match normalize_bronze_row(&row) {
            Ok(Some(leg)) => {
                let leg_key = leg.leg_key.clone();
                preserve_leg_keys.insert(leg_key.clone());
                if let Some(index) = leg_positions.get(&leg_key).copied() {
                    legs[index] = leg;
                } else {
                    leg_positions.insert(leg_key, legs.len());
                    legs.push(leg);
                }
                clear_error_source_event_ids.push(row.id);
                stats.rows_projected += 1;
            }
            Ok(None) => {
                clear_error_source_event_ids.push(row.id);
            }
            Err(reason) => {
                projection_errors.push((row.id, reason, row.raw_payload));
                stats.errors_written += 1;
            }
        }
    }

    upsert_silver_legs(&mut tx, &legs).await?;
    let quote_pending_legs = build_quote_pending_legs(&mut tx, account_id, recompute_from).await?;
    for leg in &quote_pending_legs {
        preserve_leg_keys.insert(leg.leg_key.clone());
    }
    stats.rows_projected += quote_pending_legs.len() as u64;
    upsert_silver_legs(&mut tx, &quote_pending_legs).await?;
    clear_projection_errors(&mut tx, &clear_error_source_event_ids).await?;
    upsert_projection_errors(&mut tx, account_id, &projection_errors).await?;

    let preserve_leg_keys = preserve_leg_keys.into_iter().collect::<Vec<_>>();
    stats.rows_deleted =
        delete_stale_silver_rows(&mut tx, account_id, recompute_from, &preserve_leg_keys).await?;

    // Every successful silver cycle must schedule gold validation. Even a
    // no-op cycle previously invalidated readiness when it became dirty.
    mark_gold_dirty_for_silver_change(&mut tx, account_id, Some(recompute_from)).await?;

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
