use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use apalis::layers::WorkerBuilderExt;
use apalis::layers::sentry::SentryLayer;
use apalis::prelude::*;
use apalis_core::backend::TaskSinkError;
use apalis_core::task::Task;
use apalis_postgres::{Config, PgContext, PgTask, PostgresStorage};
use axum::http::StatusCode;
use futures::FutureExt;
use sqlx::PgPool;
use tokio_util::sync::CancellationToken;

use super::PublicHistorySupervisorFuture;
use super::model::PublicHistoryJob;
use crate::AppState;
use crate::handlers::public_history::bronze::NearblocksPriority;
use crate::handlers::public_history::bronze::api::{
    NearblocksCursor, fetch_latest_indexed_block_height,
};
use crate::handlers::public_history::bronze::ingest_worker::{
    HandlerResult, fetch_source_page, latest_seen,
};
use crate::handlers::public_history::bronze::store::{
    PublicHistorySource, advance_public_history_last_seen, complete_latest_demand,
    defer_latest_demand, load_public_history_cursor, record_public_history_coverage,
    save_public_backfill_progress, upsert_public_history_events,
};
use crate::handlers::public_history::gold::projector::project_public_gold_for_account;
use crate::handlers::public_history::proposals::linker::link_public_proposal_receipts;
use crate::handlers::public_history::silver::worker::project_public_silver_for_account;
use crate::handlers::public_history::verification::BalanceVerifier;
use crate::jobs::context::JobContext;
use crate::jobs::platform::{JobWakeHub, QueueSpec, SteadyPostgresStorage};

use super::postgres::{
    PUBLIC_HISTORY_BACKFILL_NAMESPACE, PUBLIC_HISTORY_INFLIGHT_INDEX, PUBLIC_HISTORY_JOB_KEY_FIELD,
    PUBLIC_HISTORY_LATEST_NAMESPACE, PUBLIC_HISTORY_READINESS_NAMESPACE,
    active_public_history_job_exists, is_unique_violation_on,
};

pub(crate) const JOB_CONCURRENCY_DEFAULT: usize = 4;

/// Latest-refresh worker slots, overridable via
/// `PUBLIC_HISTORY_LATEST_CONCURRENCY`. Concurrency hides database and
/// network latency between rate-gate permits; it cannot bypass the shared
/// NearBlocks budget, so raise `NEARBLOCKS_MAX_PER_MINUTE` for throughput.
pub(crate) fn job_concurrency() -> usize {
    std::env::var("PUBLIC_HISTORY_LATEST_CONCURRENCY")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(JOB_CONCURRENCY_DEFAULT)
        .max(1)
}
pub(crate) const BACKFILL_JOB_CONCURRENCY: usize = 2;
pub(crate) const READINESS_JOB_CONCURRENCY: usize = 1;
pub(crate) const BACKFILL_MAX_PAGES_PER_ACCOUNT_SOURCE_PER_DAY: i32 = 50;

const PUBLIC_HISTORY_LATEST_WORKER: &str = "public-history-latest";
const PUBLIC_HISTORY_READINESS_WORKER: &str = "public-history-readiness";
const PUBLIC_HISTORY_BACKFILL_WORKER: &str = "public-history-backfill";
const SINGLE_SHOT_MAX_ATTEMPTS: i32 = 1;
const BACKFILL_MAX_ATTEMPTS: i32 = 5;
const RESTART_BACKOFF_INITIAL: Duration = Duration::from_secs(1);
const RESTART_BACKOFF_MAX: Duration = Duration::from_secs(30);
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
    let config = Config::new(PUBLIC_HISTORY_LATEST_NAMESPACE).set_buffer_size(job_concurrency());
    PostgresStorage::new_with_config(&pool, &config)
}

fn readiness_storage(pool: PgPool) -> PublicHistoryStorage {
    let config =
        Config::new(PUBLIC_HISTORY_READINESS_NAMESPACE).set_buffer_size(READINESS_JOB_CONCURRENCY);
    PostgresStorage::new_with_config(&pool, &config)
}

fn backfill_storage(pool: PgPool) -> PublicHistoryStorage {
    let config = Config::new(PUBLIC_HISTORY_BACKFILL_NAMESPACE)
        .set_buffer_size(BACKFILL_JOB_CONCURRENCY.max(1));
    PostgresStorage::new_with_config(&pool, &config)
}

pub(crate) fn public_history_queue_specs() -> Vec<QueueSpec> {
    vec![
        QueueSpec::queue(
            PUBLIC_HISTORY_LATEST_NAMESPACE,
            job_concurrency(),
            crate::jobs::job_timeout(),
        )
        .with_notify()
        .with_backlog_alert_after(Duration::from_secs(120)),
        QueueSpec::queue(
            PUBLIC_HISTORY_READINESS_NAMESPACE,
            READINESS_JOB_CONCURRENCY,
            crate::jobs::job_timeout(),
        )
        .with_notify(),
        QueueSpec::queue(
            PUBLIC_HISTORY_BACKFILL_NAMESPACE,
            BACKFILL_JOB_CONCURRENCY,
            crate::jobs::job_timeout(),
        ),
    ]
}

