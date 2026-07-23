//! apalis task handlers — thin wrappers around the per-cycle functions the
//! old interval loops called. Each returns `Result<String, BoxDynError>` so
//! the board shows a human-readable outcome per run.

use std::sync::Arc;

use apalis::prelude::*;
use apalis_cron::Tick;
use chrono::{DateTime, Utc};
use tokio::sync::{Mutex, OnceCell};

use crate::AppState;

const PUBLIC_HISTORY_DETECTOR_MAX_TICK_AGE_SECONDS: i64 = 60;

/// Converts a non-Send boxed error (several legacy cycles return
/// `Box<dyn Error>`) into an apalis-compatible one.
fn erase(e: impl std::fmt::Display) -> BoxDynError {
    e.to_string().into()
}

/// Processes dirty accounts up to the current chain head.
pub async fn account_maintenance(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    use near_api::Chain;

    let block = Chain::block()
        .fetch_from(&state.network)
        .await
        .map_err(erase)?;
    let up_to_block = block.header.height as i64;

    crate::handlers::balance_changes::account_monitor::run_maintenance_cycle(&state, up_to_block)
        .await
        .map_err(erase)?;
    Ok(format!("maintenance cycle done up to block {up_to_block}"))
}

/// Confidential treasuries: polls incoming deposits + solver fulfillments.
pub async fn confidential_poll(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    crate::handlers::balance_changes::confidential_monitor::run_confidential_poll_cycle(&state)
        .await
        .map_err(erase)?;
    Ok("confidential poll cycle done".to_string())
}

/// Syncs historical + current token prices from DeFiLlama.
pub async fn price_sync(_t: Tick, state: Data<Arc<AppState>>) -> Result<String, BoxDynError> {
    let provider = crate::services::DeFiLlamaClient::with_base_url(
        state.http_client.clone(),
        state.env_vars.defillama_api_base_url.clone(),
    );
    let summary = crate::services::run_price_sync_cycle(&state.db_pool, &provider).await?;
    Ok(summary)
}

/// Ordered gold USD enrichment:
/// 1. fetch missing historical price buckets into `token_prices`;
/// 2. fill NULL public USD amounts;
/// 3. fill NULL confidential USD amounts.
///
/// Each fill is attempted even if an earlier stage fails, so already-cached
/// prices still make progress. Any stage failures are returned together and
/// retried by the next cron tick.
pub async fn gold_usd_enrichment(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let mut outcomes = Vec::new();
    let mut errors = Vec::new();

    let backfill = crate::services::HistoricalPriceBackfill::new(
        state.http_client.clone(),
        state.env_vars.defillama_api_base_url.clone(),
        state.db_pool.clone(),
        Arc::clone(&state.token_price_service),
        state.defillama_limiter.clone(),
    );
    match backfill.run().await {
        Ok(summary) => outcomes.push(format!("prices=[{summary}]")),
        Err(error) => errors.push(format!("price loading failed: {error}")),
    }

    if state.env_vars.disable_gold_public_usd_backfill {
        outcomes.push("public=disabled".to_string());
    } else {
        let backfill = crate::services::GoldPublicUsdBackfill::new(
            state.db_pool.clone(),
            Arc::clone(&state.token_price_service),
        );
        match backfill.run().await {
            Ok(summary) => outcomes.push(format!("public=[{summary}]")),
            Err(error) => errors.push(format!("public USD fill failed: {error}")),
        }
    }

    if state.env_vars.disable_gold_confidential_usd_backfill {
        outcomes.push("confidential=disabled".to_string());
    } else {
        let backfill = crate::services::GoldConfidentialUsdBackfill::new(
            state.db_pool.clone(),
            Arc::clone(&state.token_price_service),
        );
        match backfill.run().await {
            Ok(summary) => outcomes.push(format!("confidential=[{summary}]")),
            Err(error) => errors.push(format!("confidential USD fill failed: {error}")),
        }
    }

    if errors.is_empty() {
        Ok(outcomes.join(" "))
    } else {
        Err(format!(
            "{}; completed stages: {}",
            errors.join("; "),
            outcomes.join(" ")
        )
        .into())
    }
}

/// Fills `balance_changes.usd_value` from the `token_prices` series.
pub async fn balance_changes_usd_backfill(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let backfill = crate::services::BalanceChangesUsdBackfill::new(
        state.db_pool.clone(),
        Arc::clone(&state.token_price_service),
    );
    Ok(backfill.run().await?.to_string())
}

