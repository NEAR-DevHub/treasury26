//! Staking pool observations: 90-day backfill plus daily capture.
//!
//! Rewards accrue every epoch with no transaction, so a historical staked
//! series can only come from reading pool state — live for today, archival
//! for the chart horizon (90 daily + 53 weekly boundaries). Readings are
//! stored in `bronze_balance_observations` (provenance; recomputes never
//! re-hit archival RPC) and applied as hidden `observation` ledger entries
//! on the synthetic `staking:{pool}` asset, which flow into the unified
//! table and charts. Boundaries whose archival block cannot be resolved or
//! fetched are skipped — coverage stays incomplete rather than fabricated,
//! and chart readiness waits for it.
//!
//! Rate limits, measured against the configured FastNear archival endpoint:
//! no throttling observed (10-parallel burst all-200); throughput is bounded
//! by ~0.8s round-trip latency. Backfill is ~143 calls per pool one-time,
//! then 1 call/pool/day — sequential reads with a small courtesy delay and a
//! per-cycle cap keep us far below any realistic ceiling.

use std::sync::Arc;

use bigdecimal::BigDecimal;
use chrono::{DateTime, Datelike, Duration, Utc};
use sqlx::PgPool;

use crate::AppState;
use crate::handlers::balance_changes::balance::staking::{
    get_staking_balance_at_exact_block, is_staking_pool,
};
use crate::handlers::public_history::bronze::store::is_public_history_backfill_complete;
use crate::services::public_balance_reader::validate_staking_pool_at_block;

const DAILY_HORIZON_DAYS: i64 = 90;
const WEEKLY_HORIZON_WEEKS: i64 = 53;
/// Observation entries sort after real movements but before verification
/// rebases inside a block.
const OBSERVATION_INTRA_BLOCK_SEQ: i32 = 900_000;
const NATIVE_DECIMALS: i32 = 24;
/// Bound on archival reads per cycle so one account cannot monopolize a
/// cycle; backfill continues next cycle.
const MAX_READS_PER_CYCLE: usize = 200;
/// Courtesy pacing between archival reads (limits measured far above this).
const READ_PACING: std::time::Duration = std::time::Duration::from_millis(100);

#[derive(Debug, Clone, Copy, Default)]
pub struct StakingObservationStats {
    pub pools_discovered: u64,
    pub pools_validated: u64,
    pub observations_written: u64,
    pub boundaries_skipped: u64,
    pub reads_failed: u64,
}

pub async fn run_staking_observation_cycle(
    state: &Arc<AppState>,
) -> Result<StakingObservationStats, sqlx::Error> {
    let mut stats = StakingObservationStats::default();

    let accounts: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT account_id
        FROM monitored_accounts
        WHERE enabled = true
          AND COALESCE(is_confidential_account, false) = false
        ORDER BY account_id
        "#,
    )
    .fetch_all(&state.db_pool)
    .await?;

    let mut reads_left = MAX_READS_PER_CYCLE;
    for account_id in accounts {
        if reads_left == 0 {
            break;
        }
        if !is_public_history_backfill_complete(&state.db_pool, &account_id).await? {
            continue;
        }
        stats.pools_discovered += discover_pools(&state.db_pool, &account_id).await?;
        observe_account(state, &account_id, &mut reads_left, &mut stats).await?;
    }
    Ok(stats)
}

/// Pools the account has ever function-called, filtered to the staking
/// naming scheme. Discovery is derived purely from bronze.
async fn discover_pools(pool: &PgPool, account_id: &str) -> Result<u64, sqlx::Error> {
    let candidates: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT DISTINCT contract_account_id
        FROM bronze_public_history_events
        WHERE account_id = $1
          AND source = 'nearblocks_receipt'::public_history_source
          AND contract_account_id IS NOT NULL
          AND (
              contract_account_id LIKE '%.poolv1.near'
              OR contract_account_id LIKE '%.pool.near'
          )
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;

    let mut inserted = 0;
    for candidate in candidates {
        if !is_staking_pool(&candidate) {
            continue;
        }
        inserted += sqlx::query(
            r#"
            INSERT INTO staking_observation_cursors (account_id, pool_account_id)
            VALUES ($1, $2)
            ON CONFLICT (account_id, pool_account_id) DO NOTHING
            "#,
        )
        .bind(account_id)
        .bind(&candidate)
        .execute(pool)
        .await?
        .rows_affected();
    }
    Ok(inserted)
}