fn worker_storage(
    pool: &PgPool,
    spec: &QueueSpec,
    wake_hub: &JobWakeHub,
) -> SteadyPostgresStorage<PublicHistoryJob> {
    SteadyPostgresStorage::new(pool, spec, wake_hub)
}

fn task_with_job_key(
    job: PublicHistoryJob,
    priority: i32,
    max_attempts: i32,
) -> PgTask<PublicHistoryJob> {
    let mut metadata = serde_json::Map::new();
    metadata.insert(
        PUBLIC_HISTORY_JOB_KEY_FIELD.to_string(),
        serde_json::Value::String(job.job_key().to_string()),
    );

    Task::builder(job)
        .with_ctx(
            PgContext::new()
                .with_meta(metadata)
                .with_priority(priority)
                .with_max_attempts(max_attempts),
        )
        .build()
}

async fn push_job(
    storage: &mut PublicHistoryStorage,
    job: PublicHistoryJob,
    priority: i32,
    max_attempts: i32,
) -> Result<bool, sqlx::Error> {
    match storage
        .push_task(task_with_job_key(job, priority, max_attempts))
        .await
    {
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
    generation: i64,
) -> Result<bool, sqlx::Error> {
    let job = PublicHistoryJob::refresh_latest(
        account_id,
        source,
        trigger_block_height,
        trigger_transaction_hash,
        generation,
    );
    let mut storage = latest_storage(pool.clone());
    push_job(&mut storage, job, 0, SINGLE_SHOT_MAX_ATTEMPTS).await
}

pub(crate) async fn enqueue_readiness_refresh_job(
    pool: &PgPool,
    account_id: String,
) -> Result<bool, sqlx::Error> {
    let job = PublicHistoryJob::refresh_readiness(account_id);
    let mut storage = readiness_storage(pool.clone());
    push_job(&mut storage, job, 0, SINGLE_SHOT_MAX_ATTEMPTS).await
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

    let mut storage = backfill_storage(pool.clone());
    push_job(&mut storage, job, 0, BACKFILL_MAX_ATTEMPTS).await
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
    .bind(BACKFILL_MAX_PAGES_PER_ACCOUNT_SOURCE_PER_DAY)
    .fetch_optional(pool)
    .await?;

    Ok(row.is_some())
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

async fn trigger_transaction_is_ingested(
    pool: &PgPool,
    account_id: &str,
    source: PublicHistorySource,
    transaction_hash: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM bronze_public_history_events
            WHERE account_id = $1
              AND source = $2::public_history_source
              AND transaction_hash = $3
        )
        "#,
    )
    .bind(account_id)
    .bind(source.as_str())
    .bind(transaction_hash)
    .fetch_one(pool)
    .await
}

async fn run_latest_refresh(
    state: &AppState,
    account_id: &str,
    source: PublicHistorySource,
    trigger_block_height: i64,
    trigger_transaction_hash: Option<&str>,
) -> HandlerResult<(u64, u64, u64)> {
    match trigger_transaction_hash {
        // The trigger transaction is its own completion proof: already
        // stored means the drain is done without any provider request, and
        // otherwise the drain below pages until it finds it.
        Some(transaction_hash) => {
            let already_ingested = trigger_transaction_is_ingested(
                &state.db_pool,
                account_id,
                source,
                transaction_hash,
            )
            .await
            .map_err(|error| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("trigger transaction verification failed: {error}"),
                )
            })?;
            if already_ingested {
                return Ok((0, 0, 0));
            }
        }
        // Without a hash there is no completion proof in the feed, so prove
        // the provider indexed past the trigger before reading — an inactive
        // account can legitimately return no new events.
        None => {
            let provider_head =
                fetch_latest_indexed_block_height(state, NearblocksPriority::Latest).await?;
            if provider_head < trigger_block_height {
                return Err((
                    StatusCode::BAD_GATEWAY,
                    format!(
                        "NearBlocks indexed head {} has not reached trigger block {}",
                        provider_head, trigger_block_height
                    ),
                ));
            }
        }
    }

    let watermark = load_public_history_cursor(&state.db_pool, account_id, source)
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("public cursor load failed: {}", error),
            )
        })?
        .and_then(|cursor| cursor.last_seen_block_height);

    let mut cursor: Option<NearblocksCursor> = None;
    let mut totals = (0, 0, 0);
    let mut max_seen_height: Option<i64> = None;
    let mut trigger_ingested = trigger_transaction_hash.is_none();

    loop {
        let page = fetch_source_page(
            state,
            account_id,
            source,
            cursor.as_ref(),
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
        if let Some(transaction_hash) = trigger_transaction_hash {
            trigger_ingested |= page
                .events
                .iter()
                .any(|event| event.transaction_hash.as_deref() == Some(transaction_hash));
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
            // A periodic first refresh seeds the watermark from one page;
            // event-triggered work keeps paging until it finds its transaction.
            None => trigger_ingested,
        };
        if page.events.is_empty() || page.next_cursor.is_none() || reached_watermark {
            break;
        }
        cursor = page.next_cursor;
    }

    if let Some(transaction_hash) = trigger_transaction_hash
        && !trigger_ingested
    {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!(
                "NearBlocks {} refresh has not indexed triggering transaction {}",
                source, transaction_hash
            ),
        ));
    }

    // Realtime drains advance the ingestion watermark only; verification
    // coverage stamps are the coordinated readiness refresh's to publish.
    advance_public_history_last_seen(&state.db_pool, account_id, source, max_seen_height)
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("public last-seen advance failed: {}", error),
            )
        })?;

    Ok(totals)
}

