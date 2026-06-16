use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt;
use near_account_id::AccountIdRef;
use reqwest::StatusCode;

use crate::AppState;
use crate::handlers::intents::confidential::bronze::api::{HistoryEvent, fetch_history};
use crate::handlers::intents::confidential::bronze::store::{
    HistoryEventUpsertOutcome, HistoryEventUpsertState, load_due_confidential_history_accounts,
    load_history_cursor, mark_confidential_history_activity_due, mark_history_backfill_done,
    record_confidential_history_poll_result, save_backfill_progress, save_latest_page_cursor,
    upsert_history_events,
};
use crate::handlers::intents::confidential::gold::history_events::{
    CONFIDENTIAL_GOLD_RECONCILIATION_WORKERS, classify_is_deposit,
    confidential_deposit_corrections_enabled, project_confidential_gold_for_dao,
    project_confidential_gold_for_dirty_daos,
};
use crate::handlers::intents::confidential::gold::snapshots::snapshot_confidential_dao_balances;
use crate::handlers::intents::confidential::gold::{
    ConfidentialDepositCorrector, InsertedConfidentialDeposit,
};
use crate::handlers::intents::confidential::types::HistoryStatus;

pub const CONFIDENTIAL_HISTORY_SCHEDULER_TICK: Duration = Duration::from_secs(10);
pub const CONFIDENTIAL_HISTORY_TRIGGER_LIMIT: u32 = 50;
const CONFIDENTIAL_HISTORY_DUE_ACCOUNT_LIMIT: i64 = 100;
const DEFAULT_CONFIDENTIAL_HISTORY_ACCOUNT_WORKERS: usize = 4;

/// Defensive cap: the drain loop trusts the 1Click `prev_cursor` to eventually
/// signal `backfill_done`; if the upstream API gets stuck returning a
/// repeating cursor we bail rather than spin forever.
const MAX_BACKFILL_DRAIN_PAGES: usize = 1024;

type HandlerResult<T> = Result<T, (StatusCode, String)>;

fn confidential_history_account_workers() -> usize {
    std::env::var("CONFIDENTIAL_HISTORY_ACCOUNT_WORKERS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(DEFAULT_CONFIDENTIAL_HISTORY_ACCOUNT_WORKERS)
        .max(1)
}

fn internal_err(
    log_tag: &'static str,
    op: &'static str,
    account_id: &str,
    e: impl std::fmt::Display,
) -> (StatusCode, String) {
    tracing::error!(
        log_tag = log_tag,
        account_id = account_id,
        op = op,
        error = %e,
        "confidential history operation failed"
    );
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("{} failed: {}", op, e),
    )
}

#[derive(Debug, Clone)]
pub struct HistoryPollResult {
    pub account_id: String,
    pub items_fetched: usize,
    pub rows_touched: u64,
    pub had_history_changes: bool,
    pub next_cursor: Option<String>,
    pub prev_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackfillMode {
    /// One page per call — used by the periodic scheduler to bound 1Click load.
    OnePage,
    /// Loop until `backfill_done` — used by the immediate-refresh path.
    Drain,
}

#[derive(Debug, Clone)]
pub struct HistoryBackfillResult {
    pub account_id: String,
    pub pages_fetched: usize,
    pub items_fetched: usize,
    pub rows_touched: u64,
    pub prev_cursor: Option<String>,
    pub backfill_done: bool,
}

#[derive(Debug, Clone)]
pub struct HistoryCycleAccountResult {
    pub account_id: String,
    pub forward: Option<HistoryPollResult>,
    pub backfill: Option<HistoryBackfillResult>,
    pub error: Option<String>,
}

impl HistoryCycleAccountResult {
    fn failed(account_id: String, error: impl Into<String>) -> Self {
        Self {
            account_id,
            forward: None,
            backfill: None,
            error: Some(error.into()),
        }
    }

    fn failed_after_forward(
        account_id: String,
        forward: HistoryPollResult,
        error: impl Into<String>,
    ) -> Self {
        Self {
            account_id,
            forward: Some(forward),
            backfill: None,
            error: Some(error.into()),
        }
    }

    fn succeeded(
        account_id: String,
        forward: HistoryPollResult,
        backfill: Option<HistoryBackfillResult>,
    ) -> Self {
        Self {
            account_id,
            forward: Some(forward),
            backfill,
            error: None,
        }
    }

