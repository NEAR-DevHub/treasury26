use std::collections::HashSet;
use std::sync::Arc;

use apalis::prelude::*;
use apalis_sql::postgres::PostgresStorage;
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
    save_public_backfill_progress, save_public_latest_page_cursor, upsert_public_history_events,
};
use crate::handlers::public_history::proposals::linker::link_public_proposal_receipts;
use crate::jobs::context::JobContext;
use crate::jobs::postgres::{active_job_exists, is_unique_violation_on, storage};

use super::postgres::{
    PUBLIC_HISTORY_BACKFILL_NAMESPACE, PUBLIC_HISTORY_INFLIGHT_INDEX, PUBLIC_HISTORY_JOB_KEY_FIELD,
    PUBLIC_HISTORY_LATEST_NAMESPACE,
};

pub(crate) const JOB_CONCURRENCY: usize = 4;
pub(crate) const BACKFILL_JOB_CONCURRENCY: usize = 4;
pub(crate) const BACKFILL_MAX_PAGES_PER_ACCOUNT_PER_DAY: i32 = 20;

type PublicHistoryStorage = PostgresStorage<PublicHistoryJob>;

fn public_history_error(message: impl Into<String>) -> Error {
    Error::Failed(Arc::new(Box::new(std::io::Error::new(
        std::io::ErrorKind::Other,
        message.into(),
    ))))
}

fn latest_storage(pool: PgPool) -> PublicHistoryStorage {
    storage(
        pool,
        PUBLIC_HISTORY_LATEST_NAMESPACE,
        JOB_CONCURRENCY.max(1),
    )
}

fn backfill_storage(pool: PgPool) -> PublicHistoryStorage {
    storage(
        pool,
        PUBLIC_HISTORY_BACKFILL_NAMESPACE,
        BACKFILL_JOB_CONCURRENCY.max(1),
    )
}

async fn push_job(
    storage: &mut PublicHistoryStorage,
    job: PublicHistoryJob,
) -> Result<bool, sqlx::Error> {
    match storage.push(job).await {
        Ok(_) => Ok(true),
        Err(error) if is_unique_violation_on(&error, PUBLIC_HISTORY_INFLIGHT_INDEX) => Ok(false),
        Err(error) => Err(error),
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
    if active_job_exists(
        pool,
        PUBLIC_HISTORY_BACKFILL_NAMESPACE,
        PUBLIC_HISTORY_JOB_KEY_FIELD,
        job.job_key(),
    )
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
    let previous_forward_cursor = load_public_history_cursor(&state.db_pool, account_id, source)
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("public cursor load failed: {}", error),
            )
        })?
        .and_then(|cursor| cursor.forward_cursor);

    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();
    let mut totals = (0, 0, 0);

    loop {
        if let Some(cursor_value) = cursor.as_deref()
            && !seen_cursors.insert(cursor_value.to_string())
        {
            tracing::warn!(
                account_id = account_id,
                source = %source,
                cursor = cursor_value,
                "stopping public latest drain because NearBlocks repeated a cursor"
            );
            break;
        }

        let page = fetch_source_page(
            state,
            account_id,
            source,
            cursor.as_deref(),
            NearblocksPriority::Latest,
        )
        .await?;
        let next_cursor = page.next_cursor.clone();
        let page_is_empty = page.events.is_empty();
        let reached_previous_cursor = next_cursor.as_deref() == previous_forward_cursor.as_deref()
            && previous_forward_cursor.is_some();
        let no_existing_watermark = previous_forward_cursor.is_none();

        let (touched, inserted, changed) = ingest_page(state, source, &page.events).await?;
        totals.0 += touched;
        totals.1 += inserted;
        totals.2 += changed;

        save_public_latest_page_cursor(&state.db_pool, account_id, source, next_cursor.as_deref())
            .await
            .map_err(|error| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("public cursor save failed: {}", error),
                )
            })?;

        let (height, timestamp) = latest_seen(&page);
        record_public_history_poll_result(
            &state.db_pool,
            account_id,
            source,
            inserted > 0 || changed > 0,
            height,
            timestamp.as_ref(),
        )
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("public poll schedule update failed: {}", error),
            )
        })?;

        if page_is_empty
            || next_cursor.is_none()
            || reached_previous_cursor
            || (no_existing_watermark && cursor.is_none())
        {
            break;
        }

        cursor = next_cursor;
    }

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

    let initial_forward_cursor = if cursor.is_none() {
        next_cursor.as_deref()
    } else {
        None
    };
    let backfill_done = page_is_empty || next_cursor.is_none();
    save_public_backfill_progress(
        &state.db_pool,
        account_id,
        source,
        next_cursor.as_deref(),
        initial_forward_cursor,
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

async fn handle_latest_job(job: PublicHistoryJob, context: Data<JobContext>) -> Result<(), Error> {
    let PublicHistoryJob::RefreshLatest {
        account_id, source, ..
    } = job
    else {
        return Ok(());
    };

    run_latest_refresh(&context.state, &account_id, source)
        .await
        .map(|(touched, inserted, changed)| {
            tracing::info!(
                account_id = account_id,
                source = %source,
                rows_touched = touched,
                rows_inserted = inserted,
                rows_changed = changed,
                "public latest refresh job finished"
            );
        })
        .map_err(|(status, message)| {
            public_history_error(format!(
                "public latest refresh failed ({}): {}",
                status, message
            ))
        })
}

async fn handle_backfill_job(
    job: PublicHistoryJob,
    context: Data<JobContext>,
) -> Result<(), Error> {
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
        let result = Monitor::new()
            .register(
                WorkerBuilder::new("public-history-latest")
                    .concurrency(JOB_CONCURRENCY)
                    .data(JobContext::new(latest_state))
                    .backend(storage)
                    .build_fn(handle_latest_job),
            )
            .run()
            .await;
        if let Err(error) = result {
            tracing::error!(error = %error, "public history latest worker stopped");
        }
    });

    tokio::spawn(async move {
        let storage = backfill_storage(state.db_pool.clone());
        let result = Monitor::new()
            .register(
                WorkerBuilder::new("public-history-backfill")
                    .concurrency(BACKFILL_JOB_CONCURRENCY)
                    .data(JobContext::new(state))
                    .backend(storage)
                    .build_fn(handle_backfill_job),
            )
            .run()
            .await;
        if let Err(error) = result {
            tracing::error!(error = %error, "public history backfill worker stopped");
        }
    });
}
