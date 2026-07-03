//! Background sweeper that finishes half-created treasuries.
//!
//! When a creation attempt fails part-way (e.g. an RPC timeout after the DAO is
//! created but before confidential ownership handoff), its intent is left
//! `pending` in `incomplete_treasury_creations`. This worker claims stale pending
//! requests and re-runs the (idempotent, resumable) creation flow, so a user's
//! chosen treasury gets finished without them having to come back — even if
//! they closed the tab or the process restarted.
//!
//! It runs both on a periodic poll and immediately when a failing attempt wakes
//! it via [`AppState::creation_sweep_notify`], so recovery normally starts
//! within moments of a failure rather than at the next tick.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use crate::AppState;

use super::create::run_creation;
use super::creation_requests::{self, MAX_SWEEP_ATTEMPTS, SweepCandidate, claim_stale_pending};

/// How often to scan for resumable creations. Kept short so a failed attempt is
/// retried within seconds rather than minutes; the scan is a single indexed
/// query that usually returns nothing, so it's cheap to run often.
const INTERVAL_SECS: u64 = 15;
const INITIAL_DELAY_SECS: u64 = 15;
/// Per-attempt backoff for `pending` (failed) rows: eligible after
/// `LEAST(attempts * base, cap)` seconds of idleness. A freshly-failed row has
/// `attempts = 0`, so it's retried on the very next cycle (≈ interval);
/// repeated failures then back off up to the cap.
const BACKOFF_BASE_SECS: i32 = 30;
const BACKOFF_CAP_SECS: i32 = 300;
/// Reclaim an `in_progress` row only after it's been silent this long — long
/// enough that a live attempt is surely dead (crash/restart), so we never race
/// one that's still running.
const STALE_SECS: i32 = 300;
/// Max requests to process per cycle.
const BATCH_LIMIT: i32 = 10;

/// Spawn the treasury creation sweeper. Disabled via
/// `DISABLE_TREASURY_CREATION_SWEEPER=true`.
pub fn spawn_treasury_creation_sweeper(state: Arc<AppState>) {
    if env_flag("DISABLE_TREASURY_CREATION_SWEEPER") {
        tracing::info!(
            "Treasury creation sweeper disabled (DISABLE_TREASURY_CREATION_SWEEPER=true)"
        );
        return;
    }

    tokio::spawn(async move {
        tracing::info!(
            interval_secs = INTERVAL_SECS,
            initial_delay_secs = INITIAL_DELAY_SECS,
            backoff_base_secs = BACKOFF_BASE_SECS,
            backoff_cap_secs = BACKOFF_CAP_SECS,
            stale_secs = STALE_SECS,
            "Starting treasury creation sweeper"
        );
        tokio::time::sleep(Duration::from_secs(INITIAL_DELAY_SECS)).await;

        let notify = state.creation_sweep_notify.clone();
        let mut timer = tokio::time::interval(Duration::from_secs(INTERVAL_SECS));
        loop {
            // Run a cycle on the periodic tick OR as soon as a failed attempt
            // pings us — so a fresh failure is retried within moments, while the
            // poll stays as a fallback for crashed/abandoned creations.
            tokio::select! {
                _ = timer.tick() => {}
                _ = notify.notified() => {}
            }
            if let Err(e) = run_sweep_cycle(&state).await {
                tracing::error!("Treasury creation sweep cycle failed: {e}");
            }
        }
    });
}

async fn run_sweep_cycle(state: &Arc<AppState>) -> Result<(), sqlx::Error> {
    let candidates = claim_stale_pending(
        &state.db_pool,
        BACKOFF_BASE_SECS,
        BACKOFF_CAP_SECS,
        STALE_SECS,
        BATCH_LIMIT,
    )
    .await?;
    if candidates.is_empty() {
        return Ok(());
    }

    tracing::info!(
        "Treasury creation sweeper: resuming {} pending creation(s)",
        candidates.len()
    );

    for candidate in candidates {
        resume_one(state, candidate).await;
    }

    Ok(())
}

async fn resume_one(state: &Arc<AppState>, candidate: SweepCandidate) {
    let SweepCandidate { request, attempts } = candidate;
    let account = request.account_id.to_string();

    // run_creation streams progress; the sweeper has no client, so drain it.
    let (tx, mut rx) = mpsc::channel(32);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });

    let result = run_creation(state.clone(), request, tx).await;
    let _ = drain.await;

    match result {
        Ok(()) => {
            tracing::info!("Treasury creation sweeper: completed {account}");
        }
        Err(evt) => {
            let message = evt.message.unwrap_or_default();

            // Another attempt (live request or a parallel sweeper) holds the
            // advisory lock — not a failure, just try again next cycle.
            if message.contains("already in progress") {
                tracing::debug!("Treasury creation sweeper: {account} is busy, will retry");
                return;
            }

            // Terminal error (e.g. handle taken): run_creation already marked
            // the row `failed`. Don't warn/alert as a give-up or keep retrying.
            if super::create::is_terminal_creation_error(&message) {
                tracing::info!(
                    "Treasury creation sweeper: {account} is not resumable ({message}); marked failed"
                );
                return;
            }

            tracing::warn!(
                "Treasury creation sweeper: attempt {attempts}/{MAX_SWEEP_ATTEMPTS} for {account} failed: {message}"
            );

            if attempts >= MAX_SWEEP_ATTEMPTS {
                if let Err(e) =
                    creation_requests::mark_creation_failed(&state.db_pool, &account, &message)
                        .await
                {
                    tracing::warn!("Failed to mark creation failed for {account}: {e}");
                }
                let alert = format!(
                    "Treasury creation sweeper gave up on {account} after {MAX_SWEEP_ATTEMPTS} attempts. Last error: {message}"
                );
                if let Err(e) = state.telegram_client.send_message(&alert).await {
                    tracing::warn!("Failed to send sweeper give-up alert: {e}");
                }
            }
        }
    }
}

fn env_flag(key: &str) -> bool {
    std::env::var(key)
        .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
        .unwrap_or(false)
}