/// Ingests the Chaindefuser token registry into `tokens` + `token_prices`.
pub async fn token_price_ingest(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    static INGESTOR: OnceCell<Mutex<crate::services::TokenPriceIngestor>> = OnceCell::const_new();

    let ingestor = INGESTOR
        .get_or_init(|| async {
            Mutex::new(crate::services::TokenPriceIngestor::new(
                state.http_client.clone(),
                state.db_pool.clone(),
                Arc::clone(&state.token_price_service),
            ))
        })
        .await;

    let mut ingestor = ingestor.lock().await;
    let summary = ingestor.tick_result().await?;

    if summary.upstream_unchanged {
        return Ok("tokens API unchanged".to_string());
    }

    Ok(format!(
        "tokens={} sampled={} price_rows={} snapshot_tokens={}",
        summary.tokens_seen,
        summary.sampled_prices,
        summary.price_rows_written,
        summary.snapshot_tokens
    ))
}

/// Confidential history (bronze) ingest scheduler tick.
pub async fn confidential_history_ingest(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let result =
        crate::handlers::intents::confidential::bronze::ingest_worker::tick_confidential_history_scheduler(
            &state, 100,
        )
        .await
        .map_err(|(status, msg)| -> BoxDynError { format!("{status}: {msg}").into() })?;
    Ok(format!(
        "seen={} processed={} failed={}",
        result.accounts_seen, result.accounts_processed, result.accounts_failed
    ))
}

fn public_history_tick_age_ms(tick: &Tick, now: DateTime<Utc>) -> i64 {
    (now - tick.get_timestamp()).num_milliseconds().max(0)
}

/// Latency-sensitive Goldsky detector. Old ticks carry no unique payload:
/// one current scan resumes from the durable cursor and covers all of them.
pub async fn public_history_scheduler(
    tick: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let tick_age_ms = public_history_tick_age_ms(&tick, Utc::now());
    if tick_age_ms > PUBLIC_HISTORY_DETECTOR_MAX_TICK_AGE_SECONDS * 1_000 {
        return Ok(format!("skipped_stale_tick age_ms={tick_age_ms}"));
    }

    let stats =
        crate::handlers::public_history::bronze::jobs::run_public_history_detector_cycle(&state)
            .await?;
    Ok(format!(
        "outcomes={} batches={} latest_enqueued={}",
        stats.outcomes_seen, stats.batches_processed, stats.latest_enqueued
    ))
}

/// Snapshot source-readiness scheduler. It deliberately runs outside the
/// Goldsky detector so finalized-block RPC and provider coverage work cannot
/// delay recent activity detection.
pub async fn public_history_readiness_scheduler(
    _tick: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let enqueued =
        crate::handlers::public_history::bronze::jobs::run_public_history_readiness_scheduler_cycle(
            &state,
        )
        .await?;
    Ok(format!("enqueued={enqueued}"))
}

/// Historical Bronze page scheduler. Backfill cursor scans are independent
/// from both the Goldsky cursor and the recent-activity detector.
pub async fn public_history_backfill_scheduler(
    _tick: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let enqueued =
        crate::handlers::public_history::bronze::jobs::run_public_history_backfill_scheduler_cycle(
            &state,
        )
        .await?;
    Ok(format!("enqueued={enqueued}"))
}

/// Public history silver projection for dirty accounts.
pub async fn public_silver_projection(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let stats =
        crate::handlers::public_history::silver::worker::project_public_silver_for_dirty_accounts(
            &state.db_pool,
        )
        .await?;
    // Silver only marks cursors dirty; the hourly sweeper batches every
    // change inside the window into one sparse refresh row.
    Ok(format!(
        "seen={} projected={} skipped_locked={} failed={} rows_projected={} rows_deleted={} errors={}",
        stats.accounts_seen,
        stats.accounts_projected,
        stats.accounts_skipped_locked,
        stats.accounts_failed,
        stats.rows_projected,
        stats.rows_deleted,
        stats.errors_written,
    ))
}

