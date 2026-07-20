use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use apalis::layers::WorkerBuilderExt;
use apalis::prelude::*;
use apalis_core::backend::TaskSinkError;
use apalis_core::task::Task;
use apalis_postgres::{Config, PgContext, PgTask, PostgresStorage};
use axum::http::StatusCode;
use sqlx::PgPool;
use tokio_util::sync::CancellationToken;

use super::PublicHistorySupervisorFuture;
use super::model::PublicHistoryJob;
use crate::AppState;
use crate::handlers::public_history::bronze::NearblocksPriority;
use crate::handlers::public_history::bronze::ingest_worker::{
    HandlerResult, fetch_source_page, latest_seen,
};
use crate::handlers::public_history::bronze::store::{
    PublicHistorySource, load_public_history_cursor, record_public_history_poll_result,
    save_public_backfill_progress, upsert_public_history_events,
};
use crate::handlers::public_history::gold::projector::project_public_gold_for_account;
use crate::handlers::public_history::proposals::linker::link_public_proposal_receipts;
use crate::handlers::public_history::silver::worker::project_public_silver_for_account;
use crate::jobs::context::JobContext;

use super::postgres::{
    PUBLIC_HISTORY_BACKFILL_NAMESPACE, PUBLIC_HISTORY_INFLIGHT_INDEX, PUBLIC_HISTORY_JOB_KEY_FIELD,
    PUBLIC_HISTORY_LATEST_NAMESPACE, active_public_history_job_exists, is_unique_violation_on,
};

pub(crate) const JOB_CONCURRENCY: usize = 2;
pub(crate) const BACKFILL_JOB_CONCURRENCY: usize = 2;
pub(crate) const BACKFILL_MAX_PAGES_PER_ACCOUNT_PER_DAY: i32 = 20;

const PUBLIC_HISTORY_LATEST_WORKER: &str = "public-history-latest";
const PUBLIC_HISTORY_BACKFILL_WORKER: &str = "public-history-backfill";
const RESTART_BACKOFF_INITIAL: Duration = Duration::from_secs(2);
const RESTART_BACKOFF_MAX: Duration = Duration::from_secs(60);
const RESTART_STABILITY_WINDOW: Duration = Duration::from_secs(300);
const RESTART_JITTER_MIN_PERCENT: u64 = 80;

type WorkerRunFuture = Pin<Box<dyn Future<Output = Result<(), WorkerError>> + Send>>;

#[derive(Clone, Copy)]
struct ConsumerSupervisorConfig {
    initial_backoff: Duration,
    max_backoff: Duration,
    stability_window: Duration,
}

impl ConsumerSupervisorConfig {
    fn production() -> Self {
        Self {
            initial_backoff: RESTART_BACKOFF_INITIAL,
            max_backoff: RESTART_BACKOFF_MAX,
            stability_window: RESTART_STABILITY_WINDOW,
        }
    }
}

type PublicHistoryStorage = PostgresStorage<PublicHistoryJob>;

fn public_history_error(message: impl Into<String>) -> BoxDynError {
    std::io::Error::other(message.into()).into()
}

fn latest_storage(pool: PgPool) -> PublicHistoryStorage {
    public_history_storage(
        pool,
        PUBLIC_HISTORY_LATEST_NAMESPACE,
        JOB_CONCURRENCY.max(1),
    )
}

fn backfill_storage(pool: PgPool) -> PublicHistoryStorage {
    public_history_storage(
        pool,
        PUBLIC_HISTORY_BACKFILL_NAMESPACE,
        BACKFILL_JOB_CONCURRENCY.max(1),
    )
}

fn public_history_storage(
    pool: PgPool,
    namespace: &'static str,
    buffer_size: usize,
) -> PublicHistoryStorage {
    let config = Config::new(namespace).set_buffer_size(buffer_size);
    PostgresStorage::new_with_config(&pool, &config)
}

fn task_with_job_key(job: PublicHistoryJob) -> PgTask<PublicHistoryJob> {
    let mut metadata = serde_json::Map::new();
    metadata.insert(
        PUBLIC_HISTORY_JOB_KEY_FIELD.to_string(),
        serde_json::Value::String(job.job_key().to_string()),
    );

    Task::builder(job)
        .with_ctx(PgContext::new().with_meta(metadata))
        .build()
}