/// Drain one source newest→older until it overlaps the ingestion watermark
/// (or seeds a first page when no watermark exists). Advances `last_seen`
/// on success but never writes coverage stamps — that is the caller's
/// all-sources-succeeded decision.
async fn drain_source_to_watermark(
    state: &AppState,
    account_id: &str,
    source: PublicHistorySource,
    priority: NearblocksPriority,
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

    let mut cursor: Option<NearblocksCursor> = None;
    let mut totals = (0, 0, 0);
    let mut max_seen_height: Option<i64> = None;

    loop {
        let page = fetch_source_page(state, account_id, source, cursor.as_ref(), priority).await?;
        let (touched, inserted, changed) = ingest_page(state, source, &page.events).await?;
        totals.0 += touched;
        totals.1 += inserted;
        totals.2 += changed;

        let page_height = latest_seen(&page);
        if page_height > max_seen_height {
            max_seen_height = page_height;
        }

        let reached_watermark = match watermark {
            Some(watermark) => page
                .events
                .iter()
                .any(|event| event.block_height < watermark),
            None => true,
        };
        if page.events.is_empty() || page.next_cursor.is_none() || reached_watermark {
            break;
        }
        cursor = page.next_cursor;
    }

    advance_public_history_last_seen(&state.db_pool, account_id, source, max_seen_height)
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("public last-seen advance failed: {}", error),
            )
        })?;

    Ok(totals)
}

/// Account-level verification-coverage refresh: one provider-head request
/// covers all three sources; each drains to its watermark, and the coverage
/// stamps the verifier trusts publish only after every drain succeeded, so a
/// partial refresh can never certify coverage the account does not have.
pub(super) async fn run_readiness_refresh(
    state: &AppState,
    account_id: &str,
) -> HandlerResult<(u64, u64, u64)> {
    let provider_head =
        fetch_latest_indexed_block_height(state, NearblocksPriority::Readiness).await?;

    let mut totals = (0, 0, 0);
    for source in PublicHistorySource::all() {
        let (touched, inserted, changed) =
            drain_source_to_watermark(state, account_id, source, NearblocksPriority::Readiness)
                .await?;
        totals.0 += touched;
        totals.1 += inserted;
        totals.2 += changed;
    }

    record_public_history_coverage(&state.db_pool, account_id, provider_head)
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("public coverage stamp failed: {error}"),
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

    // Reserve the daily allowance immediately before the provider call. A
    // stale or already-complete token returns above without consuming quota;
    // a failed HTTP request still consumed provider capacity and therefore
    // correctly consumes one allowance.
    let has_budget = consume_backfill_budget(&state.db_pool, account_id, source)
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("public backfill budget check failed: {error}"),
            )
        })?;
    if !has_budget {
        return Ok((0, 0, 0));
    }

    let request_cursor = job_cursor.clone().and_then(NearblocksCursor::new);

    let page = fetch_source_page(
        state,
        account_id,
        source,
        request_cursor.as_ref(),
        NearblocksPriority::Backfill,
    )
    .await?;
    let next_cursor = page.next_cursor.clone();
    let page_is_empty = page.events.is_empty();
    let (touched, inserted, changed) = ingest_page(state, source, &page.events).await?;

    let backfill_done = page_is_empty
        || next_cursor.is_none()
        || next_cursor.as_ref().map(NearblocksCursor::as_str) == job_cursor.as_deref();
    save_public_backfill_progress(
        &state.db_pool,
        account_id,
        source,
        next_cursor.as_ref().map(NearblocksCursor::as_str),
        backfill_done,
    )
    .await
    .map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("public backfill cursor save failed: {}", error),
        )
    })?;

    // No immediate next-page chaining: the backfill scheduler selects the
    // next page in oldest-updated order, so many accounts progress fairly
    // instead of one account monopolizing the backfill lane.
    Ok((touched, inserted, changed))
}