/// Hourly refresh driver: seeds cursors for newly monitored DAOs, then
/// enqueues one durable per-DAO payload for every buildable dirty cursor.
pub async fn public_balance_snapshot_sweeper(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let bootstrap =
        crate::handlers::public_history::snapshots::repository::bootstrap_public_balance_snapshot_cursors(
            &state.db_pool,
        )
        .await?;
    let enqueued = crate::handlers::public_history::snapshots::jobs::enqueue_dirty_snapshot_jobs(
        &state.db_pool,
    )
    .await?;
    Ok(format!(
        "bootstrapped={} enqueued={enqueued}",
        bootstrap.cursors_seeded
    ))
}

/// Staking rewards accrue without on-chain events from the account, so DAOs
/// holding staking assets are re-dirtied once per UTC day.
pub async fn public_balance_snapshot_staking_refresh(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let marked =
        crate::handlers::public_history::snapshots::repository::mark_staking_holdings_dirty(
            &state.db_pool,
        )
        .await?;
    let enqueued = crate::handlers::public_history::snapshots::jobs::enqueue_dirty_snapshot_jobs(
        &state.db_pool,
    )
    .await?;
    Ok(format!("marked={marked} enqueued={enqueued}"))
}

/// Price repair is deliberately generation-neutral: missing historical
/// prices never make an otherwise authoritative balance dataset unready.
pub async fn public_balance_snapshot_usd_repair(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let mut outcomes = Vec::new();
    let mut errors = Vec::new();

    let backfill = crate::services::HistoricalPriceBackfill::new(
        state.http_client.clone(),
        state.env_vars.defillama_api_base_url.clone(),
        state.db_pool.clone(),
        Arc::clone(&state.token_price_service),
        state.defillama_limiter.clone(),
    );
    match backfill.run().await {
        Ok(summary) => outcomes.push(format!(
            "prices_fetched={} prices=[{summary}]",
            summary.rows_inserted
        )),
        Err(error) => errors.push(format!("price loading failed: {error}")),
    }

    match crate::handlers::public_history::snapshots::worker::repair_missing_public_snapshot_usd_values(
        state.as_ref(),
    )
    .await
    {
        Ok(summary) => outcomes.push(format!("snapshots=[{summary}]")),
        Err(error) => errors.push(format!("snapshot USD repair failed: {error}")),
    }

    if errors.is_empty() {
        Ok(outcomes.join(" "))
    } else {
        Err(format!(
            "{}; completed stages: {}",
            errors.join("; "),
            outcomes.join(" ")
        )
        .into())
    }
}

/// Public history gold projection for dirty accounts.
pub async fn public_gold_projection(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let stats =
        crate::handlers::public_history::gold::projector::project_public_gold_for_dirty_accounts(
            &state.db_pool,
            &state.token_price_service,
            state.signer_id.as_str(),
        )
        .await?;
    let changed = stats.changed_accounts.len();
    for account_id in stats.changed_accounts {
        state.publish_treasury_projection_updated(account_id);
    }
    Ok(format!(
        "seen={} projected={} skipped_locked={} failed={} changed={} rows_projected={} rows_deleted={} errors={}",
        stats.accounts_seen,
        stats.accounts_projected,
        stats.accounts_skipped_locked,
        stats.accounts_failed,
        changed,
        stats.rows_projected,
        stats.rows_deleted,
        stats.errors_written
    ))
}

/// Reconciles stale public DAO proposal statuses.
pub async fn public_proposal_reconciliation(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let stats =
        crate::handlers::public_history::proposals::reconciler::reconcile_stale_proposals(&state)
            .await?;
    Ok(format!(
        "claimed={} updated={} fetch_failed={}",
        stats.claimed, stats.updated, stats.fetch_failed
    ))
}

/// Refreshes 1Click status for public quote proposals.
pub async fn public_quote_status_refresh(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let stats =
        crate::handlers::public_history::proposals::quote_refresher::refresh_public_quote_statuses(
            &state,
        )
        .await?;
    Ok(format!(
        "claimed={} updated={} fetch_failed={}",
        stats.claimed, stats.updated, stats.fetch_failed
    ))
}

/// Hourly confidential balance snapshots (gold).
pub async fn confidential_snapshots(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    crate::handlers::intents::confidential::gold::snapshots::tick_confidential_balance_snapshot_cron(
        &state,
    )
    .await;
    Ok("snapshot tick done".to_string())
}

/// Daily gold reconciliation (also pushed once at startup).
pub async fn confidential_gold_reconciliation(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    crate::handlers::intents::confidential::gold::reconciliation_worker::run_reconciliation_pass(
        &state,
        "scheduled",
    )
    .await;
    Ok("reconciliation pass done".to_string())
}

