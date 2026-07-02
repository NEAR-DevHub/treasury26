use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use futures::StreamExt;

use crate::AppState;
use crate::handlers::public_history::bronze::NearblocksPriority;
use crate::handlers::public_history::bronze::api::{
    NearblocksPage, fetch_ft_transfers, fetch_mt_transfers, fetch_receipts,
};
use crate::handlers::public_history::bronze::store::{
    PublicHistorySource, load_due_public_history_accounts, load_public_history_cursor,
    record_public_history_poll_result, save_public_backfill_progress,
    save_public_latest_page_cursor, upsert_public_history_events,
};
use crate::handlers::public_history::proposals::linker::link_public_proposal_receipts;

const PUBLIC_HISTORY_SCHEDULER_TICK: Duration = Duration::from_secs(10);
const PUBLIC_HISTORY_ACCOUNT_LIMIT: i64 = 20;
pub(crate) const PUBLIC_HISTORY_PAGE_LIMIT: u32 = 25;
const PUBLIC_HISTORY_WORKERS: usize = 2;

pub(crate) type HandlerResult<T> = Result<T, (StatusCode, String)>;

#[derive(Debug, Clone, Default)]
struct SourceCycleStats {
    accounts_seen: usize,
    accounts_processed: usize,
    accounts_failed: usize,
    rows_touched: u64,
    rows_inserted: u64,
    rows_changed: u64,
}

pub(crate) fn latest_seen(page: &NearblocksPage) -> (Option<i64>, Option<bigdecimal::BigDecimal>) {
    let height = page.events.iter().map(|event| event.block_height).max();
    let timestamp = page
        .events
        .iter()
        .max_by_key(|event| event.block_height)
        .map(|event| event.block_timestamp.clone());
    (height, timestamp)
}

pub(crate) async fn fetch_source_page(
    state: &AppState,
    account_id: &str,
    source: PublicHistorySource,
    cursor: Option<&str>,
    priority: NearblocksPriority,
) -> HandlerResult<NearblocksPage> {
    match source {
        PublicHistorySource::NearblocksFt => {
            fetch_ft_transfers(
                state,
                account_id,
                cursor,
                PUBLIC_HISTORY_PAGE_LIMIT,
                priority,
            )
            .await
        }
        PublicHistorySource::NearblocksMt => {
            fetch_mt_transfers(
                state,
                account_id,
                cursor,
                PUBLIC_HISTORY_PAGE_LIMIT,
                priority,
            )
            .await
        }
        PublicHistorySource::NearblocksReceipt => {
            fetch_receipts(
                state,
                account_id,
                cursor,
                PUBLIC_HISTORY_PAGE_LIMIT,
                priority,
            )
            .await
        }
    }
}

async fn poll_latest_page(
    state: &AppState,
    account_id: &str,
    source: PublicHistorySource,
) -> HandlerResult<(NearblocksPage, u64, u64, u64)> {
    let page =
        fetch_source_page(state, account_id, source, None, NearblocksPriority::Latest).await?;
    let upsert_result = upsert_public_history_events(&state.db_pool, &page.events)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("public bronze upsert failed: {}", e),
            )
        })?;

    if source == PublicHistorySource::NearblocksReceipt {
        link_public_proposal_receipts(state, &page.events).await?;
    }

    save_public_latest_page_cursor(
        &state.db_pool,
        account_id,
        source,
        page.next_cursor.as_deref(),
    )
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("public cursor save failed: {}", e),
        )
    })?;

    let (height, timestamp) = latest_seen(&page);
    let had_history_changes = upsert_result.rows_inserted > 0 || upsert_result.rows_changed > 0;
    record_public_history_poll_result(
        &state.db_pool,
        account_id,
        source,
        had_history_changes,
        height,
        timestamp.as_ref(),
    )
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("public poll schedule update failed: {}", e),
        )
    })?;

    Ok((
        page,
        upsert_result.rows_touched,
        upsert_result.rows_inserted,
        upsert_result.rows_changed,
    ))
}