async fn observe_account(
    state: &Arc<AppState>,
    account_id: &str,
    reads_left: &mut usize,
    stats: &mut StakingObservationStats,
) -> Result<(), sqlx::Error> {
    let cursors: Vec<(String, bool)> = sqlx::query_as(
        r#"
        SELECT pool_account_id, validated
        FROM staking_observation_cursors
        WHERE account_id = $1
        ORDER BY pool_account_id
        "#,
    )
    .bind(account_id)
    .fetch_all(&state.db_pool)
    .await?;

    for (pool_account_id, validated) in cursors {
        if *reads_left == 0 {
            return Ok(());
        }

        if !validated {
            let Some((_, head_height)) = latest_known_block(&state.db_pool).await? else {
                continue;
            };
            *reads_left = reads_left.saturating_sub(1);
            match validate_staking_pool_at_block(
                &state.archival_network,
                account_id,
                &pool_account_id,
                head_height as u64,
            )
            .await
            {
                Ok(true) => {
                    sqlx::query(
                        "UPDATE staking_observation_cursors
                         SET validated = true, updated_at = NOW()
                         WHERE account_id = $1 AND pool_account_id = $2",
                    )
                    .bind(account_id)
                    .bind(&pool_account_id)
                    .execute(&state.db_pool)
                    .await?;
                    stats.pools_validated += 1;
                }
                Ok(false) => continue,
                Err(error) => {
                    tracing::warn!(account_id, pool = pool_account_id, %error, "pool validation failed");
                    continue;
                }
            }
        }

        observe_pool(state, account_id, &pool_account_id, reads_left, stats).await?;
    }
    Ok(())
}

async fn observe_pool(
    state: &Arc<AppState>,
    account_id: &str,
    pool_account_id: &str,
    reads_left: &mut usize,
    stats: &mut StakingObservationStats,
) -> Result<(), sqlx::Error> {
    let asset = format!("staking:{pool_account_id}");
    let mut missing_boundaries = false;

    for boundary in chart_boundaries(Utc::now()) {
        if *reads_left == 0 {
            return Ok(());
        }
        // Covered boundaries are skipped before block resolution: steady
        // state must cost one covered-boundary probe each, not a block
        // interpolation query per boundary per cycle.
        let covered: bool = sqlx::query_scalar(
            "SELECT EXISTS (
                 SELECT 1 FROM bronze_staking_observations
                 WHERE account_id = $1 AND pool_account_id = $2 AND observed_at = $3
             )",
        )
        .bind(account_id)
        .bind(pool_account_id)
        .bind(boundary)
        .fetch_one(&state.db_pool)
        .await?;
        if covered {
            continue;
        }
        let Some(block_height) = resolve_block_at(&state.db_pool, boundary).await? else {
            stats.boundaries_skipped += 1;
            missing_boundaries = true;
            continue;
        };
        let observation_key = format!("staking:{account_id}:{pool_account_id}:{block_height}");
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM bronze_staking_observations WHERE observation_key = $1)",
        )
        .bind(&observation_key)
        .fetch_one(&state.db_pool)
        .await?;
        if exists {
            continue;
        }

        *reads_left = reads_left.saturating_sub(1);
        tokio::time::sleep(READ_PACING).await;
        let balance = match get_staking_balance_at_exact_block(
            &state.archival_network,
            account_id,
            pool_account_id,
            block_height as u64,
        )
        .await
        {
            Ok(balance) => balance,
            Err(error) => {
                stats.reads_failed += 1;
                missing_boundaries = true;
                tracing::warn!(
                    account_id,
                    pool = pool_account_id,
                    block_height,
                    %error,
                    "staking reading failed; boundary stays uncovered"
                );
                continue;
            }
        };

        apply_observation(
            state,
            account_id,
            pool_account_id,
            &asset,
            &observation_key,
            boundary,
            block_height,
            &balance,
        )
        .await?;
        stats.observations_written += 1;
    }

    // backfill_done is sticky: once the horizon has been covered, a
    // transient archival failure or an unresolvable fresh boundary must not
    // flip a verified chart back to Unavailable — new-boundary gaps are
    // retried next cycle and at worst read as a slightly stale tail.
    sqlx::query(
        r#"
        UPDATE staking_observation_cursors
        SET backfill_done = backfill_done OR $3,
            last_observed_at = (
                SELECT MAX(observed_at) FROM bronze_staking_observations
                WHERE account_id = $1 AND pool_account_id = $2
            ),
            updated_at = NOW()
        WHERE account_id = $1 AND pool_account_id = $2
        "#,
    )
    .bind(account_id)
    .bind(pool_account_id)
    .bind(!missing_boundaries)
    .execute(&state.db_pool)
    .await?;
    Ok(())
}