    fn forward_items(&self) -> usize {
        self.forward.as_ref().map_or(0, |f| f.items_fetched)
    }

    fn backfill_items(&self) -> usize {
        self.backfill.as_ref().map_or(0, |b| b.items_fetched)
    }
}

#[derive(Debug, Clone)]
pub struct HistoryCycleResult {
    pub accounts_seen: usize,
    pub accounts_processed: usize,
    pub accounts_failed: usize,
    pub forward_items_fetched: usize,
    pub forward_rows_touched: u64,
    pub backfill_items_fetched: usize,
    pub backfill_rows_touched: u64,
    pub accounts: Vec<HistoryCycleAccountResult>,
}

pub async fn poll_confidential_history_once(
    state: &AppState,
    account_id: &AccountIdRef,
    limit: u32,
) -> HandlerResult<HistoryPollResult> {
    tracing::debug!("{} latest page poll limit={}", account_id, limit);

    let page = fetch_history(state, account_id, limit, None, None).await?;

    let upsert_result = upsert_history_events(&state.db_pool, account_id.as_str(), &page.items)
        .await
        .map_err(|e| {
            internal_err(
                "confidential-history",
                "history Bronze upsert",
                account_id.as_str(),
                e,
            )
        })?;
    let rows_touched = upsert_result.rows_touched;
    let had_history_changes = upsert_result.rows_inserted > 0 || upsert_result.rows_changed > 0;

    save_latest_page_cursor(
        &state.db_pool,
        account_id.as_str(),
        page.next_cursor.as_deref(),
    )
    .await
    .map_err(|e| {
        internal_err(
            "confidential-history",
            "history cursor save",
            account_id.as_str(),
            e,
        )
    })?;

    // Forward deposit-amount correction: the 1Click history API reports the
    // ~0.001 quote nominal, so for newly-successful external deposits we
    // record the real quantity from a live balance fetch. Best-effort — a
    // failure here is recovered by the daily backfill reconciliation.
    if confidential_deposit_corrections_enabled() {
        let inserted_deposits =
            collect_successful_deposit_candidates(account_id, &page.items, &upsert_result.events);
        if !inserted_deposits.is_empty()
            && let Err(e) = ConfidentialDepositCorrector::correct_new_deposits(
                state,
                account_id,
                &inserted_deposits,
            )
            .await
        {
            tracing::warn!("{} forward deposit correction failed: {}", account_id, e);
        }
    }

    Ok(HistoryPollResult {
        account_id: account_id.as_str().to_string(),
        items_fetched: page.items.len(),
        rows_touched,
        had_history_changes,
        next_cursor: page.next_cursor,
        prev_cursor: page.prev_cursor,
    })
}

/// Pick deposits that just became successful in a poll, pairing each page item
/// with its upsert outcome (pushed in the same order). Rows can first be
/// inserted before final settlement and later change to `SUCCESS`; both cases
/// need the forward correction.
fn collect_successful_deposit_candidates(
    account_id: &AccountIdRef,
    items: &[HistoryEvent],
    outcomes: &[HistoryEventUpsertOutcome],
) -> Vec<InsertedConfidentialDeposit> {
    items
        .iter()
        .zip(outcomes)
        .filter_map(|(event, outcome)| {
            if !matches!(
                outcome.state,
                HistoryEventUpsertState::Inserted | HistoryEventUpsertState::Changed
            ) {
                return None;
            }
            let item = &event.item;
            if HistoryStatus::parse(&item.status) != HistoryStatus::Success {
                return None;
            }
            if !classify_is_deposit(
                account_id.as_str(),
                item.recipient.as_deref()?,
                item.origin_asset.as_deref(),
                &item.destination_asset,
            ) {
                return None;
            }
            Some(InsertedConfidentialDeposit {
                history_event_id: outcome.history_event_id,
                destination_asset: item.destination_asset.clone(),
                created_at_external: outcome.created_at_external,
            })
        })
        .collect()
}

async fn poll_and_record_history(
    state: &AppState,
    account_id: &AccountIdRef,
    limit: u32,
) -> HandlerResult<HistoryPollResult> {
    let result = poll_confidential_history_once(state, account_id, limit).await?;
    record_confidential_history_poll_result(
        &state.db_pool,
        account_id.as_str(),
        result.had_history_changes,
    )
    .await
    .map_err(|e| {
        internal_err(
            "confidential-history",
            "history poll scheduling update",
            account_id.as_str(),
            e,
        )
    })?;
    Ok(result)
}

/// `pages_fetched = 0` signals the no-op path (cursor already marked
/// `backfill_done`); `1` means one 1Click page was actually fetched.
async fn backfill_one_page(
    state: &AppState,
    account_id: &AccountIdRef,
    limit: u32,
) -> HandlerResult<HistoryBackfillResult> {
    let cursor = load_history_cursor(&state.db_pool, account_id.as_str())
        .await
        .map_err(|e| {
            internal_err(
                "confidential-history-backfill",
                "history cursor load",
                account_id.as_str(),
                e,
            )
        })?;

    if matches!(cursor.as_ref().map(|c| c.backfill_done), Some(true)) {
        return Ok(HistoryBackfillResult {
            account_id: account_id.as_str().to_string(),
            pages_fetched: 0,
            items_fetched: 0,
            rows_touched: 0,
            prev_cursor: cursor.and_then(|c| c.backward_cursor),
            backfill_done: true,
        });
    }

    let backward_cursor = cursor.as_ref().and_then(|c| c.backward_cursor.as_deref());
    let saved_backward_cursor = backward_cursor.map(ToString::to_string);
    let page = fetch_history(state, account_id, limit, None, backward_cursor).await?;

    let upsert_result = upsert_history_events(&state.db_pool, account_id.as_str(), &page.items)
        .await
        .map_err(|e| {
            internal_err(
                "confidential-history-backfill",
                "history Bronze upsert",
                account_id.as_str(),
                e,
            )
        })?;
    let rows_touched = upsert_result.rows_touched;

    // Only seed forward_cursor on the very first backfill page for this DAO.
    let initial_forward_cursor = if cursor.is_none() {
        page.next_cursor.as_deref()
    } else {
        None
    };

    save_backfill_progress(
        &state.db_pool,
        account_id.as_str(),
        page.prev_cursor.as_deref(),
        initial_forward_cursor,
    )
    .await
    .map_err(|e| {
        internal_err(
            "confidential-history-backfill",
            "history cursor save",
            account_id.as_str(),
            e,
        )
    })?;

    let backfill_done = page.items.is_empty()
        || page.prev_cursor.is_none()
        || page.prev_cursor.as_deref() == saved_backward_cursor.as_deref();
    if backfill_done {
        mark_history_backfill_done(&state.db_pool, account_id.as_str())
            .await
            .map_err(|e| {
                internal_err(
                    "confidential-history-backfill",
                    "history backfill mark done",
                    account_id.as_str(),
                    e,
                )
            })?;
    }

    Ok(HistoryBackfillResult {
        account_id: account_id.as_str().to_string(),
        pages_fetched: 1,
        items_fetched: page.items.len(),
        rows_touched,
        prev_cursor: page.prev_cursor,
        backfill_done,
    })
}

pub async fn backfill_confidential_history(
    state: &AppState,
    account_id: &AccountIdRef,
    limit: u32,
    mode: BackfillMode,
) -> HandlerResult<HistoryBackfillResult> {
    let mut aggregate = HistoryBackfillResult {
        account_id: account_id.as_str().to_string(),
        pages_fetched: 0,
        items_fetched: 0,
        rows_touched: 0,
        prev_cursor: None,
        backfill_done: false,
    };

    for _ in 0..MAX_BACKFILL_DRAIN_PAGES {
        let page = backfill_one_page(state, account_id, limit).await?;
        aggregate.pages_fetched += page.pages_fetched;
        aggregate.items_fetched += page.items_fetched;
        aggregate.rows_touched += page.rows_touched;
        aggregate.prev_cursor = page.prev_cursor;
        aggregate.backfill_done = page.backfill_done;

        if page.backfill_done || mode == BackfillMode::OnePage {
            return Ok(aggregate);
        }
    }

    tracing::warn!(
        "{} drain loop hit cap of {} pages without completion",
        account_id,
        MAX_BACKFILL_DRAIN_PAGES
    );
    Ok(aggregate)
}

/// Latest-page poll + full backfill drain for one DAO. Used by the immediate
/// refresh path; the scheduler uses `tick_confidential_history_scheduler`
/// which only advances one backfill page per due DAO.
pub async fn run_account_history_full_drain(
    state: &AppState,
    account_id: &AccountIdRef,
    limit: u32,
) -> HandlerResult<HistoryCycleAccountResult> {
    let forward = poll_and_record_history(state, account_id, limit).await?;
    let backfill =
        backfill_confidential_history(state, account_id, limit, BackfillMode::Drain).await?;
    Ok(HistoryCycleAccountResult::succeeded(
        account_id.as_str().to_string(),
        forward,
        Some(backfill),
    ))
}

/// Marks the DAO as active, drains its history, then projects Gold. Used
/// after v1.signer submits and after goldsky observes a settled swap.
pub async fn trigger_confidential_history_refresh(state: &AppState, account_id: &str) {
    let account_ref = match AccountIdRef::new(account_id) {
        Ok(account_ref) => account_ref,
        Err(e) => {
            tracing::warn!("cannot refresh invalid account {}: {}", account_id, e);
            return;
        }
    };

    if let Err(e) = mark_confidential_history_activity_due(&state.db_pool, account_id).await {
        tracing::warn!("cannot mark activity due for {}: {}", account_id, e);
    }

    match run_account_history_full_drain(state, account_ref, CONFIDENTIAL_HISTORY_TRIGGER_LIMIT)
        .await
    {
        Ok(result) => {
            tracing::info!(
                "{} forward_items={} backfill_items={}",
                account_id,
                result.forward_items(),
                result.backfill_items()
            );

            match project_confidential_gold_for_dao(&state.db_pool, account_id).await {
                Ok(stats) => {
                    let prefix = if stats.skipped_locked {
                        "skipped locked "
                    } else {
                        ""
                    };
                    tracing::info!(
                        "gold projection {}dao={} rows={} deleted={} errors={}",
                        prefix,
                        account_id,
                        stats.rows_projected,
                        stats.rows_deleted,
                        stats.errors_written
                    );
                }
                Err(e) => {
                    tracing::warn!("gold projection failed for {}: {}", account_id, e);
                }
            }

            snapshot_confidential_dao_balances(state, account_id).await;
        }
        Err((status, message)) => {
            tracing::warn!(
                "refresh failed for {} ({}): {}",
                account_id,
                status,
                message
            );
        }
    }
}

async fn process_confidential_history_account(
    state: &AppState,
    account_id: String,
    limit: u32,
) -> HistoryCycleAccountResult {
    let account_ref = match AccountIdRef::new(&account_id) {
        Ok(account_ref) => account_ref,
        Err(e) => {
            let error = format!("invalid account id: {}", e);
            tracing::warn!("{}: {}", account_id, error);
            return HistoryCycleAccountResult::failed(account_id, error);
        }
    };

    let forward = match poll_and_record_history(state, account_ref, limit).await {
        Ok(forward) => forward,
        Err((status, message)) => {
            let error = format!("forward poll failed ({}): {}", status, message);
            tracing::warn!("{}: {}", account_id, error);
            return HistoryCycleAccountResult::failed(account_id, error);
        }
    };

    if forward.had_history_changes {
        snapshot_confidential_dao_balances(state, account_ref.as_str()).await;
    }

    let backfill =
        match backfill_confidential_history(state, account_ref, limit, BackfillMode::OnePage).await
        {
            Ok(backfill) => backfill,
            Err((status, message)) => {
                let error = format!("backfill failed ({}): {}", status, message);
                tracing::warn!("{}: {}", account_id, error);
                return HistoryCycleAccountResult::failed_after_forward(account_id, forward, error);
            }
        };

    HistoryCycleAccountResult::succeeded(account_id, forward, Some(backfill))
}

fn aggregate_history_account_results(
    accounts_seen: usize,
    mut accounts: Vec<HistoryCycleAccountResult>,
) -> HistoryCycleResult {
    accounts.sort_by(|a, b| a.account_id.cmp(&b.account_id));

    let mut result = HistoryCycleResult {
        accounts_seen,
        accounts_processed: 0,
        accounts_failed: 0,
        forward_items_fetched: 0,
        forward_rows_touched: 0,
        backfill_items_fetched: 0,
        backfill_rows_touched: 0,
        accounts: Vec::with_capacity(accounts.len()),
    };

    for account in accounts {
        if let Some(forward) = account.forward.as_ref() {
            result.accounts_processed += 1;
            result.forward_items_fetched += forward.items_fetched;
            result.forward_rows_touched += forward.rows_touched;
        }

        if let Some(backfill) = account.backfill.as_ref() {
            result.backfill_items_fetched += backfill.items_fetched;
            result.backfill_rows_touched += backfill.rows_touched;
        }

        if account.error.is_some() {
            result.accounts_failed += 1;
        }

        result.accounts.push(account);
    }

    result
}

/// One periodic scheduler tick: poll the due DAOs (capped by
/// `CONFIDENTIAL_HISTORY_DUE_ACCOUNT_LIMIT`), advance at most one backfill page
/// per DAO, then project Gold for every dirty DAO.
pub async fn tick_confidential_history_scheduler(
    state: &AppState,
    limit: u32,
) -> HandlerResult<HistoryCycleResult> {
    let account_ids = load_due_confidential_history_accounts(
        &state.db_pool,
        CONFIDENTIAL_HISTORY_DUE_ACCOUNT_LIMIT,
    )
    .await
    .map_err(|e| {
        tracing::error!("due account load failed: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("due history account load failed: {}", e),
        )
    })?;

    let accounts_seen = account_ids.len();
    let worker_limit = confidential_history_account_workers();
    if accounts_seen > 0 {
        tracing::info!(
            "processing {} due accounts with {} workers",
            accounts_seen,
            worker_limit
        );
    }

    let mut stream = futures::stream::iter(account_ids.into_iter().map(|account_id| async move {
        process_confidential_history_account(state, account_id, limit).await
    }))
    .buffer_unordered(worker_limit);

    let mut accounts = Vec::with_capacity(accounts_seen);
    while let Some(account) = stream.next().await {
        accounts.push(account);
    }

    let result = aggregate_history_account_results(accounts_seen, accounts);

    match project_confidential_gold_for_dirty_daos(
        &state.db_pool,
        CONFIDENTIAL_GOLD_RECONCILIATION_WORKERS,
    )
    .await
    {
        Ok(stats) if stats.accounts_seen > 0 => {
            tracing::info!(
                "gold projection seen={} projected={} locked={} failed={} rows={} deleted={} errors={}",
                stats.accounts_seen,
                stats.accounts_projected,
                stats.accounts_skipped_locked,
                stats.accounts_failed,
                stats.rows_projected,
                stats.rows_deleted,
                stats.errors_written
            );
        }
        Ok(_) => {}
        Err(e) => {
            tracing::error!("gold projection failed after Bronze cycle: {}", e);
        }
    }

    Ok(result)
}

/// Bronze 1Click history ingest worker.
pub struct BronzeIngestWorker;

impl BronzeIngestWorker {
    pub fn spawn(state: Arc<AppState>) {
        spawn_confidential_history_worker(state);
    }
}

/// Background worker: periodically ticks the confidential history scheduler.
pub fn spawn_confidential_history_worker(state: Arc<AppState>) {
    tokio::spawn(async move {
        tracing::info!(
            "Starting confidential history worker ({:?} scheduler tick)",
            CONFIDENTIAL_HISTORY_SCHEDULER_TICK
        );

        let mut timer = tokio::time::interval(CONFIDENTIAL_HISTORY_SCHEDULER_TICK);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            timer.tick().await;
            let started_at = Instant::now();
            match tick_confidential_history_scheduler(&state, 100).await {
                Ok(result) => {
                    tracing::info!(
                        "cycle finished in {:.2}s accounts_seen={} processed={} failed={}",
                        started_at.elapsed().as_secs_f64(),
                        result.accounts_seen,
                        result.accounts_processed,
                        result.accounts_failed
                    );
                }
                Err(e) => {
                    tracing::error!(
                        "cycle failed in {:.2}s: {}",
                        started_at.elapsed().as_secs_f64(),
                        e.1
                    );
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::handlers::intents::confidential::bronze::store::{
        load_confidential_history_accounts, load_history_cursor, mark_history_backfill_done,
    };
    use crate::utils::env::EnvVars;

    #[test]
    fn test_aggregate_history_account_results_counts_and_sorts() {
        let result = aggregate_history_account_results(
            3,
            vec![
                HistoryCycleAccountResult {
                    account_id: "b.sputnik-dao.near".to_string(),
                    forward: Some(HistoryPollResult {
                        account_id: "b.sputnik-dao.near".to_string(),
                        items_fetched: 5,
                        rows_touched: 4,
                        had_history_changes: true,
                        next_cursor: Some("next-b".to_string()),
                        prev_cursor: Some("prev-b".to_string()),
                    }),
                    backfill: Some(HistoryBackfillResult {
                        account_id: "b.sputnik-dao.near".to_string(),
                        pages_fetched: 1,
                        items_fetched: 3,
                        rows_touched: 2,
                        prev_cursor: Some("older-b".to_string()),
                        backfill_done: false,
                    }),
                    error: None,
                },
                HistoryCycleAccountResult {
                    account_id: "invalid account".to_string(),
                    forward: None,
                    backfill: None,
                    error: Some("invalid account id".to_string()),
                },
                HistoryCycleAccountResult {
                    account_id: "a.sputnik-dao.near".to_string(),
                    forward: Some(HistoryPollResult {
                        account_id: "a.sputnik-dao.near".to_string(),
                        items_fetched: 2,
                        rows_touched: 1,
                        had_history_changes: false,
                        next_cursor: None,
                        prev_cursor: None,
                    }),
                    backfill: None,
                    error: Some("backfill failed".to_string()),
                },
            ],
        );

        assert_eq!(result.accounts_seen, 3);
        assert_eq!(result.accounts_processed, 2);
        assert_eq!(result.accounts_failed, 2);
        assert_eq!(result.forward_items_fetched, 7);
        assert_eq!(result.forward_rows_touched, 5);
        assert_eq!(result.backfill_items_fetched, 3);
        assert_eq!(result.backfill_rows_touched, 2);
        assert_eq!(
            result
                .accounts
                .iter()
                .map(|account| account.account_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "a.sputnik-dao.near",
                "b.sputnik-dao.near",
                "invalid account"
            ]
        );
    }

    fn successful_deposit_event(status: &str) -> HistoryEvent {
        let raw_payload = serde_json::json!({
            "amountInFormatted": "0.001",
            "amountInUsd": "0.0010",
            "amountOutFormatted": "0.001",
            "amountOutUsd": "0.0010",
            "createdAt": "2026-06-16T03:21:20.966465Z",
            "depositAddress": "deposit-address",
            "depositMemo": null,
            "depositType": "INTENTS",
            "destinationAsset": "nep141:wrap.near",
            "originAsset": "nep141:wrap.near",
            "recipient": "dao.near",
            "recipientType": "CONFIDENTIAL_INTENTS",
            "status": status
        });
        let item = serde_json::from_value(raw_payload.clone()).expect("event should parse");
        HistoryEvent { item, raw_payload }
    }

    fn upsert_outcome(
        history_event_id: i64,
        state: HistoryEventUpsertState,
    ) -> HistoryEventUpsertOutcome {
        HistoryEventUpsertOutcome {
            history_event_id,
            created_at_external: chrono::Utc::now(),
            state,
        }
    }

    #[test]
    fn test_changed_success_deposit_is_forward_correction_candidate() {
        let account_id = AccountIdRef::new("dao.near").unwrap();
        let success = successful_deposit_event("SUCCESS");
        let pending = successful_deposit_event("PENDING");
        let items = vec![success.clone(), success, pending];
        let outcomes = vec![
            upsert_outcome(10, HistoryEventUpsertState::Changed),
            upsert_outcome(11, HistoryEventUpsertState::Unchanged),
            upsert_outcome(12, HistoryEventUpsertState::Changed),
        ];

        let candidates = collect_successful_deposit_candidates(account_id, &items, &outcomes);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].history_event_id, 10);
        assert_eq!(candidates[0].destination_asset, "nep141:wrap.near");
    }

    async fn create_real_api_state() -> Arc<AppState> {
        dotenvy::from_filename(".env").ok();
        dotenvy::from_filename(".env.test").ok();

        let env_vars = EnvVars::default();
        let db_pool = sqlx::postgres::PgPool::connect(&env_vars.database_url)
            .await
            .expect("Failed to connect to database");

        Arc::new(
            AppState::builder()
                .db_pool(db_pool)
                .env_vars(env_vars)
                .build()
                .await
                .expect("Failed to build AppState"),
        )
    }

    #[tokio::test]
    #[ignore]
    async fn test_poll_confidential_history_once_ingests_bronze_and_cursor() {
        let state = create_real_api_state().await;
        let dao_id = std::env::var("CONFIDENTIAL_HISTORY_TEST_DAO")
            .unwrap_or_else(|_| "tobi.sputnik-dao.near".to_string());
        let account_id = AccountIdRef::new(&dao_id).expect("test DAO must be a valid account ID");
        let limit = 5;

        let first = poll_confidential_history_once(&state, account_id, limit)
            .await
            .unwrap_or_else(|(status, msg)| {
                panic!("first history poll failed: {} - {}", status, msg)
            });

        assert_eq!(first.account_id, account_id.as_str());
        assert!(first.items_fetched <= limit as usize);
        assert_eq!(first.rows_touched, first.items_fetched as u64);

        let cursor = load_history_cursor(&state.db_pool, account_id.as_str())
            .await
            .expect("cursor load should succeed")
            .expect("cursor should exist after polling");
        assert_eq!(cursor.account_id, account_id.as_str());
        assert!(cursor.forward_cursor.is_some() || first.next_cursor.is_none());
        assert!(
            cursor.backward_cursor.is_none(),
            "latest-page poll must not touch backward_cursor"
        );

        let second = poll_confidential_history_once(&state, account_id, limit)
            .await
            .unwrap_or_else(|(status, msg)| {
                panic!("second history poll failed: {} - {}", status, msg)
            });
        assert!(second.items_fetched <= limit as usize);

        let duplicate_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM (
                SELECT 1
                FROM bronze_confidential_history_events
                WHERE account_id = $1
                GROUP BY created_at_external, deposit_address
                HAVING COUNT(*) > 1
            ) duplicates
            "#,
        )
        .bind(account_id.as_str())
        .fetch_one(&state.db_pool)
        .await
        .expect("duplicate check should succeed");

        assert_eq!(duplicate_count, 0);
    }

    #[tokio::test]
    #[ignore]
    async fn test_backfill_one_page_mode_ingests_bronze_and_cursor() {
        let state = create_real_api_state().await;
        let dao_id = std::env::var("CONFIDENTIAL_HISTORY_TEST_DAO")
            .unwrap_or_else(|_| "tobi.sputnik-dao.near".to_string());
        let account_id = AccountIdRef::new(&dao_id).expect("test DAO must be a valid account ID");
        let limit = 5;

        let first = backfill_confidential_history(&state, account_id, limit, BackfillMode::OnePage)
            .await
            .unwrap_or_else(|(status, msg)| {
                panic!("first backfill poll failed: {} - {}", status, msg)
            });

        assert_eq!(first.account_id, account_id.as_str());
        assert!(first.items_fetched <= limit as usize);
        assert_eq!(first.rows_touched, first.items_fetched as u64);

        let cursor = load_history_cursor(&state.db_pool, account_id.as_str())
            .await
            .expect("cursor load should succeed")
            .expect("cursor should exist after backfill");
        assert_eq!(cursor.account_id, account_id.as_str());

        let second =
            backfill_confidential_history(&state, account_id, limit, BackfillMode::OnePage)
                .await
                .unwrap_or_else(|(status, msg)| {
                    panic!("second backfill poll failed: {} - {}", status, msg)
                });
        assert!(second.items_fetched <= limit as usize);

        let duplicate_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM (
                SELECT 1
                FROM bronze_confidential_history_events
                WHERE account_id = $1
                GROUP BY created_at_external, deposit_address
                HAVING COUNT(*) > 1
            ) duplicates
            "#,
        )
        .bind(account_id.as_str())
        .fetch_one(&state.db_pool)
        .await
        .expect("duplicate check should succeed");

        assert_eq!(duplicate_count, 0);
    }

    #[tokio::test]
    #[ignore]
    async fn test_backfill_one_page_returns_when_already_done() {
        let state = create_real_api_state().await;
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let dao_id = format!("test-{}.near", &suffix[..8]);
        let account_id = AccountIdRef::new(&dao_id).expect("test DAO must be a valid account ID");

        mark_history_backfill_done(&state.db_pool, account_id.as_str())
            .await
            .expect("mark done should succeed");

        let result = backfill_confidential_history(&state, account_id, 5, BackfillMode::OnePage)
            .await
            .unwrap_or_else(|(status, msg)| {
                panic!("done backfill poll failed: {} - {}", status, msg)
            });

        assert_eq!(result.pages_fetched, 0);
        assert_eq!(result.items_fetched, 0);
        assert_eq!(result.rows_touched, 0);
        assert!(result.backfill_done);
    }

    #[tokio::test]
    #[ignore]
    async fn test_backfill_drain_skips_when_already_done() {
        let state = create_real_api_state().await;
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let dao_id = format!("test-{}.near", &suffix[..8]);
        let account_id = AccountIdRef::new(&dao_id).expect("test DAO must be a valid account ID");

        mark_history_backfill_done(&state.db_pool, account_id.as_str())
            .await
            .expect("mark done should succeed");

        let result = backfill_confidential_history(&state, account_id, 5, BackfillMode::Drain)
            .await
            .unwrap_or_else(|(status, msg)| {
                panic!("done backfill drain failed: {} - {}", status, msg)
            });

        assert_eq!(result.account_id, account_id.as_str());
        assert_eq!(result.pages_fetched, 0);
        assert_eq!(result.items_fetched, 0);
        assert_eq!(result.rows_touched, 0);
        assert!(result.backfill_done);
    }

    #[tokio::test]
    #[ignore]
    async fn test_tick_confidential_history_scheduler_fills_bronze_without_duplicates() {
        let state = create_real_api_state().await;
        let limit = 5;

        let result = tick_confidential_history_scheduler(&state, limit)
            .await
            .unwrap_or_else(|(status, msg)| panic!("history cycle failed: {} - {}", status, msg));
        let second_result = tick_confidential_history_scheduler(&state, limit)
            .await
            .unwrap_or_else(|(status, msg)| {
                panic!("second history cycle failed: {} - {}", status, msg)
            });

        assert_eq!(result.accounts_seen, result.accounts.len());
        assert_eq!(
            result.accounts_processed,
            result
                .accounts
                .iter()
                .filter(|account| account.forward.is_some())
                .count()
        );
        assert_eq!(
            result.accounts_failed,
            result
                .accounts
                .iter()
                .filter(|account| account.error.is_some())
                .count()
        );
        assert_eq!(
            result.forward_items_fetched,
            result
                .accounts
                .iter()
                .filter_map(|account| account.forward.as_ref())
                .map(|forward| forward.items_fetched)
                .sum::<usize>()
        );
        assert_eq!(
            result.forward_rows_touched,
            result
                .accounts
                .iter()
                .filter_map(|account| account.forward.as_ref())
                .map(|forward| forward.rows_touched)
                .sum::<u64>()
        );
        assert_eq!(
            result.backfill_items_fetched,
            result
                .accounts
                .iter()
                .filter_map(|account| account.backfill.as_ref())
                .map(|backfill| backfill.items_fetched)
                .sum::<usize>()
        );
        assert_eq!(
            result.backfill_rows_touched,
            result
                .accounts
                .iter()
                .filter_map(|account| account.backfill.as_ref())
                .map(|backfill| backfill.rows_touched)
                .sum::<u64>()
        );
        assert!(
            result
                .accounts
                .iter()
                .filter_map(|account| account.backfill.as_ref())
                .all(|backfill| backfill.backfill_done)
        );
        assert!(
            second_result
                .accounts
                .iter()
                .filter_map(|account| account.backfill.as_ref())
                .all(|backfill| backfill.pages_fetched == 0 || backfill.backfill_done)
        );

        let touched_accounts: Vec<String> = result
            .accounts
            .iter()
            .filter(|account| account.forward.is_some() || account.backfill.is_some())
            .map(|account| account.account_id.clone())
            .collect();
        if touched_accounts.is_empty() {
            return;
        }

        let duplicate_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM (
                SELECT 1
                FROM bronze_confidential_history_events
                WHERE account_id = ANY($1)
                GROUP BY account_id, created_at_external, deposit_address
                HAVING COUNT(*) > 1
            ) duplicates
            "#,
        )
        .bind(&touched_accounts)
        .fetch_one(&state.db_pool)
        .await
        .expect("duplicate check should succeed");

        assert_eq!(duplicate_count, 0);
    }

    #[tokio::test]
    #[ignore]
    async fn test_load_confidential_history_accounts_for_cycle() {
        let state = create_real_api_state().await;

        let accounts = load_confidential_history_accounts(&state.db_pool)
            .await
            .expect("account load should succeed");

        let mut sorted = accounts.clone();
        sorted.sort();
        assert_eq!(accounts, sorted);
    }
}