async fn backfill_one_page(
    state: &AppState,
    account_id: &str,
    source: PublicHistorySource,
) -> HandlerResult<(u64, u64, u64)> {
    let cursor = load_public_history_cursor(&state.db_pool, account_id, source)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("public cursor load failed: {}", e),
            )
        })?;

    if cursor.as_ref().is_some_and(|cursor| cursor.backfill_done) {
        return Ok((0, 0, 0));
    }

    let backward_cursor = cursor
        .as_ref()
        .and_then(|cursor| cursor.backward_cursor.as_deref());
    let saved_backward_cursor = backward_cursor.map(ToString::to_string);
    let page = fetch_source_page(
        state,
        account_id,
        source,
        backward_cursor,
        NearblocksPriority::Backfill,
    )
    .await?;
    let upsert_result = upsert_public_history_events(&state.db_pool, &page.events)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("public backfill upsert failed: {}", e),
            )
        })?;

    if source == PublicHistorySource::NearblocksReceipt {
        link_public_proposal_receipts(state, &page.events).await?;
    }

    let initial_forward_cursor = if cursor.is_none() {
        page.next_cursor.as_deref()
    } else {
        None
    };
    let backfill_done = page.events.is_empty()
        || page.next_cursor.is_none()
        || page.next_cursor.as_deref() == saved_backward_cursor.as_deref();
    save_public_backfill_progress(
        &state.db_pool,
        account_id,
        source,
        page.next_cursor.as_deref(),
        initial_forward_cursor,
        backfill_done,
    )
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("public backfill cursor save failed: {}", e),
        )
    })?;

    Ok((
        upsert_result.rows_touched,
        upsert_result.rows_inserted,
        upsert_result.rows_changed,
    ))
}

async fn process_account_source(
    state: &AppState,
    account_id: String,
    source: PublicHistorySource,
) -> Result<(u64, u64, u64), String> {
    let (_page, latest_touched, latest_inserted, latest_changed) =
        poll_latest_page(state, &account_id, source)
            .await
            .map_err(|(status, message)| format!("latest poll failed ({}): {}", status, message))?;

    let (backfill_touched, backfill_inserted, backfill_changed) =
        backfill_one_page(state, &account_id, source)
            .await
            .map_err(|(status, message)| {
                format!(
                    "backfill failed after latest poll ({}): {}",
                    status, message
                )
            })?;

    Ok((
        latest_touched + backfill_touched,
        latest_inserted + backfill_inserted,
        latest_changed + backfill_changed,
    ))
}

async fn tick_public_history_source(
    state: &AppState,
    source: PublicHistorySource,
) -> SourceCycleStats {
    let account_ids = match load_due_public_history_accounts(
        &state.db_pool,
        source,
        PUBLIC_HISTORY_ACCOUNT_LIMIT,
    )
    .await
    {
        Ok(account_ids) => account_ids,
        Err(e) => {
            tracing::error!(source = %source, error = %e, "failed to load public history accounts");
            return SourceCycleStats::default();
        }
    };
    let accounts_seen = account_ids.len();
    let mut stream = futures::stream::iter(account_ids.into_iter().map(|account_id| async move {
        let result = process_account_source(state, account_id.clone(), source).await;
        (account_id, result)
    }))
    .buffer_unordered(PUBLIC_HISTORY_WORKERS);

    let mut stats = SourceCycleStats {
        accounts_seen,
        ..SourceCycleStats::default()
    };

    while let Some((account_id, result)) = stream.next().await {
        match result {
            Ok((touched, inserted, changed)) => {
                stats.accounts_processed += 1;
                stats.rows_touched += touched;
                stats.rows_inserted += inserted;
                stats.rows_changed += changed;
            }
            Err(error) => {
                stats.accounts_failed += 1;
                tracing::warn!(
                    source = %source,
                    account_id = account_id,
                    error = error,
                    "public history account source failed"
                );
            }
        }
    }

    stats
}

pub fn spawn_public_history_workers(state: Arc<AppState>) {
    tokio::spawn(async move {
        tracing::info!(
            "Starting public history bronze workers ({:?} scheduler tick)",
            PUBLIC_HISTORY_SCHEDULER_TICK
        );

        let mut timer = tokio::time::interval(PUBLIC_HISTORY_SCHEDULER_TICK);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            timer.tick().await;

            if state.env_vars.nearblocks_api_key.is_none() {
                tracing::warn!("public history bronze workers skipped: NEARBLOCKS_API_KEY missing");
                tokio::time::sleep(Duration::from_secs(60)).await;
                continue;
            }

            let started_at = Instant::now();
            for source in PublicHistorySource::all() {
                let stats = tick_public_history_source(&state, source).await;
                if stats.accounts_seen > 0 || stats.accounts_failed > 0 {
                    tracing::info!(
                        source = %source,
                        elapsed_secs = started_at.elapsed().as_secs_f64(),
                        accounts_seen = stats.accounts_seen,
                        accounts_processed = stats.accounts_processed,
                        accounts_failed = stats.accounts_failed,
                        rows_touched = stats.rows_touched,
                        rows_inserted = stats.rows_inserted,
                        rows_changed = stats.rows_changed,
                        "public history source cycle finished"
                    );
                }
            }
        }
    });
}