async fn handle_latest_job(
    job: PublicHistoryJob,
    context: Data<JobContext>,
) -> Result<(), BoxDynError> {
    match job {
        // Single-shot dispatch token for a durable demand: success completes
        // the demand (unless a newer trigger bumped its generation — the
        // dispatcher then issues a follow-up token), failure defers the
        // demand on its retry schedule. Either way the token itself never
        // retries, so a failing account cannot pin a worker slot. Downstream
        // silver/gold/verification runs off the dirty cursors written by the
        // ingest, on the projector cadence.
        PublicHistoryJob::RefreshLatest {
            account_id,
            source,
            trigger_block_height,
            trigger_transaction_hash,
            generation,
            ..
        } => {
            let started_at = Instant::now();
            match run_latest_refresh(
                &context.state,
                &account_id,
                source,
                trigger_block_height,
                trigger_transaction_hash.as_deref(),
            )
            .await
            {
                Ok((touched, inserted, changed)) => {
                    complete_latest_demand(&context.state.db_pool, &account_id, source, generation)
                        .await
                        .map_err(|error| {
                            public_history_error(format!(
                                "latest demand completion failed: {error}"
                            ))
                        })?;
                    tracing::info!(
                        account_id = account_id,
                        source = %source,
                        rows_touched = touched,
                        rows_inserted = inserted,
                        rows_changed = changed,
                        handler_elapsed_ms = started_at.elapsed().as_millis(),
                        "public latest refresh job finished"
                    );
                }
                Err((status, message)) => {
                    let error = format!("{status}: {message}");
                    tracing::warn!(
                        account_id = account_id,
                        source = %source,
                        error = error,
                        handler_elapsed_ms = started_at.elapsed().as_millis(),
                        "public latest refresh failed; demand deferred for retry"
                    );
                    let deferred = defer_latest_demand(
                        &context.state.db_pool,
                        &account_id,
                        source,
                        generation,
                        &error,
                    )
                    .await
                    .map_err(|error| {
                        public_history_error(format!("latest demand defer failed: {error}"))
                    })?;
                    if !deferred {
                        tracing::info!(
                            account_id,
                            source = %source,
                            generation,
                            "ignored failure from superseded latest demand generation"
                        );
                    }
                }
            }
            Ok(())
        }
        // Rollout compatibility: readiness tokens created by the previous
        // release used the latest namespace. Move them to the isolated queue
        // without running provider work in a realtime worker slot.
        PublicHistoryJob::RefreshReadiness { account_id, .. } => {
            let enqueued =
                enqueue_readiness_refresh_job(&context.state.db_pool, account_id.clone())
                    .await
                    .map_err(|error| {
                        public_history_error(format!("readiness token migration failed: {error}"))
                    })?;
            tracing::info!(
                account_id,
                enqueued,
                "moved legacy readiness token out of realtime queue"
            );
            Ok(())
        }
        PublicHistoryJob::BackfillPage { .. } => Ok(()),
    }
}