async fn push_job(
    storage: &mut PublicHistoryStorage,
    job: PublicHistoryJob,
) -> Result<bool, sqlx::Error> {
    match storage.push_task(task_with_job_key(job)).await {
        Ok(_) => Ok(true),
        Err(TaskSinkError::PushError(error))
            if is_unique_violation_on(&error, PUBLIC_HISTORY_INFLIGHT_INDEX) =>
        {
            Ok(false)
        }
        Err(TaskSinkError::PushError(error)) => Err(error),
        Err(TaskSinkError::CodecError(error)) => Err(sqlx::Error::Protocol(error.to_string())),
    }
}

pub(crate) async fn enqueue_latest_refresh_job(
    pool: &PgPool,
    account_id: String,
    source: PublicHistorySource,
    trigger_block_height: i64,
    trigger_transaction_hash: Option<String>,
) -> Result<bool, sqlx::Error> {
    let job = PublicHistoryJob::refresh_latest(
        account_id,
        source,
        trigger_block_height,
        trigger_transaction_hash,
    );
    let mut storage = latest_storage(pool.clone());
    push_job(&mut storage, job).await
}

async fn consume_backfill_budget(
    pool: &PgPool,
    account_id: &str,
    source: PublicHistorySource,
) -> Result<bool, sqlx::Error> {
    let row = sqlx::query_scalar::<_, i32>(
        r#"
        INSERT INTO public_history_backfill_usage (
            account_id,
            source,
            usage_date,
            pages_fetched,
            created_at,
            updated_at
        )
        VALUES ($1, $2::public_history_source, CURRENT_DATE, 1, NOW(), NOW())
        ON CONFLICT (account_id, source, usage_date) DO UPDATE SET
            pages_fetched = public_history_backfill_usage.pages_fetched + 1,
            updated_at = NOW()
        WHERE public_history_backfill_usage.pages_fetched < $3
        RETURNING pages_fetched
        "#,
    )
    .bind(account_id)
    .bind(source.as_str())
    .bind(BACKFILL_MAX_PAGES_PER_ACCOUNT_PER_DAY)
    .fetch_optional(pool)
    .await?;

    Ok(row.is_some())
}

pub(crate) async fn enqueue_backfill_page_job(
    pool: &PgPool,
    account_id: String,
    source: PublicHistorySource,
    cursor: Option<String>,
) -> Result<bool, sqlx::Error> {
    let job = PublicHistoryJob::backfill_page(account_id, source, cursor);
    if active_public_history_job_exists(pool, PUBLIC_HISTORY_BACKFILL_NAMESPACE, job.job_key())
        .await?
    {
        return Ok(false);
    }

    let PublicHistoryJob::BackfillPage {
        account_id, source, ..
    } = &job
    else {
        unreachable!("constructed backfill job must be BackfillPage")
    };
    if !consume_backfill_budget(pool, account_id, *source).await? {
        return Ok(false);
    }

    let mut storage = backfill_storage(pool.clone());
    push_job(&mut storage, job).await
}

async fn ingest_page(
    state: &AppState,
    source: PublicHistorySource,
    page_events: &[crate::handlers::public_history::bronze::store::BronzePublicHistoryEvent],
) -> HandlerResult<(u64, u64, u64)> {
    let upsert_result = upsert_public_history_events(&state.db_pool, page_events)
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("public bronze upsert failed: {}", error),
            )
        })?;

    if source == PublicHistorySource::NearblocksReceipt {
        link_public_proposal_receipts(state, page_events).await?;
    }

    Ok((
        upsert_result.rows_touched,
        upsert_result.rows_inserted,
        upsert_result.rows_changed,
    ))
}