/// Queries the bulk payment contract and processes pending lists.
pub async fn bulk_payment_payout(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let processed =
        crate::handlers::bulkpayment::worker::query_and_process_pending_lists(&state).await?;
    Ok(format!("processed {processed} payment batches"))
}

/// Goldsky enrichment: drains full batches back-to-back within one task,
/// preserving the old adaptive behavior (no idle wait while backlogged).
pub async fn goldsky_enrichment(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    const BATCH_SIZE: usize = 100;

    let goldsky_pool = state
        .goldsky_pool
        .clone()
        .ok_or_else(|| -> BoxDynError { "goldsky pool not configured".into() })?;
    let intents_api_key = state.env_vars.intents_explorer_api_key.clone();
    let intents_api_url = state.env_vars.intents_explorer_api_url.clone();

    let mut total = 0usize;
    loop {
        let processed =
            match crate::handlers::balance_changes::goldsky_enrichment::run_enrichment_cycle(
                &goldsky_pool,
                &state.db_pool,
                &state.archival_network,
                intents_api_key.as_deref(),
                &intents_api_url,
                Some(&state),
            )
            .await
            {
                Ok(processed) => processed,
                Err(e) => {
                    // Batches already processed are committed (the cycle advances
                    // its cursor per batch), so log that progress and surface the
                    // failure — the next tick resumes from the cursor. The cycle's
                    // error is `Box<dyn Error>` (not Send+Sync), so it must be
                    // stringified via `erase` to cross into a task error.
                    tracing::warn!(
                        outcomes_this_task = total,
                        error = %e,
                        "goldsky enrichment failed mid-drain"
                    );
                    return Err(erase(e));
                }
            };
        total += processed;
        if processed < BATCH_SIZE {
            break;
        }
    }
    Ok(format!("processed {total} outcomes"))
}

/// Resumes half-created treasuries (poll fallback; failures also push a
/// task immediately via the creation Notify).
pub async fn treasury_creation_sweeper(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    crate::handlers::treasury::creation_sweeper::run_sweep_cycle(&state).await?;
    Ok("sweep cycle done".to_string())
}

/// Oh Dear health checks + fallback warnings.
pub async fn status_monitor(_t: Tick, state: Data<Arc<AppState>>) -> Result<String, BoxDynError> {
    crate::handlers::status::monitor::run_monitor_cycle(&state).await;
    Ok("status cycle done".to_string())
}

/// Event detection + Telegram dispatch, concurrently like the old loop.
/// Each half runs regardless of the other failing; failures are aggregated
/// so a bad Telegram token can't stall detection (or vice versa).
pub async fn notifications(_t: Tick, state: Data<Arc<AppState>>) -> Result<String, BoxDynError> {
    let (detected, dispatched) = tokio::join!(
        crate::handlers::notifications::detector::run_detection_cycle(&state.db_pool),
        crate::handlers::notifications::telegram_dispatcher::run_telegram_dispatch_cycle(
            &state,
            &state.telegram_client,
            &state.env_vars.frontend_base_url,
        ),
    );

    // On a one-sided failure, log the partial progress and return the
    // *original* error value (preserving its type/source chain for Sentry
    // grouping) rather than a flattened string.
    match (detected, dispatched) {
        (Ok(detected), Ok(dispatched)) => {
            Ok(format!("detected {detected}, dispatched {dispatched}"))
        }
        (Err(e), Ok(dispatched)) => {
            tracing::warn!(dispatched, "notifications: detection failed; dispatch ok");
            Err(e)
        }
        (Ok(detected), Err(e)) => {
            tracing::warn!(detected, "notifications: dispatch failed; detection ok");
            Err(e)
        }
        (Err(de), Err(pe)) => {
            tracing::warn!(dispatch_error = %pe, "notifications: detection and dispatch both failed");
            Err(de)
        }
    }
}

/// Low-balance ops alerts for sponsor accounts.
pub async fn sponsor_balance_monitor(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    crate::services::run_sponsor_monitor_cycle(&state, &state.telegram_client).await?;
    Ok("sponsor balance cycle done".to_string())
}

/// Fetches the DAO list from the sputnik factory.
pub async fn dao_list_sync(_t: Tick, state: Data<Arc<AppState>>) -> Result<String, BoxDynError> {
    let synced = crate::services::sync_dao_list(&state.db_pool, &state.network).await?;
    Ok(format!("synced {synced} DAOs"))
}