/// Store the reading (provenance) and rebuild the staking asset's ledger
/// entries in order. Ordered replay matters because backfill discovers OLD
/// boundaries after newer ones may already exist: deltas are recomputed from
/// the full per-asset observation series, not appended blindly.
#[allow(clippy::too_many_arguments)]
async fn apply_observation(
    state: &Arc<AppState>,
    account_id: &str,
    pool_account_id: &str,
    asset: &str,
    observation_key: &str,
    boundary: DateTime<Utc>,
    block_height: i64,
    balance: &BigDecimal,
) -> Result<(), sqlx::Error> {
    let mut tx = state.db_pool.begin().await?;

    sqlx::query(
        r#"
        INSERT INTO bronze_staking_observations (
            observation_key, account_id, pool_account_id, block_height, observed_at, balance
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (observation_key) DO NOTHING
        "#,
    )
    .bind(observation_key)
    .bind(account_id)
    .bind(pool_account_id)
    .bind(block_height)
    .bind(boundary)
    .bind(balance)
    .execute(&mut *tx)
    .await?;

    // Rebuild the whole staking series for this asset from provenance:
    // delete-then-insert in observation order, so out-of-order backfill
    // arrivals still produce correct running deltas.
    sqlx::query(
        "DELETE FROM silver_balance_history
         WHERE account_id = $1 AND asset = $2 AND entry_kind = 'observation'",
    )
    .bind(account_id)
    .bind(asset)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"
        INSERT INTO silver_balance_history (
            account_id, asset, token_standard, entry_kind, entry_key,
            source, source_event_id, receipt_id, transaction_hash,
            counterparty, block_height, block_time, intra_block_seq,
            delta_raw, delta, decimals, balance_before, balance_after,
            affects_user_balance, user_balance_after
        )
        SELECT
            o.account_id,
            'staking:' || o.pool_account_id,
            'native',
            'observation',
            'observation:' || o.account_id || ':staking:' || o.pool_account_id || ':' || o.block_height,
            NULL, NULL, NULL, NULL,
            o.pool_account_id, o.block_height, o.observed_at, $3,
            (o.balance - COALESCE(LAG(o.balance) OVER w, 0)) * POWER(10::numeric, $4),
            o.balance - COALESCE(LAG(o.balance) OVER w, 0),
            $4,
            COALESCE(LAG(o.balance) OVER w, 0),
            o.balance,
            TRUE,
            o.balance
        FROM bronze_staking_observations o
        WHERE o.account_id = $1 AND o.pool_account_id = $2
        WINDOW w AS (ORDER BY o.observed_at, o.block_height)
        "#,
    )
    .bind(account_id)
    .bind(pool_account_id)
    .bind(OBSERVATION_INTRA_BLOCK_SEQ)
    .bind(NATIVE_DECIMALS)
    .execute(&mut *tx)
    .await?;

    // Mirror into the unified table so charts see the series without waiting
    // for a gold projection cycle. Hidden rows cascade with their entries on
    // the delete above, so this re-inserts the full series. The epoch is the
    // "everything" sentinel: chrono's MIN_UTC is outside Postgres's
    // timestamptz range and fails the whole transaction.
    crate::handlers::public_history::gold::unified::sync_hidden_ledger_rows(
        &mut tx,
        account_id,
        DateTime::<Utc>::UNIX_EPOCH,
    )
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Daily boundaries for the last 90 days plus weekly (Monday) boundaries out
/// to 53 weeks, ascending and deduplicated.
fn chart_boundaries(now: DateTime<Utc>) -> Vec<DateTime<Utc>> {
    let today = now.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc();
    let mut boundaries = Vec::new();
    for weeks_back in (0..=WEEKLY_HORIZON_WEEKS).rev() {
        let day = today - Duration::weeks(weeks_back);
        let monday = day - Duration::days(day.weekday().num_days_from_monday() as i64);
        boundaries.push(monday);
    }
    for days_back in (0..=DAILY_HORIZON_DAYS).rev() {
        boundaries.push(today - Duration::days(days_back));
    }
    boundaries.sort();
    boundaries.dedup();
    boundaries
}

/// Deterministic block height at a boundary, interpolated between the
/// nearest bronze rows on either side. No surrounding coverage → no height →
/// the boundary is skipped, never guessed from wall-clock block times.
async fn resolve_block_at(
    pool: &PgPool,
    boundary: DateTime<Utc>,
) -> Result<Option<i64>, sqlx::Error> {
    let before: Option<(i64, DateTime<Utc>)> = sqlx::query_as(
        "SELECT block_height, block_time FROM bronze_public_history_events
         WHERE block_time <= $1 ORDER BY block_time DESC LIMIT 1",
    )
    .bind(boundary)
    .fetch_optional(pool)
    .await?;
    let after: Option<(i64, DateTime<Utc>)> = sqlx::query_as(
        "SELECT block_height, block_time FROM bronze_public_history_events
         WHERE block_time >= $1 ORDER BY block_time ASC LIMIT 1",
    )
    .bind(boundary)
    .fetch_optional(pool)
    .await?;

    Ok(match (before, after) {
        (Some((height_before, time_before)), Some((height_after, time_after))) => {
            if height_after <= height_before || time_after <= time_before {
                Some(height_before)
            } else {
                let span = (time_after - time_before).num_seconds().max(1);
                let offset = (boundary - time_before).num_seconds().clamp(0, span);
                Some(height_before + (height_after - height_before) * offset / span)
            }
        }
        _ => None,
    })
}

async fn latest_known_block(pool: &PgPool) -> Result<Option<(DateTime<Utc>, i64)>, sqlx::Error> {
    let row: Option<(i64, DateTime<Utc>)> = sqlx::query_as(
        "SELECT block_height, block_time FROM bronze_public_history_events
         ORDER BY block_height DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(height, time)| (time, height)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundaries_cover_daily_and_weekly_horizons() {
        let now = DateTime::parse_from_rfc3339("2026-07-30T15:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let boundaries = chart_boundaries(now);

        assert!(boundaries.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(
            *boundaries.last().unwrap(),
            DateTime::parse_from_rfc3339("2026-07-30T00:00:00Z").unwrap()
        );
        let oldest = *boundaries.first().unwrap();
        assert!(now - oldest >= Duration::weeks(WEEKLY_HORIZON_WEEKS));
        assert!(
            boundaries
                .iter()
                .filter(|b| now.signed_duration_since(**b) > Duration::days(91))
                .all(|b| b.weekday() == chrono::Weekday::Mon)
        );
    }
}