async fn run_latest_refresh(
    state: &AppState,
    account_id: &str,
    source: PublicHistorySource,
) -> HandlerResult<(u64, u64, u64)> {
    let watermark = load_public_history_cursor(&state.db_pool, account_id, source)
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("public cursor load failed: {}", error),
            )
        })?
        .and_then(|cursor| cursor.last_seen_block_height);

    let mut cursor: Option<String> = None;
    let mut totals = (0, 0, 0);
    let mut max_seen_height: Option<i64> = None;

    loop {
        let page = fetch_source_page(
            state,
            account_id,
            source,
            cursor.as_deref(),
            NearblocksPriority::Latest,
        )
        .await?;
        let (touched, inserted, changed) = ingest_page(state, source, &page.events).await?;
        totals.0 += touched;
        totals.1 += inserted;
        totals.2 += changed;

        let page_height = latest_seen(&page);
        if page_height > max_seen_height {
            max_seen_height = page_height;
        }

        // NearBlocks only paginates newest→older, so a refresh walks from the
        // head until it overlaps history it has already seen. An event strictly
        // below the block-height watermark proves the overlap; strict-less-than
        // re-ingests the watermark block itself, which the idempotent upsert
        // absorbs.
        let reached_watermark = match watermark {
            Some(watermark) => page
                .events
                .iter()
                .any(|event| event.block_height < watermark),
            // First refresh seeds the watermark from one page; backfill owns
            // the rest of history.
            None => true,
        };
        if page.events.is_empty() || page.next_cursor.is_none() || reached_watermark {
            break;
        }
        cursor = page.next_cursor;
    }

    // One poll record per drain: the block-height watermark (GREATEST upsert)
    // advances only after every fetched page ingested successfully, so a
    // failed drain retries from an unmoved watermark.
    record_public_history_poll_result(&state.db_pool, account_id, source, max_seen_height)
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("public poll schedule update failed: {}", error),
            )
        })?;

    Ok(totals)
}

async fn run_backfill_page(
    state: &AppState,
    account_id: &str,
    source: PublicHistorySource,
    job_cursor: Option<String>,
) -> HandlerResult<(u64, u64, u64)> {
    let cursor = load_public_history_cursor(&state.db_pool, account_id, source)
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("public cursor load failed: {}", error),
            )
        })?;

    if cursor.as_ref().is_some_and(|cursor| cursor.backfill_done) {
        return Ok((0, 0, 0));
    }

    let current_backward_cursor = cursor
        .as_ref()
        .and_then(|cursor| cursor.backward_cursor.clone());
    if current_backward_cursor != job_cursor {
        return Ok((0, 0, 0));
    }

    let page = fetch_source_page(
        state,
        account_id,
        source,
        job_cursor.as_deref(),
        NearblocksPriority::Backfill,
    )
    .await?;
    let next_cursor = page.next_cursor.clone();
    let page_is_empty = page.events.is_empty();
    let (touched, inserted, changed) = ingest_page(state, source, &page.events).await?;

    let backfill_done =
        page_is_empty || next_cursor.is_none() || next_cursor.as_deref() == job_cursor.as_deref();
    save_public_backfill_progress(
        &state.db_pool,
        account_id,
        source,
        next_cursor.as_deref(),
        backfill_done,
    )
    .await
    .map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("public backfill cursor save failed: {}", error),
        )
    })?;

    if !backfill_done {
        enqueue_backfill_page_job(&state.db_pool, account_id.to_string(), source, next_cursor)
            .await
            .map_err(|error| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("public next backfill enqueue failed: {}", error),
                )
            })?;
    }

    Ok((touched, inserted, changed))
}