/// Processes dirty DAOs (member/policy extraction).
pub async fn dao_policy_dirty(_t: Tick, state: Data<Arc<AppState>>) -> Result<String, BoxDynError> {
    let processed = crate::services::process_dirty_daos(&state.db_pool, &state.network).await?;
    Ok(format!("processed {processed} dirty DAOs"))
}

/// Re-checks stale DAOs.
pub async fn dao_policy_stale(_t: Tick, state: Data<Arc<AppState>>) -> Result<String, BoxDynError> {
    let processed = crate::services::process_stale_daos(&state.db_pool, &state.network).await?;
    Ok(format!("processed {processed} stale DAOs"))
}

/// Monthly plan credit reset + export expiry (daily at UTC midnight, plus
/// a startup task). The steps are independent — both always run, failures
/// are aggregated.
pub async fn subscription_monthly_reset(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let reset = crate::handlers::subscription::reset_due_monthly_plan_credits(&state.db_pool).await;
    let expired = crate::handlers::subscription::expire_old_exports(&state.db_pool).await;

    match (reset, expired) {
        (Ok(reset), Ok(expired)) => {
            Ok(format!("reset {reset} accounts, expired {expired} exports"))
        }
        (Err(e), Ok(expired)) => {
            tracing::warn!(
                expired,
                "monthly reset: credit reset failed; export expiry ok"
            );
            Err(e.into())
        }
        (Ok(reset), Err(e)) => {
            tracing::warn!(
                reset,
                "monthly reset: export expiry failed; credit reset ok"
            );
            Err(e.into())
        }
        (Err(re), Err(ee)) => {
            tracing::warn!(export_error = %ee, "monthly reset: credit reset and export expiry both failed");
            Err(re.into())
        }
    }
}

/// Ensures the current week's public dashboard snapshot exists (weekly
/// Monday tick + startup task; skips when already generated).
pub async fn public_dashboard_refresh(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let summary = crate::services::ensure_this_week_public_dashboard_snapshot(&state).await?;
    Ok(match summary {
        Some(s) => format!("refreshed dashboard snapshot: {s:?}"),
        None => "snapshot already up to date".to_string(),
    })
}

/// FT lockup DAO schedule refresh + due claims. Claims run even when the
/// refresh fails (due claims from previously-synced schedules are still
/// valid); failures are aggregated.
pub async fn ft_lockup_refresh(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let refresh = crate::services::refresh_ft_lockup_dao_schedules(&state).await;
    let claims = crate::services::run_due_ft_lockup_claims(&state, None, false).await;

    match (refresh, claims) {
        (Ok(refresh), Ok(claims)) => Ok(format!("refresh: {refresh:?}; claims: {claims:?}")),
        (Err(e), Ok(claims)) => {
            tracing::warn!(?claims, "ft-lockup: schedule refresh failed; claims ok");
            Err(e)
        }
        (Ok(refresh), Err(e)) => {
            tracing::warn!(?refresh, "ft-lockup: claims failed; refresh ok");
            Err(e)
        }
        (Err(re), Err(ce)) => {
            tracing::warn!(claims_error = %ce, "ft-lockup: refresh and claims both failed");
            Err(re)
        }
    }
}

