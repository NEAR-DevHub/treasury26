use std::sync::Arc;

use apalis::layers::WorkerBuilderExt;
use apalis::prelude::*;
use apalis_core::backend::TaskSinkError;
use apalis_core::task::Task;
use apalis_postgres::{Config, PgContext, PgTask, PostgresStorage};
use axum::http::StatusCode;
use sqlx::PgPool;

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

pub(crate) const JOB_CONCURRENCY: usize = 4;
pub(crate) const BACKFILL_JOB_CONCURRENCY: usize = 4;
pub(crate) const BACKFILL_MAX_PAGES_PER_ACCOUNT_PER_DAY: i32 = 20;

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

/// Max pages a single latest refresh may walk toward the watermark
/// (~125 events with 25-item pages) before giving up.
const LATEST_REFRESH_MAX_PAGES: usize = 5;

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
    let mut pages_fetched = 0usize;
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
        pages_fetched += 1;

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
        if pages_fetched >= LATEST_REFRESH_MAX_PAGES {
            tracing::warn!(
                account_id = account_id,
                source = %source,
                pages_fetched = pages_fetched,
                watermark = ?watermark,
                "stopping public latest drain at page cap before reaching the block-height watermark; events between them are skipped this pass"
            );
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

pub(crate) fn spawn_public_history_job_workers(state: Arc<AppState>) {
    let latest_state = state.clone();
    tokio::spawn(async move {
        let storage = latest_storage(latest_state.db_pool.clone());
        let worker = WorkerBuilder::new("public-history-latest")
            .backend(storage)
            .data(JobContext::new(latest_state))
            .enable_tracing()
            .concurrency(JOB_CONCURRENCY)
            .build(handle_latest_job);
        let result = worker.run().await;
        if let Err(error) = result {
            tracing::error!(error = %error, "public history latest worker stopped");
        }
    });

    tokio::spawn(async move {
        let storage = backfill_storage(state.db_pool.clone());
        let worker = WorkerBuilder::new("public-history-backfill")
            .backend(storage)
            .data(JobContext::new(state))
            .enable_tracing()
            .concurrency(BACKFILL_JOB_CONCURRENCY)
            .build(handle_backfill_job);
        let result = worker.run().await;
        if let Err(error) = result {
            tracing::error!(error = %error, "public history backfill worker stopped");
        }
    });
}