async fn handle_latest_job(
    job: PublicHistoryJob,
    context: Data<JobContext>,
) -> Result<(), BoxDynError> {
    let PublicHistoryJob::RefreshLatest {
        account_id, source, ..
    } = job
    else {
        return Ok(());
    };

    let (touched, inserted, changed) = run_latest_refresh(&context.state, &account_id, source)
        .await
        .map_err(|(status, message)| {
            public_history_error(format!(
                "public latest refresh failed ({}): {}",
                status, message
            ))
        })?;

    tracing::info!(
        account_id = account_id,
        source = %source,
        rows_touched = touched,
        rows_inserted = inserted,
        rows_changed = changed,
        "public latest refresh job finished"
    );

    let silver_ready =
        match project_public_silver_for_account(&context.state.db_pool, &account_id).await {
            Ok(silver_stats) if silver_stats.skipped_locked => {
                tracing::debug!(
                    account_id = account_id,
                    source = %source,
                    "public latest refresh projection nudge skipped silver lock"
                );
                false
            }
            Ok(silver_stats) => {
                tracing::debug!(
                    account_id = account_id,
                    source = %source,
                    rows_projected = silver_stats.rows_projected,
                    rows_deleted = silver_stats.rows_deleted,
                    errors_written = silver_stats.errors_written,
                    "public latest refresh projection nudge finished silver"
                );
                true
            }
            Err(error) => {
                tracing::warn!(
                    account_id = account_id,
                    source = %source,
                    error = %error,
                    "public latest refresh projection nudge failed silver"
                );
                false
            }
        };

    if !silver_ready {
        return Ok(());
    }

    match project_public_gold_for_account(
        &context.state.db_pool,
        &context.state.token_price_service,
        &account_id,
        context.state.signer_id.as_str(),
    )
    .await
    {
        Ok(gold_stats) if gold_stats.skipped_locked => {
            tracing::debug!(
                account_id = account_id,
                source = %source,
                "public latest refresh projection nudge skipped gold lock"
            );
        }
        Ok(gold_stats) => {
            tracing::debug!(
                account_id = account_id,
                source = %source,
                rows_projected = gold_stats.rows_projected,
                rows_deleted = gold_stats.rows_deleted,
                errors_written = gold_stats.errors_written,
                "public latest refresh projection nudge finished gold"
            );
            if gold_stats.rows_projected > 0 || gold_stats.rows_deleted > 0 {
                context
                    .state
                    .publish_treasury_projection_updated(account_id.clone());
            }
        }
        Err(error) => {
            tracing::warn!(
                account_id = account_id,
                source = %source,
                error = %error,
                "public latest refresh projection nudge failed gold"
            );
        }
    }

    Ok(())
}

async fn handle_backfill_job(
    job: PublicHistoryJob,
    context: Data<JobContext>,
) -> Result<(), BoxDynError> {
    let PublicHistoryJob::BackfillPage {
        account_id,
        source,
        cursor,
        ..
    } = job
    else {
        return Ok(());
    };

    run_backfill_page(&context.state, &account_id, source, cursor)
        .await
        .map(|(touched, inserted, changed)| {
            tracing::info!(
                account_id = account_id,
                source = %source,
                rows_touched = touched,
                rows_inserted = inserted,
                rows_changed = changed,
                "public backfill page job finished"
            );
        })
        .map_err(|(status, message)| {
            public_history_error(format!(
                "public backfill page failed ({}): {}",
                status, message
            ))
        })
}

fn restart_backoff(config: ConsumerSupervisorConfig, consecutive_failures: usize) -> Duration {
    let exponent = consecutive_failures.min(63) as u32;
    let multiplier = 1u64.checked_shl(exponent).unwrap_or(u64::MAX);
    let initial_millis = config.initial_backoff.as_millis();
    let max_millis = config.max_backoff.as_millis();
    let backoff_millis = initial_millis
        .saturating_mul(u128::from(multiplier))
        .min(max_millis);

    Duration::from_millis(backoff_millis.min(u128::from(u64::MAX)) as u64)
}

fn jittered_backoff(base: Duration, jitter_percent: u64) -> Duration {
    let jitter_percent = jitter_percent.clamp(RESTART_JITTER_MIN_PERCENT, 100);
    let millis = base.as_millis().saturating_mul(u128::from(jitter_percent)) / 100;
    Duration::from_millis(millis.min(u128::from(u64::MAX)) as u64)
}

async fn sleep_or_shutdown(delay: Duration, shutdown: &CancellationToken) -> bool {
    tokio::select! {
        _ = shutdown.cancelled() => true,
        _ = tokio::time::sleep(delay) => false,
    }
}