/// Prunes terminal apalis tasks so the high-frequency queues (~1M rows/day)
/// don't bloat the `apalis.jobs` table — which slows every poll/keep-alive
/// query and the board UI.
///
/// Retention is in **hours** (`APALIS_TASK_RETENTION_HOURS`, default 48),
/// falling back to `APALIS_TASK_RETENTION_DAYS × 24` if only the old day-based
/// var is set. Deletes `Done`/`Killed` **and** exhausted `Failed`
/// (`attempts >= max_attempts`) rows — the latter are terminal too and were
/// never cleaned before, so they accumulated. Retryable `Failed` rows
/// (`attempts < max_attempts`) and any Pending/Queued/Running task are left
/// untouched. Runs in bounded batches so a large backlog can't hold a long
/// lock on the table the workers are actively polling.
pub async fn apalis_prune(_t: Tick, state: Data<Arc<AppState>>) -> Result<String, BoxDynError> {
    // Clamp so a misconfigured (negative) value can't flip the cutoff into the
    // future and delete *every* terminal task; cap at ~10y for sanity.
    let retention_hours: i64 = std::env::var("APALIS_TASK_RETENTION_HOURS")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .or_else(|| {
            std::env::var("APALIS_TASK_RETENTION_DAYS")
                .ok()
                .and_then(|s| s.parse::<i64>().ok())
                .map(|days| days.saturating_mul(24))
        })
        .unwrap_or(48)
        .clamp(0, 3650 * 24);

    // Reclaim tasks stuck in `Running` well past the handler timeout. apalis's
    // own orphan-reclaim only fires when the *worker's* heartbeat is stale, so a
    // task whose ack never landed (e.g. the handler hit `job_timeout` during DB
    // instability, or the ack UPDATE failed) is left `Running` forever while the
    // worker stays alive — these phantom rows accumulate (one per timeout) and
    // are never reclaimed or pruned. The threshold is at least 2× `job_timeout`,
    // so a genuinely-running task (bounded by `job_timeout`) is never touched.
    // Reclaimed rows become `Killed` (terminal, not retried) and are then
    // removed by the retention sweep below once they age out.
    let reclaim_secs: i64 = std::env::var("APALIS_STUCK_RUNNING_RECLAIM_SECONDS")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(3600)
        .max((crate::jobs::job_timeout().as_secs() as i64).saturating_mul(2));
    let reclaimed = sqlx::query(
        r#"UPDATE apalis.jobs
           SET status = 'Killed',
               done_at = NOW(),
               last_result = '{"Err": "Reclaimed: stuck in Running past threshold (ack likely failed)"}'::jsonb
           WHERE status = 'Running'
             AND lock_at IS NOT NULL
             AND lock_at < now() - make_interval(secs => $1::double precision)"#,
    )
    .bind(reclaim_secs)
    .execute(&state.db_pool)
    .await?;
    let reclaimed = reclaimed.rows_affected();
    if reclaimed > 0 {
        tracing::warn!(
            reclaimed,
            reclaim_secs,
            "reclaimed apalis tasks stuck in Running (orphaned locks)"
        );
    }

    const BATCH_SIZE: i64 = 10_000;
    // Backstop against a runaway loop; 100 batches = up to 1M rows per run.
    const MAX_BATCHES: usize = 100;

    let mut total: u64 = 0;
    for _ in 0..MAX_BATCHES {
        let result = sqlx::query(
            "DELETE FROM apalis.jobs
             WHERE id IN (
                 SELECT id FROM apalis.jobs
                 WHERE done_at IS NOT NULL
                   AND done_at < now() - make_interval(hours => $1::int)
                   AND (
                       status IN ('Done', 'Killed')
                       OR (status = 'Failed' AND attempts >= max_attempts)
                   )
                 LIMIT $2
             )",
        )
        .bind(retention_hours)
        .bind(BATCH_SIZE)
        .execute(&state.db_pool)
        .await?;

        let deleted = result.rows_affected();
        total += deleted;
        if (deleted as i64) < BATCH_SIZE {
            break;
        }
    }

    // Reclaim the space the deletes (and the churn) leave behind and refresh the
    // visibility map + stats. Without this the table keeps hundreds of MB of
    // dead tuples behind a small live set, and the board's full-table aggregate
    // queries scan all of it. Plain `VACUUM` (not `FULL`) takes only a
    // SHARE UPDATE EXCLUSIVE lock, so workers keep polling; it can't run inside
    // a transaction, so it goes out on a pooled connection in autocommit. A
    // failure here shouldn't fail the prune.
    if let Err(e) = sqlx::query("VACUUM (ANALYZE) apalis.jobs")
        .execute(&state.db_pool)
        .await
    {
        tracing::warn!(error = %e, "VACUUM apalis.jobs after prune failed");
    }

    Ok(format!(
        "reclaimed {reclaimed} stuck-Running, pruned {total} terminal tasks older than {retention_hours}h"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_history_tick_age_is_never_negative() {
        let now = Utc::now();
        assert_eq!(
            public_history_tick_age_ms(&Tick::new(now + chrono::Duration::seconds(1)), now),
            0
        );
    }

    #[test]
    fn public_history_tick_age_identifies_stale_ticks() {
        let now = Utc::now();
        let age_ms =
            public_history_tick_age_ms(&Tick::new(now - chrono::Duration::seconds(11)), now);
        assert!(age_ms > PUBLIC_HISTORY_DETECTOR_MAX_TICK_AGE_SECONDS * 1_000);
    }
}
