//! apalis task handlers — thin wrappers around the per-cycle functions the
//! old interval loops called. Each returns `Result<String, BoxDynError>` so
//! the board shows a human-readable outcome per run.

use std::sync::Arc;

use apalis::prelude::*;
use apalis_cron::Tick;
use tokio::sync::{Mutex, OnceCell};

use crate::AppState;

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

/// Backfills historical `token_prices` samples from DeFiLlama for the
/// (token, 5-minute bucket) pairs `balance_changes` rows need.
pub async fn token_price_backfill(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let backfill = crate::services::HistoricalPriceBackfill::new(
        state.http_client.clone(),
        state.env_vars.defillama_api_base_url.clone(),
        state.db_pool.clone(),
        Arc::clone(&state.token_price_service),
        state.defillama_limiter.clone(),
    );
    let summary = backfill.run().await?;
    Ok(summary.to_string())
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

/// Fills NULL `amount_in_usd`/`amount_out_usd` on public gold events.
pub async fn gold_public_usd_backfill(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let backfill = crate::services::GoldPublicUsdBackfill::new(
        state.db_pool.clone(),
        Arc::clone(&state.token_price_service),
    );
    Ok(backfill.run().await?.to_string())
}

/// Fills NULL `amount_in_usd`/`amount_out_usd` on confidential gold events.
pub async fn gold_confidential_usd_backfill(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let backfill = crate::services::GoldConfidentialUsdBackfill::new(
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

/// Public history bronze scheduler: Goldsky latest refresh enqueue + backfill seeding.
pub async fn public_history_scheduler(
    _t: Tick,
    state: Data<Arc<AppState>>,
) -> Result<String, BoxDynError> {
    let stats =
        crate::handlers::public_history::bronze::jobs::run_public_history_scheduler_cycle(&state)
            .await?;
    Ok(format!(
        "latest_enqueued={} backfill_enqueued={}",
        stats.latest_enqueued, stats.backfill_enqueued
    ))
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
    Ok(format!(
        "seen={} projected={} skipped_locked={} failed={} rows_projected={} rows_deleted={} errors={}",
        stats.accounts_seen,
        stats.accounts_projected,
        stats.accounts_skipped_locked,
        stats.accounts_failed,
        stats.rows_projected,
        stats.rows_deleted,
        stats.errors_written
    ))
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

/// Deletes finished apalis tasks older than `APALIS_TASK_RETENTION_DAYS`
/// (default 7) so high-frequency queues don't grow unbounded.
pub async fn apalis_prune(_t: Tick, state: Data<Arc<AppState>>) -> Result<String, BoxDynError> {
    // Clamp so a misconfigured (negative) value can't flip the cutoff into
    // the future and delete *every* finished task; cap at ~10y for sanity.
    let retention_days: i64 = std::env::var("APALIS_TASK_RETENTION_DAYS")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(7)
        .clamp(0, 3650);

    let result = sqlx::query(
        "DELETE FROM apalis.jobs
         WHERE status IN ('Done', 'Killed')
           AND done_at IS NOT NULL
           AND done_at < now() - make_interval(days => $1::int)",
    )
    .bind(retention_days)
    .execute(&state.db_pool)
    .await?;

    Ok(format!(
        "pruned {} finished tasks older than {retention_days} days",
        result.rows_affected()
    ))
}