async fn project_and_verify_readiness(
    context: &JobContext,
    account_id: &str,
) -> Result<(), BoxDynError> {
    let silver_ready = match project_public_silver_for_account(
        &context.state.db_pool,
        account_id,
        context.state.signer_id.as_str(),
    )
    .await
    {
        Ok(silver_stats) if silver_stats.skipped_locked => {
            tracing::debug!(
                account_id,
                "public readiness projection nudge skipped silver lock"
            );
            false
        }
        Ok(silver_stats) => {
            tracing::debug!(
                account_id,
                rows_projected = silver_stats.rows_projected,
                rows_deleted = silver_stats.rows_deleted,
                errors_written = silver_stats.errors_written,
                "public readiness projection nudge finished silver"
            );
            true
        }
        Err(error) => {
            tracing::warn!(
                account_id,
                error = %error,
                "public readiness projection nudge failed silver"
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
        account_id,
        context.state.signer_id.as_str(),
    )
    .await
    {
        Ok(gold_stats) if gold_stats.skipped_locked => {
            tracing::debug!(
                account_id,
                "public readiness projection nudge skipped gold lock"
            );
        }
        Ok(gold_stats) => {
            tracing::debug!(
                account_id,
                rows_projected = gold_stats.rows_projected,
                rows_deleted = gold_stats.rows_deleted,
                errors_written = gold_stats.errors_written,
                "public readiness projection nudge finished gold"
            );
            if gold_stats.rows_projected > 0 || gold_stats.rows_deleted > 0 {
                context
                    .state
                    .publish_treasury_projection_updated(account_id.to_string())
                    .await;
            }

            // First verification is event-driven: a freshly projected
            // treasury gets its gate immediately (charts + ledger-fed
            // dashboard in the same pass), instead of waiting for the next
            // projection cycle. No-op for already-gated accounts.
            let verifier = BalanceVerifier::new(
                &context.state.db_pool,
                &context.state.archival_network,
                context
                    .state
                    .env_vars
                    .public_native_verification_tolerance_near,
            );
            match verifier.nudge_account_gate(account_id).await {
                Ok(true) => {
                    tracing::info!(account_id, "first balance verification passed via nudge");
                }
                Ok(false) => {}
                Err(error) => {
                    tracing::warn!(
                        account_id,
                        %error,
                        "verification nudge failed; retried on the next ledger change"
                    );
                }
            }
        }
        Err(error) => {
            tracing::warn!(
                account_id,
                error = %error,
                "public readiness projection nudge failed gold"
            );
        }
    }

    Ok(())
}

async fn handle_readiness_job(
    job: PublicHistoryJob,
    context: Data<JobContext>,
) -> Result<(), BoxDynError> {
    let PublicHistoryJob::RefreshReadiness { account_id, .. } = job else {
        return Ok(());
    };

    let (touched, inserted, changed) = run_readiness_refresh(&context.state, &account_id)
        .await
        .map_err(|(status, message)| {
            public_history_error(format!(
                "public readiness refresh failed ({status}): {message}"
            ))
        })?;
    tracing::info!(
        account_id,
        rows_touched = touched,
        rows_inserted = inserted,
        rows_changed = changed,
        "public readiness refresh job finished"
    );

    project_and_verify_readiness(&context, &account_id).await
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
        // `apalis-postgres` constructs its PgListener with `expect`/`unwrap`,
        // so pool exhaustion or an initial LISTEN failure can panic instead of
        // returning WorkerError. Contain that dependency panic here so the
        // targeted supervisor rebuilds only this consumer with normal backoff.
        let result = std::panic::AssertUnwindSafe(run_worker(shutdown.clone()))
            .catch_unwind()
            .await;

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
            Ok(Err(error)) if error.to_string().contains("WORKER_ALREADY_EXISTS") => {
                tracing::warn!(
                    worker = worker_name,
                    error = %error,
                    attempt,
                    retry_delay_ms = retry_delay.as_millis(),
                    "public history consumer already active; retrying with backoff"
                );
            }
            Ok(Err(error)) => {
                tracing::error!(
                    worker = worker_name,
                    error = %error,
                    attempt,
                    retry_delay_ms = retry_delay.as_millis(),
                    "public history consumer exited unexpectedly; retrying with backoff"
                );
            }
            Ok(Ok(())) => {
                tracing::error!(
                    worker = worker_name,
                    attempt,
                    retry_delay_ms = retry_delay.as_millis(),
                    "public history consumer stopped unexpectedly; retrying with backoff"
                );
            }
            Err(payload) => {
                let panic_message = payload
                    .downcast_ref::<&str>()
                    .copied()
                    .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
                    .unwrap_or("non-string panic payload");
                tracing::error!(
                    worker = worker_name,
                    panic = panic_message,
                    attempt,
                    retry_delay_ms = retry_delay.as_millis(),
                    "public history consumer panicked; retrying with backoff"
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
    wake_hub: JobWakeHub,
) -> Vec<PublicHistorySupervisorFuture> {
    let config = ConsumerSupervisorConfig::production();
    let specs = public_history_queue_specs();
    let latest_spec = specs[0].clone();
    let readiness_spec = specs[1].clone();
    let backfill_spec = specs[2].clone();
    let latest_state = state.clone();
    let latest_shutdown = shutdown.clone();
    let latest_wake_hub = wake_hub.clone();
    let latest = public_history_supervisor_future(
        PUBLIC_HISTORY_LATEST_WORKER,
        latest_shutdown,
        config,
        move |worker_shutdown| {
            let latest_state = latest_state.clone();
            let latest_spec = latest_spec.clone();
            let wake_hub = latest_wake_hub.clone();
            Box::pin(async move {
                let storage = worker_storage(&latest_state.db_pool, &latest_spec, &wake_hub);
                WorkerBuilder::new(PUBLIC_HISTORY_LATEST_WORKER)
                    .backend(storage)
                    .data(JobContext::new(latest_state))
                    .timeout(latest_spec.handler_timeout)
                    .catch_panic()
                    .layer(SentryLayer::new())
                    .layer(crate::jobs::job_trace_layer())
                    .concurrency(latest_spec.concurrency)
                    .build(handle_latest_job)
                    .run_until(async move {
                        worker_shutdown.cancelled().await;
                        Ok::<(), WorkerError>(())
                    })
                    .await
            })
        },
    );

    let readiness_state = state.clone();
    let readiness_shutdown = shutdown.clone();
    let readiness_wake_hub = wake_hub.clone();
    let readiness = public_history_supervisor_future(
        PUBLIC_HISTORY_READINESS_WORKER,
        readiness_shutdown,
        config,
        move |worker_shutdown| {
            let readiness_state = readiness_state.clone();
            let readiness_spec = readiness_spec.clone();
            let wake_hub = readiness_wake_hub.clone();
            Box::pin(async move {
                let storage = worker_storage(&readiness_state.db_pool, &readiness_spec, &wake_hub);
                WorkerBuilder::new(PUBLIC_HISTORY_READINESS_WORKER)
                    .backend(storage)
                    .data(JobContext::new(readiness_state))
                    .timeout(readiness_spec.handler_timeout)
                    .catch_panic()
                    .layer(SentryLayer::new())
                    .layer(crate::jobs::job_trace_layer())
                    .concurrency(readiness_spec.concurrency)
                    .build(handle_readiness_job)
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
            let backfill_spec = backfill_spec.clone();
            let wake_hub = wake_hub.clone();
            Box::pin(async move {
                let storage = worker_storage(&state.db_pool, &backfill_spec, &wake_hub);
                WorkerBuilder::new(PUBLIC_HISTORY_BACKFILL_WORKER)
                    .backend(storage)
                    .data(JobContext::new(state))
                    .timeout(backfill_spec.handler_timeout)
                    .catch_panic()
                    .layer(SentryLayer::new())
                    .layer(crate::jobs::job_trace_layer())
                    .concurrency(backfill_spec.concurrency)
                    .build(handle_backfill_job)
                    .run_until(async move {
                        worker_shutdown.cancelled().await;
                        Ok::<(), WorkerError>(())
                    })
                    .await
            })
        },
    );

    vec![latest, readiness, backfill]
}

/// The three queue storages, typed for apalis-board registration.
pub(crate) fn board_storages(pool: PgPool) -> Vec<PostgresStorage<PublicHistoryJob>> {
    vec![
        latest_storage(pool.clone()),
        readiness_storage(pool.clone()),
        backfill_storage(pool),
    ]
}

#[cfg(test)]
mod supervisor_tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;

    async fn record_claim_and_stop(
        _job: PublicHistoryJob,
        claimed: Data<tokio::sync::mpsc::UnboundedSender<Instant>>,
        worker: WorkerContext,
    ) -> Result<(), BoxDynError> {
        let _ = claimed.send(Instant::now());
        worker.stop()?;
        Ok(())
    }

    #[derive(Clone)]
    struct ClaimRecorder {
        count: Arc<AtomicUsize>,
        claimed: tokio::sync::mpsc::UnboundedSender<()>,
    }

    async fn record_claim(
        _job: PublicHistoryJob,
        recorder: Data<ClaimRecorder>,
    ) -> Result<(), BoxDynError> {
        recorder.count.fetch_add(1, Ordering::SeqCst);
        let _ = recorder.claimed.send(());
        Ok(())
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn notify_wake_claims_after_idle_within_one_second(pool: PgPool) -> sqlx::Result<()> {
        crate::jobs::setup_apalis(&pool).await?;
        super::super::postgres::setup_public_history_jobs(&pool).await?;

        let wake_hub = JobWakeHub::default();
        let (claimed_tx, mut claimed_rx) = tokio::sync::mpsc::unbounded_channel::<Instant>();
        let spec = public_history_queue_specs().remove(0);
        let storage = worker_storage(&pool, &spec, &wake_hub);
        let worker = WorkerBuilder::new("public-history-notify-latency-test")
            .backend(storage)
            .data(claimed_tx)
            .concurrency(1)
            .build(record_claim_and_stop);
        let worker_task = tokio::spawn(worker.run());

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let storage_name: Option<String> =
                    sqlx::query_scalar("SELECT storage_name FROM apalis.workers WHERE id = $1")
                        .bind("public-history-notify-latency-test")
                        .fetch_optional(&pool)
                        .await
                        .expect("worker registration query");
                if storage_name.as_deref() == Some("TrezuSteadyPostgresStorage") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("notify worker should register");

        // Let repeated empty polls prove that the queue remains responsive
        // after an idle period, then deliver the same namespace wake the
        // shared LISTEN connection would fan out.
        tokio::time::sleep(Duration::from_secs(3)).await;
        let inserted_at = Instant::now();
        assert!(
            enqueue_latest_refresh_job(
                &pool,
                "notify-latency.near".to_string(),
                PublicHistorySource::NearblocksFt,
                42,
                Some("notify-latency-tx".to_string()),
                1,
            )
            .await?
        );
        wake_hub.wake_queue(PUBLIC_HISTORY_LATEST_NAMESPACE);
        let claimed_at = tokio::time::timeout(Duration::from_secs(2), claimed_rx.recv())
            .await
            .expect("notify-backed claim should complete within one second")
            .expect("claim timestamp sender should remain open");
        assert!(
            claimed_at.duration_since(inserted_at) < Duration::from_secs(1),
            "notification claim exceeded one second"
        );

        let worker_result = tokio::time::timeout(Duration::from_secs(2), worker_task)
            .await
            .expect("worker should stop after the claim")
            .expect("worker task should not panic");
        assert!(worker_result.is_ok());
        Ok(())
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn steady_poll_claims_a_missed_notification_within_two_seconds(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        crate::jobs::setup_apalis(&pool).await?;
        super::super::postgres::setup_public_history_jobs(&pool).await?;

        let (claimed_tx, mut claimed_rx) = tokio::sync::mpsc::unbounded_channel::<Instant>();
        let wake_hub = JobWakeHub::default();
        let spec = public_history_queue_specs().remove(0);
        let storage = worker_storage(&pool, &spec, &wake_hub);
        let worker = WorkerBuilder::new("public-history-recovery-latency-test")
            .backend(storage)
            .data(claimed_tx)
            .concurrency(1)
            .build(record_claim_and_stop);
        let worker_task = tokio::spawn(worker.run());

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let registered: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM apalis.workers WHERE id = $1)",
                )
                .bind("public-history-recovery-latency-test")
                .fetch_one(&pool)
                .await
                .expect("worker registration query");
                if registered {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("notify worker should register");

        // Suppress the insert trigger to model a listener gap. The fixed poll
        // is the correctness path and must cap recovery at roughly one tick.
        tokio::time::sleep(Duration::from_secs(3)).await;
        sqlx::query("ALTER TABLE apalis.jobs DISABLE TRIGGER notify_workers")
            .execute(&pool)
            .await?;
        let inserted = enqueue_latest_refresh_job(
            &pool,
            "recovery-latency.near".to_string(),
            PublicHistorySource::NearblocksFt,
            43,
            Some("recovery-latency-tx".to_string()),
            1,
        )
        .await;
        sqlx::query("ALTER TABLE apalis.jobs ENABLE TRIGGER notify_workers")
            .execute(&pool)
            .await?;
        assert!(inserted?);

        let recovery_started_at = Instant::now();
        let claimed_at = tokio::time::timeout(Duration::from_secs(2), claimed_rx.recv())
            .await
            .expect("fixed polling should recover within two seconds")
            .expect("claim timestamp sender should remain open");
        assert!(claimed_at.duration_since(recovery_started_at) < Duration::from_secs(2));

        let worker_result = tokio::time::timeout(Duration::from_secs(2), worker_task)
            .await
            .expect("worker should stop after the recovered claim")
            .expect("worker task should not panic");
        assert!(worker_result.is_ok());
        Ok(())
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn duplicate_recovery_notifications_execute_the_token_once(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        crate::jobs::setup_apalis(&pool).await?;
        super::super::postgres::setup_public_history_jobs(&pool).await?;

        let count = Arc::new(AtomicUsize::new(0));
        let (claimed_tx, mut claimed_rx) = tokio::sync::mpsc::unbounded_channel();
        let recorder = ClaimRecorder {
            count: count.clone(),
            claimed: claimed_tx,
        };
        let shutdown = CancellationToken::new();
        let worker_shutdown = shutdown.clone();
        let wake_hub = JobWakeHub::default();
        let spec = public_history_queue_specs().remove(0);
        let worker = WorkerBuilder::new("public-history-duplicate-notify-test")
            .backend(worker_storage(&pool, &spec, &wake_hub))
            .data(recorder)
            .concurrency(1)
            .build(record_claim);
        let worker_task = tokio::spawn(worker.run_until(async move {
            worker_shutdown.cancelled().await;
            Ok::<(), WorkerError>(())
        }));

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let registered: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM apalis.workers WHERE id = $1)",
                )
                .bind("public-history-duplicate-notify-test")
                .fetch_one(&pool)
                .await
                .expect("worker registration query");
                if registered {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("notify worker should register");

        tokio::time::sleep(Duration::from_secs(3)).await;
        sqlx::query("ALTER TABLE apalis.jobs DISABLE TRIGGER notify_workers")
            .execute(&pool)
            .await?;
        let inserted = enqueue_latest_refresh_job(
            &pool,
            "duplicate-notify.near".to_string(),
            PublicHistorySource::NearblocksFt,
            44,
            Some("duplicate-notify-tx".to_string()),
            1,
        )
        .await;
        sqlx::query("ALTER TABLE apalis.jobs ENABLE TRIGGER notify_workers")
            .execute(&pool)
            .await?;
        assert!(inserted?);

        // Hold the token row while both notifications are sent, ensuring the
        // listener observes two rings before either can finish claiming it.
        let mut blocker = pool.begin().await?;
        let _: String = sqlx::query_scalar(
            r#"
            SELECT id
            FROM apalis.jobs
            WHERE job_type = 'public_history_latest'
              AND metadata->>'job_key' = 'latest:duplicate-notify.near:nearblocks_ft'
            FOR UPDATE
            "#,
        )
        .fetch_one(&mut *blocker)
        .await?;
        wake_hub.wake_queue(PUBLIC_HISTORY_LATEST_NAMESPACE);
        wake_hub.wake_queue(PUBLIC_HISTORY_LATEST_NAMESPACE);
        blocker.commit().await?;

        tokio::time::timeout(Duration::from_secs(2), claimed_rx.recv())
            .await
            .expect("duplicated notification should still claim the token")
            .expect("claim recorder should remain open");
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(count.load(Ordering::SeqCst), 1);

        shutdown.cancel();
        let worker_result = tokio::time::timeout(Duration::from_secs(2), worker_task)
            .await
            .expect("worker should stop after shutdown")
            .expect("worker task should not panic");
        assert!(worker_result.is_ok());
        Ok(())
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn realtime_and_readiness_tokens_use_isolated_single_shot_queues(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        crate::jobs::setup_apalis(&pool).await?;
        super::super::postgres::setup_public_history_jobs(&pool).await?;

        let (valid, predicate): (bool, Option<String>) = sqlx::query_as(
            r#"
            SELECT index.indisvalid,
                   pg_get_expr(index.indpred, index.indrelid)
            FROM pg_index index
            JOIN pg_class index_class
              ON index_class.oid = index.indexrelid
            JOIN pg_namespace namespace
              ON namespace.oid = index_class.relnamespace
            WHERE namespace.nspname = 'apalis'
              AND index_class.relname = 'idx_apalis_jobs_claimable_v2'
            "#,
        )
        .fetch_one(&pool)
        .await?;
        assert!(valid);
        let predicate = predicate.expect("claim index must be partial");
        assert!(predicate.contains("Pending"));
        assert!(predicate.contains("Failed"));
        assert!(predicate.contains("max_attempts"));

        assert!(
            enqueue_latest_refresh_job(
                &pool,
                "queue-isolation.near".to_string(),
                PublicHistorySource::NearblocksFt,
                100,
                Some("tx".to_string()),
                1,
            )
            .await?
        );
        assert!(enqueue_readiness_refresh_job(&pool, "queue-isolation.near".to_string()).await?);
        assert!(!enqueue_readiness_refresh_job(&pool, "queue-isolation.near".to_string()).await?);

        let rows: Vec<(String, i32)> = sqlx::query_as(
            r#"
            SELECT job_type, max_attempts
            FROM apalis.jobs
            WHERE job_type IN ($1, $2)
            ORDER BY job_type
            "#,
        )
        .bind(PUBLIC_HISTORY_LATEST_NAMESPACE)
        .bind(PUBLIC_HISTORY_READINESS_NAMESPACE)
        .fetch_all(&pool)
        .await?;
        assert_eq!(
            rows,
            vec![
                (PUBLIC_HISTORY_LATEST_NAMESPACE.to_string(), 1),
                (PUBLIC_HISTORY_READINESS_NAMESPACE.to_string(), 1),
            ]
        );
        Ok(())
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn backfill_budget_caps_each_account_source_per_day(pool: PgPool) -> sqlx::Result<()> {
        let account_id = "backfill-budget.near";
        for _ in 0..BACKFILL_MAX_PAGES_PER_ACCOUNT_SOURCE_PER_DAY {
            assert!(
                consume_backfill_budget(&pool, account_id, PublicHistorySource::NearblocksFt)
                    .await?
            );
        }
        assert!(
            !consume_backfill_budget(&pool, account_id, PublicHistorySource::NearblocksFt).await?
        );
        assert!(
            consume_backfill_budget(&pool, account_id, PublicHistorySource::NearblocksMt).await?
        );
        Ok(())
    }

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

        assert_eq!(seconds, vec![1, 2, 4, 8, 16, 30, 30, 30]);
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

    async fn panic_worker() -> Result<(), WorkerError> {
        panic!("listener initialization panic")
    }

    #[tokio::test]
    async fn worker_panic_is_contained_and_retried() {
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
                "panic-test-worker",
                supervisor_shutdown,
                config,
                move |worker_shutdown| {
                    let call = runner_calls.fetch_add(1, Ordering::SeqCst);
                    if call == 0 {
                        Box::pin(panic_worker())
                    } else {
                        Box::pin(async move {
                            worker_shutdown.cancelled().await;
                            Ok(())
                        })
                    }
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
        .expect("supervisor should retry after a worker panic");

        shutdown.cancel();
        supervisor.await.expect("supervisor task should not panic");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
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