async fn supervise_public_history_worker<F>(
    worker_name: &'static str,
    shutdown: CancellationToken,
    config: ConsumerSupervisorConfig,
    mut run_worker: F,
) where
    F: FnMut(CancellationToken) -> WorkerRunFuture,
{
    let mut consecutive_failures = 0usize;
    loop {
        if shutdown.is_cancelled() {
            return;
        }

        tracing::info!(worker = worker_name, "starting public history consumer");
        let started_at = Instant::now();
        let result = run_worker(shutdown.clone()).await;

        if shutdown.is_cancelled() {
            tracing::info!(
                worker = worker_name,
                "public history consumer stopped for shutdown"
            );
            return;
        }

        if started_at.elapsed() >= config.stability_window {
            consecutive_failures = 0;
        }

        let base_delay = restart_backoff(config, consecutive_failures);
        let jitter_percent = rand::random_range(RESTART_JITTER_MIN_PERCENT..=100);
        let retry_delay = jittered_backoff(base_delay, jitter_percent);
        let attempt = consecutive_failures.saturating_add(1);
        consecutive_failures = attempt;

        match result {
            Err(error) if error.to_string().contains("WORKER_ALREADY_EXISTS") => {
                tracing::warn!(
                    worker = worker_name,
                    error = %error,
                    attempt,
                    retry_delay_ms = retry_delay.as_millis(),
                    "public history consumer already active; retrying with backoff"
                );
            }
            Err(error) => {
                tracing::error!(
                    worker = worker_name,
                    error = %error,
                    attempt,
                    retry_delay_ms = retry_delay.as_millis(),
                    "public history consumer exited unexpectedly; retrying with backoff"
                );
            }
            Ok(()) => {
                tracing::error!(
                    worker = worker_name,
                    attempt,
                    retry_delay_ms = retry_delay.as_millis(),
                    "public history consumer stopped unexpectedly; retrying with backoff"
                );
            }
        }

        if sleep_or_shutdown(retry_delay, &shutdown).await {
            tracing::info!(
                worker = worker_name,
                "public history consumer retry cancelled"
            );
            return;
        }
    }
}

fn public_history_supervisor_future<F>(
    worker_name: &'static str,
    shutdown: CancellationToken,
    config: ConsumerSupervisorConfig,
    run_worker: F,
) -> PublicHistorySupervisorFuture
where
    F: FnMut(CancellationToken) -> WorkerRunFuture + Send + 'static,
{
    Box::pin(supervise_public_history_worker(
        worker_name,
        shutdown,
        config,
        run_worker,
    ))
}

pub(crate) fn public_history_job_worker_futures(
    state: Arc<AppState>,
    shutdown: CancellationToken,
) -> Vec<PublicHistorySupervisorFuture> {
    let config = ConsumerSupervisorConfig::production();
    let latest_state = state.clone();
    let latest_shutdown = shutdown.clone();
    let latest = public_history_supervisor_future(
        PUBLIC_HISTORY_LATEST_WORKER,
        latest_shutdown,
        config,
        move |worker_shutdown| {
            let latest_state = latest_state.clone();
            Box::pin(async move {
                let storage = latest_storage(latest_state.db_pool.clone());
                WorkerBuilder::new(PUBLIC_HISTORY_LATEST_WORKER)
                    .backend(storage)
                    .data(JobContext::new(latest_state))
                    .timeout(crate::jobs::job_timeout())
                    .enable_tracing()
                    .concurrency(JOB_CONCURRENCY)
                    .build(handle_latest_job)
                    .run_until(async move {
                        worker_shutdown.cancelled().await;
                        Ok::<(), WorkerError>(())
                    })
                    .await
            })
        },
    );

    let backfill = public_history_supervisor_future(
        PUBLIC_HISTORY_BACKFILL_WORKER,
        shutdown,
        config,
        move |worker_shutdown| {
            let state = state.clone();
            Box::pin(async move {
                let storage = backfill_storage(state.db_pool.clone());
                WorkerBuilder::new(PUBLIC_HISTORY_BACKFILL_WORKER)
                    .backend(storage)
                    .data(JobContext::new(state))
                    .timeout(crate::jobs::job_timeout())
                    .enable_tracing()
                    .concurrency(BACKFILL_JOB_CONCURRENCY)
                    .build(handle_backfill_job)
                    .run_until(async move {
                        worker_shutdown.cancelled().await;
                        Ok::<(), WorkerError>(())
                    })
                    .await
            })
        },
    );

    vec![latest, backfill]
}

/// The two queue storages, typed for apalis-board registration.
pub(crate) fn board_storages(pool: PgPool) -> Vec<PostgresStorage<PublicHistoryJob>> {
    vec![latest_storage(pool.clone()), backfill_storage(pool)]
}

#[cfg(test)]
mod supervisor_tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;

    struct DropFlag(Arc<AtomicBool>);

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn restart_backoff_is_exponential_and_capped() {
        let config = ConsumerSupervisorConfig::production();
        let seconds: Vec<u64> = (0..8)
            .map(|attempt| restart_backoff(config, attempt).as_secs())
            .collect();

        assert_eq!(seconds, vec![2, 4, 8, 16, 32, 60, 60, 60]);
    }

    #[test]
    fn restart_jitter_stays_within_twenty_percent() {
        let base = Duration::from_secs(60);
        assert_eq!(jittered_backoff(base, 80), Duration::from_secs(48));
        assert_eq!(jittered_backoff(base, 100), Duration::from_secs(60));
        assert_eq!(jittered_backoff(base, 50), Duration::from_secs(48));
    }

    async fn assert_worker_error_is_retried(message: &'static str) {
        let shutdown = CancellationToken::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let runner_calls = calls.clone();
        let config = ConsumerSupervisorConfig {
            initial_backoff: Duration::from_millis(1),
            max_backoff: Duration::from_millis(1),
            stability_window: Duration::from_secs(1),
        };
        let supervisor_shutdown = shutdown.clone();
        let supervisor = tokio::spawn(async move {
            supervise_public_history_worker(
                "test-worker",
                supervisor_shutdown,
                config,
                move |worker_shutdown| {
                    let call = runner_calls.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async move {
                        if call == 0 {
                            return Err(WorkerError::IoError(std::io::Error::other(message)));
                        }
                        worker_shutdown.cancelled().await;
                        Ok(())
                    })
                },
            )
            .await;
        });

        tokio::time::timeout(Duration::from_secs(1), async {
            while calls.load(Ordering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("worker should be rebuilt after collision");

        shutdown.cancel();
        supervisor.await.expect("supervisor task should not panic");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn worker_already_exists_is_retried() {
        assert_worker_error_is_retried("WORKER_ALREADY_EXISTS").await;
    }

    #[tokio::test]
    async fn database_disconnect_is_retried() {
        assert_worker_error_is_retried("peer closed connection without TLS close_notify").await;
    }

    #[tokio::test]
    async fn shutdown_during_backoff_prevents_another_worker_start() {
        let shutdown = CancellationToken::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let runner_calls = calls.clone();
        let config = ConsumerSupervisorConfig {
            initial_backoff: Duration::from_secs(60),
            max_backoff: Duration::from_secs(60),
            stability_window: Duration::from_secs(1),
        };
        let supervisor_shutdown = shutdown.clone();
        let supervisor = tokio::spawn(async move {
            supervise_public_history_worker(
                "test-worker",
                supervisor_shutdown,
                config,
                move |_| {
                    runner_calls.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async {
                        Err(WorkerError::IoError(std::io::Error::other(
                            "database unavailable",
                        )))
                    })
                },
            )
            .await;
        });

        tokio::time::timeout(Duration::from_secs(1), async {
            while calls.load(Ordering::SeqCst) < 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("worker should start once");

        shutdown.cancel();
        supervisor.await.expect("supervisor task should not panic");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn aborting_supervisor_owner_drops_active_worker_future() {
        let shutdown = CancellationToken::new();
        let started = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicBool::new(false));
        let runner_started = started.clone();
        let runner_dropped = dropped.clone();
        let config = ConsumerSupervisorConfig {
            initial_backoff: Duration::from_secs(60),
            max_backoff: Duration::from_secs(60),
            stability_window: Duration::from_secs(1),
        };

        let supervisor =
            public_history_supervisor_future("test-worker", shutdown, config, move |_| {
                runner_started.store(true, Ordering::SeqCst);
                let drop_flag = DropFlag(runner_dropped.clone());
                Box::pin(async move {
                    let _drop_flag = drop_flag;
                    std::future::pending::<Result<(), WorkerError>>().await
                })
            });
        let owner = tokio::spawn(supervisor);

        tokio::time::timeout(Duration::from_secs(1), async {
            while !started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("worker future should start");

        owner.abort();
        let error = owner.await.expect_err("owner should be cancelled");
        assert!(error.is_cancelled());
        assert!(
            dropped.load(Ordering::SeqCst),
            "the active worker future must not detach from its supervisor owner"
        );
    }
}
