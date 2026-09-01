use chrono::{DateTime, Utc};
use serde::Deserialize;
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};

use super::postgres::{
    PUBLIC_HISTORY_BACKFILL_NAMESPACE, PUBLIC_HISTORY_LATEST_NAMESPACE,
    PUBLIC_HISTORY_READINESS_NAMESPACE, count_active_public_history_jobs_with_prefix,
};
use super::worker::{
    enqueue_backfill_page_job, enqueue_latest_refresh_job, enqueue_readiness_refresh_job,
    job_concurrency,
};
use crate::AppState;
use crate::handlers::balance_changes::confidential_enrichment::{
    extract_sign_call_from_logs, mark_confidential_intent_submitted,
};
use crate::handlers::balance_changes::goldsky_enrichment::{
    decode_success_value_u64, handle_confidential_add_proposal,
};
use crate::handlers::intents::confidential::bronze::mark_confidential_history_activity_due;
use crate::handlers::intents::confidential::gold::history_events::refresh_gold_metadata_for_intent;
use crate::handlers::intents::confidential::link_intent_to_history_event;
use crate::handlers::public_history::bronze::store::{
    PublicHistorySource, load_ready_latest_demands, oldest_ready_latest_demand_age_seconds,
    ready_latest_demand_count, upsert_latest_demand,
};
use crate::handlers::public_history::verification::worker::{
    FAILED_RETRY_AFTER_HOURS, FAILED_RETRY_MIN_MINUTES,
};
use crate::services::goldsky_cursor::{load_goldsky_cursor, save_goldsky_cursor};

const SCHEDULER_BATCH_SIZE: i64 = 2_000;
const SCHEDULER_MAX_BATCHES: usize = 5;
/// Backfill pages in flight at once across all accounts and sources.
const BACKFILL_MAX_ACTIVE_JOBS: usize = 10;
const CONSUMER_NAME: &str = "public_history_scheduler";
const LATEST_JOB_KEY_PREFIX: &str = "latest:";
const PUBLIC_HISTORY_RENOTIFY_BATCH: i64 = 256;
const PUBLIC_HISTORY_RENOTIFY_ALERT_AGE_SECONDS: f64 = 10.0;
/// Realtime objective: the oldest ready demand should dispatch well inside
/// this window during healthy operation.
const LATEST_DEMAND_ALERT_AGE_SECONDS: f64 = 120.0;
/// Readiness refreshes in flight at once — maintenance uses spare capacity
/// and must never flood the queue ahead of transaction-triggered work.
const READINESS_MAX_IN_FLIGHT: usize = 1;
/// Freshness window on `latest_refresh_at` before an unverified account
/// triggers another priority drain of the NearBlocks sources.
pub const SOURCE_REFRESH_MAX_AGE_MINUTES: i64 = 15;

#[derive(Debug, Default)]
pub(crate) struct PublicHistoryDetectorStats {
    pub outcomes_seen: usize,
    pub batches_processed: usize,
    pub latest_enqueued: usize,
    pub confidential_marked: usize,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct IndexedDaoOutcome {
    id: String,
    executor_id: String,
    logs: Option<String>,
    status: Option<String>,
    transaction_hash: Option<String>,
    signer_id: Option<String>,
    receiver_id: Option<String>,
    trigger_block_height: i64,
    trigger_block_timestamp: i64,
}

#[derive(Debug, Deserialize)]
struct EventJson {
    standard: String,
    #[serde(default)]
    event: String,
    #[serde(default)]
    data: Vec<serde_json::Value>,
}

#[derive(Debug, Clone)]
struct RefreshCandidate {
    account_id: String,
    source: PublicHistorySource,
    trigger_block_height: i64,
    trigger_transaction_hash: Option<String>,
}

async fn load_monitored_accounts(pool: &PgPool) -> Result<HashSet<String>, sqlx::Error> {
    let accounts: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT account_id
        FROM monitored_accounts
        WHERE enabled = true
          AND history_ingestion_paused_at IS NULL
          AND COALESCE(is_confidential_account, false) = false
        "#,
    )
    .fetch_all(pool)
    .await?;
    Ok(accounts.into_iter().collect())
}

/// The legacy goldsky-enrichment consumer's confidential proposal handling,
/// ported to this detector because it runs at the sink tip (no per-outcome
/// RPC): `add_proposal` SuccessValues attach `proposal_id` to the matching
/// intent, and `v1.signer` sign logs stamp the execution facts. Returns the
/// DAO touched so the caller pulls its 1Click poll forward.
async fn process_confidential_proposal_signals(
    state: &AppState,
    confidential: &HashSet<String>,
    outcome: &IndexedDaoOutcome,
) -> Option<String> {
    let block_time = DateTime::from_timestamp_millis(outcome.trigger_block_timestamp)?;

    if outcome.executor_id == "v1.signer" {
        let call = extract_sign_call_from_logs(outcome.logs.as_deref()?)?;
        if !confidential.contains(&call.dao_id) {
            return None;
        }
        if let Err(error) = mark_confidential_intent_submitted(
            &state.db_pool,
            &call.dao_id,
            &call.payload_hash,
            block_time,
            Some(outcome.trigger_block_height),
            outcome.transaction_hash.as_deref(),
        )
        .await
        {
            tracing::warn!(
                dao_id = call.dao_id,
                %error,
                "confidential intent execution stamp failed"
            );
            return None;
        }
        match link_intent_to_history_event(&state.db_pool, &call.dao_id, &call.payload_hash).await {
            Ok(_) => {}
            Err(error) => tracing::warn!(
                dao_id = call.dao_id,
                %error,
                "confidential intent history link failed"
            ),
        }
        if let Err(error) =
            refresh_gold_metadata_for_intent(&state.db_pool, &call.dao_id, &call.payload_hash).await
        {
            tracing::warn!(
                dao_id = call.dao_id,
                %error,
                "confidential gold metadata refresh failed"
            );
        }
        return Some(call.dao_id);
    }

    if confidential.contains(&outcome.executor_id)
        && let Some(status) = outcome.status.as_deref()
        && let Some(proposal_id) = decode_success_value_u64(status)
    {
        match handle_confidential_add_proposal(
            &state.db_pool,
            &state.network,
            &outcome.executor_id,
            proposal_id,
            block_time,
        )
        .await
        {
            Ok(_) => return Some(outcome.executor_id.clone()),
            Err(error) => tracing::warn!(
                dao_id = outcome.executor_id,
                proposal_id,
                %error,
                "confidential proposal linkage failed"
            ),
        }
    }

    None
}

/// Confidential DAOs get no public-history refresh jobs, but an outcome
/// touching one is the fastest settlement signal we have — it pulls the
/// 1Click history poll forward instead.
async fn load_confidential_accounts(pool: &PgPool) -> Result<HashSet<String>, sqlx::Error> {
    let accounts: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT account_id
        FROM monitored_accounts
        WHERE enabled = true
          AND is_confidential_account = true
        "#,
    )
    .fetch_all(pool)
    .await?;
    Ok(accounts.into_iter().collect())
}

fn add_candidate(
    candidates: &mut Vec<RefreshCandidate>,
    monitored: &HashSet<String>,
    account_id: Option<&str>,
    source: PublicHistorySource,
    outcome: &IndexedDaoOutcome,
) {
    let Some(account_id) = account_id else {
        return;
    };
    if !monitored.contains(account_id) {
        return;
    }
    candidates.push(RefreshCandidate {
        account_id: account_id.to_string(),
        source,
        trigger_block_height: outcome.trigger_block_height,
        trigger_transaction_hash: outcome.transaction_hash.clone(),
    });
}

fn classify_event_json(
    event: &EventJson,
    monitored: &HashSet<String>,
    outcome: &IndexedDaoOutcome,
    candidates: &mut Vec<RefreshCandidate>,
) {
    match event.standard.as_str() {
        "nep141" => {
            for datum in &event.data {
                match event.event.as_str() {
                    "ft_transfer" => {
                        add_candidate(
                            candidates,
                            monitored,
                            datum.get("old_owner_id").and_then(|value| value.as_str()),
                            PublicHistorySource::NearblocksFt,
                            outcome,
                        );
                        add_candidate(
                            candidates,
                            monitored,
                            datum.get("new_owner_id").and_then(|value| value.as_str()),
                            PublicHistorySource::NearblocksFt,
                            outcome,
                        );
                    }
                    "ft_mint" | "ft_burn" => {
                        add_candidate(
                            candidates,
                            monitored,
                            datum.get("owner_id").and_then(|value| value.as_str()),
                            PublicHistorySource::NearblocksFt,
                            outcome,
                        );
                    }
                    _ => {}
                }
            }
        }
        "nep245" => {
            for datum in &event.data {
                match event.event.as_str() {
                    "mt_transfer" => {
                        add_candidate(
                            candidates,
                            monitored,
                            datum.get("old_owner_id").and_then(|value| value.as_str()),
                            PublicHistorySource::NearblocksMt,
                            outcome,
                        );
                        add_candidate(
                            candidates,
                            monitored,
                            datum.get("new_owner_id").and_then(|value| value.as_str()),
                            PublicHistorySource::NearblocksMt,
                            outcome,
                        );
                    }
                    "mt_mint" | "mt_burn" => {
                        add_candidate(
                            candidates,
                            monitored,
                            datum.get("owner_id").and_then(|value| value.as_str()),
                            PublicHistorySource::NearblocksMt,
                            outcome,
                        );
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

fn classify_plain_text_transfer(
    line: &str,
    monitored: &HashSet<String>,
    outcome: &IndexedDaoOutcome,
    candidates: &mut Vec<RefreshCandidate>,
) {
    if !line.starts_with("Transfer ") {
        return;
    }

    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 6 || parts[2] != "from" || parts[4] != "to" {
        return;
    }

    add_candidate(
        candidates,
        monitored,
        Some(parts[3]),
        PublicHistorySource::NearblocksFt,
        outcome,
    );
    add_candidate(
        candidates,
        monitored,
        Some(parts[5]),
        PublicHistorySource::NearblocksFt,
        outcome,
    );
}

fn classify_outcome(
    outcome: &IndexedDaoOutcome,
    monitored: &HashSet<String>,
) -> Vec<RefreshCandidate> {
    let mut candidates = Vec::new();

    if let Some(logs) = &outcome.logs {
        for line in logs.split('\n').flat_map(|line| line.split("\\n")) {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            if let Some(json_str) = line.strip_prefix("EVENT_JSON:") {
                if let Ok(event) = serde_json::from_str::<EventJson>(json_str) {
                    classify_event_json(&event, monitored, outcome, &mut candidates);
                }
            } else {
                classify_plain_text_transfer(line, monitored, outcome, &mut candidates);
            }
        }
    }

    add_candidate(
        &mut candidates,
        monitored,
        Some(outcome.executor_id.as_str()),
        PublicHistorySource::NearblocksReceipt,
        outcome,
    );
    add_candidate(
        &mut candidates,
        monitored,
        outcome.receiver_id.as_deref(),
        PublicHistorySource::NearblocksReceipt,
        outcome,
    );
    add_candidate(
        &mut candidates,
        monitored,
        outcome.signer_id.as_deref(),
        PublicHistorySource::NearblocksReceipt,
        outcome,
    );

    candidates
}

fn coalesce_candidates(
    candidates: impl IntoIterator<Item = RefreshCandidate>,
) -> Vec<RefreshCandidate> {
    let mut grouped: HashMap<(String, PublicHistorySource), RefreshCandidate> = HashMap::new();
    for candidate in candidates {
        let key = (candidate.account_id.clone(), candidate.source);
        match grouped.get_mut(&key) {
            Some(existing) if existing.trigger_block_height < candidate.trigger_block_height => {
                *existing = candidate;
            }
            Some(_) => {}
            None => {
                grouped.insert(key, candidate);
            }
        }
    }
    grouped.into_values().collect()
}

async fn fetch_next_outcomes(
    goldsky_pool: &PgPool,
    last_processed_block: i64,
    last_processed_id: &str,
) -> Result<Vec<IndexedDaoOutcome>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT
            id,
            executor_id,
            logs,
            status,
            transaction_hash,
            signer_id,
            receiver_id,
            trigger_block_height,
            trigger_block_timestamp
        FROM indexed_dao_outcomes
        WHERE (trigger_block_height, id) > ($1, $2)
        ORDER BY trigger_block_height ASC, id ASC
        LIMIT $3
        "#,
    )
    .bind(last_processed_block)
    .bind(last_processed_id)
    .bind(SCHEDULER_BATCH_SIZE)
    .fetch_all(goldsky_pool)
    .await
}

fn log_detection_latency(outcome: &IndexedDaoOutcome, now: DateTime<Utc>) {
    let Some(block_time) = DateTime::from_timestamp_millis(outcome.trigger_block_timestamp) else {
        tracing::warn!(
            block_height = outcome.trigger_block_height,
            trigger_block_timestamp = outcome.trigger_block_timestamp,
            "Goldsky outcome has an invalid trigger timestamp"
        );
        return;
    };

    tracing::info!(
        block_height = outcome.trigger_block_height,
        chain_to_detection_lag_ms = (now - block_time).num_milliseconds(),
        "public history Goldsky outcome batch detected"
    );
}

async fn tick_goldsky_scheduler(
    state: &AppState,
    goldsky_pool: &PgPool,
) -> Result<PublicHistoryDetectorStats, Box<dyn std::error::Error + Send + Sync>> {
    let mut cursor = load_goldsky_cursor(&state.db_pool, goldsky_pool, CONSUMER_NAME).await?;
    let monitored = load_monitored_accounts(&state.db_pool).await?;
    let confidential = load_confidential_accounts(&state.db_pool).await?;
    let mut stats = PublicHistoryDetectorStats::default();

    for _ in 0..SCHEDULER_MAX_BATCHES {
        let outcomes = fetch_next_outcomes(
            goldsky_pool,
            cursor.last_processed_block,
            &cursor.last_processed_id,
        )
        .await?;
        if outcomes.is_empty() {
            break;
        }

        let batch_size = outcomes.len();
        let mut all_candidates = Vec::new();
        let mut confidential_touched: HashSet<String> = HashSet::new();
        for outcome in &outcomes {
            all_candidates.extend(classify_outcome(outcome, &monitored));
            for candidate in classify_outcome(outcome, &confidential) {
                confidential_touched.insert(candidate.account_id);
            }
            if let Some(dao_id) =
                process_confidential_proposal_signals(state, &confidential, outcome).await
            {
                confidential_touched.insert(dao_id);
            }
        }

        // Pull the 1Click history poll forward for confidential DAOs this
        // batch touched; idempotent, so the legacy goldsky-enrichment
        // trigger coexisting is harmless.
        for account_id in confidential_touched {
            match mark_confidential_history_activity_due(&state.db_pool, &account_id).await {
                Ok(()) => stats.confidential_marked += 1,
                Err(error) => tracing::warn!(
                    account_id,
                    %error,
                    "cannot mark confidential history due from public detector"
                ),
            }
        }

        // Durable demand upsert instead of a direct job push: a trigger
        // arriving while a token job is pending or running bumps the demand
        // generation instead of being silently discarded; the dispatcher
        // keeps exactly one token per ready demand.
        for candidate in coalesce_candidates(all_candidates) {
            upsert_latest_demand(
                &state.db_pool,
                &candidate.account_id,
                candidate.source,
                candidate.trigger_block_height,
                candidate.trigger_transaction_hash.as_deref(),
            )
            .await?;
            stats.latest_enqueued += 1;
        }

        let latest = outcomes.last().expect("non-empty batch");
        save_goldsky_cursor(
            &state.db_pool,
            CONSUMER_NAME,
            &latest.id,
            latest.trigger_block_height,
        )
        .await?;
        cursor.last_processed_id.clone_from(&latest.id);
        cursor.last_processed_block = latest.trigger_block_height;

        stats.outcomes_seen += batch_size;
        stats.batches_processed += 1;
        log_detection_latency(latest, Utc::now());

        if batch_size < SCHEDULER_BATCH_SIZE as usize {
            break;
        }
    }

    Ok(stats)
}

/// One page per job, no chaining: the scheduler re-selects in oldest-updated
/// order every cycle, bounded globally so backfill can never crowd the
/// worker pool or the NearBlocks budget, while every incomplete
/// (account, source) still makes fair progress.
async fn seed_backfill_jobs(state: &AppState) -> Result<usize, sqlx::Error> {
    let active = count_active_public_history_jobs_with_prefix(
        &state.db_pool,
        PUBLIC_HISTORY_BACKFILL_NAMESPACE,
        "backfill:",
    )
    .await?;
    let mut available = BACKFILL_MAX_ACTIVE_JOBS.saturating_sub(active.max(0) as usize);
    if available == 0 {
        return Ok(0);
    }

    let mut enqueued = 0usize;
    let source_names = PublicHistorySource::all()
        .map(PublicHistorySource::as_str)
        .to_vec();
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        r#"
        SELECT ma.account_id, requested.source, c.backward_cursor
        FROM monitored_accounts ma
        CROSS JOIN UNNEST($1::text[]) AS requested(source)
        LEFT JOIN bronze_public_history_cursors c
          ON c.account_id = ma.account_id
         AND c.source = requested.source::public_history_source
        WHERE ma.enabled = true
          AND ma.history_ingestion_paused_at IS NULL
          AND COALESCE(ma.is_confidential_account, false) = false
          AND COALESCE(c.backfill_done, false) = false
        ORDER BY c.updated_at ASC NULLS FIRST, ma.account_id ASC
        LIMIT $2
        "#,
    )
    .bind(&source_names)
    .bind(BACKFILL_MAX_ACTIVE_JOBS as i64)
    .fetch_all(&state.db_pool)
    .await?;

    for (account_id, source, cursor) in rows {
        if available == 0 {
            break;
        }
        let Ok(source) = PublicHistorySource::from_db(&source) else {
            continue;
        };
        if enqueue_backfill_page_job(&state.db_pool, account_id, source, cursor).await? {
            enqueued += 1;
            available -= 1;
        }
    }
    Ok(enqueued)
}

/// Re-ring notifications that could have been lost while a listener was
/// starting or reconnecting. The query is deliberately bounded: the durable
/// demand dispatcher will continue invoking it once per second, while an
/// unexpected historical backlog cannot flood PostgreSQL's notify queue.
pub(super) async fn renotify_due_public_history_tokens(
    pool: &PgPool,
) -> Result<(i64, Option<f64>), sqlx::Error> {
    sqlx::query_as(
        r#"
        WITH due AS MATERIALIZED (
            SELECT id, job_type, run_at
            FROM apalis.jobs
            WHERE job_type IN ('public_history_latest', 'public_history_readiness')
              AND status = 'Pending'
              AND run_at <= NOW() - INTERVAL '1 second'
            ORDER BY run_at ASC, id ASC
            LIMIT $1
        )
        SELECT COUNT(pg_notify(
                   'apalis::job::insert',
                   json_build_object(
                       'job_type', job_type,
                       'id', id,
                       'run_at', run_at
                   )::text
               ))::bigint,
               EXTRACT(epoch FROM NOW() - MIN(run_at))::double precision
        FROM due
        "#,
    )
    .bind(PUBLIC_HISTORY_RENOTIFY_BATCH)
    .fetch_one(pool)
    .await
}

/// Keep only enough Apalis tokens to fill the latest worker's execution
/// slots. Excess work remains in the durable demand table, avoiding a second
/// 100-row queue whose claim state obscures the actual provider bottleneck.
async fn dispatch_latest_demands(state: &AppState) -> Result<usize, sqlx::Error> {
    // Recovery runs first so a failure while loading or inserting new demands
    // cannot suppress wakeups for tokens that already exist.
    let (renotified, oldest_pending_token_age_seconds) =
        renotify_due_public_history_tokens(&state.db_pool).await?;
    if renotified > 0 {
        if oldest_pending_token_age_seconds
            .is_some_and(|age| age > PUBLIC_HISTORY_RENOTIFY_ALERT_AGE_SECONDS)
        {
            tracing::warn!(
                renotified,
                oldest_pending_token_age_seconds,
                "re-notified stale public-history tokens"
            );
        } else {
            tracing::info!(
                renotified,
                oldest_pending_token_age_seconds,
                "re-notified unclaimed public-history tokens"
            );
        }
    }

    let active = count_active_public_history_jobs_with_prefix(
        &state.db_pool,
        PUBLIC_HISTORY_LATEST_NAMESPACE,
        LATEST_JOB_KEY_PREFIX,
    )
    .await?;
    let max_active = job_concurrency();
    let available = max_active.saturating_sub(active.max(0) as usize);

    let mut dispatched = 0usize;
    for demand in load_ready_latest_demands(&state.db_pool, available as i64).await? {
        if enqueue_latest_refresh_job(
            &state.db_pool,
            demand.account_id,
            demand.source,
            demand.trigger_block_height,
            demand.trigger_transaction_hash,
            demand.generation,
        )
        .await?
        {
            dispatched += 1;
        }
    }

    let ready_demands = ready_latest_demand_count(&state.db_pool).await?;
    let oldest_ready_demand_age_seconds =
        oldest_ready_latest_demand_age_seconds(&state.db_pool).await?;
    let completed_latest_tokens_last_minute: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM apalis.jobs
        WHERE job_type = $1
          AND status = 'Done'
          AND done_at >= NOW() - INTERVAL '1 minute'
        "#,
    )
    .bind(PUBLIC_HISTORY_LATEST_NAMESPACE)
    .fetch_one(&state.db_pool)
    .await?;
    tracing::debug!(
        active_latest_tokens = active,
        max_active_latest_tokens = max_active,
        available_latest_slots = available,
        dispatched,
        ready_demands,
        oldest_ready_demand_age_seconds,
        completed_latest_tokens_last_minute,
        "public-history latest dispatcher capacity"
    );

    if let Some(age) = oldest_ready_demand_age_seconds
        && age > LATEST_DEMAND_ALERT_AGE_SECONDS
    {
        tracing::warn!(
            oldest_ready_demand_age_seconds = age,
            "realtime refresh demand backlog exceeds latency objective"
        );
    }
    Ok(dispatched)
}

/// Accounts eligible for a verification-coverage refresh right now: fully
/// backfilled, gold projection ready, and the verifier can actually consume
/// fresh coverage — never gated, unverified, or a failed gate past its
/// cool-off (or with a ledger rebuilt since the failed check, floored at the
/// minimum retry interval). Ordered stalest-coverage-first so a
/// never-refreshed account can never be starved by re-refresh churn.
async fn load_readiness_candidates(pool: &PgPool, limit: i64) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        WITH sources AS (
            SELECT account_id,
                   COUNT(*) AS cursor_rows,
                   COUNT(*) FILTER (WHERE backfill_done) AS backfilled,
                   CASE
                       WHEN COUNT(latest_refresh_at) = 3
                           THEN MIN(latest_refresh_at)
                       ELSE NULL
                   END AS oldest_refresh
            FROM bronze_public_history_cursors
            WHERE source IN (
                'nearblocks_ft'::public_history_source,
                'nearblocks_mt'::public_history_source,
                'nearblocks_receipt'::public_history_source
            )
            GROUP BY account_id
        )
        SELECT ma.account_id
        FROM monitored_accounts ma
        JOIN sources s
          ON s.account_id = ma.account_id
         AND s.cursor_rows = 3
         AND s.backfilled = 3
        JOIN gold_public_history_cursors gold_cursor
          ON gold_cursor.account_id = ma.account_id
         AND gold_cursor.projection_ready_at IS NOT NULL
        LEFT JOIN public_balance_verification_cursors verification
          ON verification.account_id = ma.account_id
        LEFT JOIN silver_public_history_cursors silver
          ON silver.account_id = ma.account_id
        WHERE ma.enabled = true
          AND ma.history_ingestion_paused_at IS NULL
          AND COALESCE(ma.is_confidential_account, false) = false
          AND (
              verification.account_id IS NULL
              OR verification.status = 'unverified'
              OR (
                  verification.status = 'failed'
                  AND verification.updated_at
                        < NOW() - make_interval(mins => $3::integer)
                  AND (
                      verification.updated_at
                            < NOW() - make_interval(hours => $2::integer)
                      OR silver.updated_at > verification.updated_at
                  )
              )
          )
          AND (
              s.oldest_refresh IS NULL
              OR s.oldest_refresh < NOW() - make_interval(mins => $1::integer)
          )
        ORDER BY s.oldest_refresh ASC NULLS FIRST, ma.account_id
        LIMIT $4
        "#,
    )
    .bind(SOURCE_REFRESH_MAX_AGE_MINUTES as i32)
    .bind(FAILED_RETRY_AFTER_HOURS as i32)
    .bind(FAILED_RETRY_MIN_MINUTES as i32)
    .bind(limit)
    .fetch_all(pool)
    .await
}

/// Seed bounded account-level readiness refreshes. Each job drains all three
/// sources behind one provider-head request and publishes the coverage
/// watermark the verifier needs only after every drain succeeds. The
/// in-flight bound keeps maintenance from monopolizing the queue or the
/// NearBlocks budget; the Apalis job key makes repeated cycles idempotent.
async fn seed_readiness_jobs(
    state: &AppState,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let active = count_active_public_history_jobs_with_prefix(
        &state.db_pool,
        PUBLIC_HISTORY_READINESS_NAMESPACE,
        "readiness:",
    )
    .await?;
    let available = READINESS_MAX_IN_FLIGHT.saturating_sub(active.max(0) as usize);
    if available == 0 {
        return Ok(0);
    }

    let mut enqueued = 0;
    for account_id in load_readiness_candidates(&state.db_pool, available as i64).await? {
        if enqueue_readiness_refresh_job(&state.db_pool, account_id).await? {
            enqueued += 1;
        }
    }
    Ok(enqueued)
}

pub(crate) async fn run_public_history_detector_cycle(
    state: &AppState,
) -> Result<PublicHistoryDetectorStats, Box<dyn std::error::Error + Send + Sync>> {
    let stats = if let Some(goldsky_pool) = state.goldsky_pool.as_ref() {
        tick_goldsky_scheduler(state, goldsky_pool).await?
    } else {
        tracing::debug!(
            "public history Goldsky latest scheduler skipped (GOLDSKY_DATABASE_URL not set)"
        );
        PublicHistoryDetectorStats::default()
    };
    Ok(stats)
}

/// Independent from the Goldsky scan: persisted or deferred demands keep
/// dispatching even when the external sink is unavailable or its scan stalls.
pub(crate) async fn run_public_history_latest_dispatcher_cycle(
    state: &AppState,
) -> Result<usize, sqlx::Error> {
    dispatch_latest_demands(state).await
}

pub(crate) async fn run_public_history_readiness_scheduler_cycle(
    state: &AppState,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    seed_readiness_jobs(state).await
}

pub(crate) async fn run_public_history_backfill_scheduler_cycle(
    state: &AppState,
) -> Result<usize, sqlx::Error> {
    seed_backfill_jobs(state).await
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use sqlx::postgres::PgListener;

    fn outcome() -> IndexedDaoOutcome {
        IndexedDaoOutcome {
            id: "outcome".to_string(),
            executor_id: "token.near".to_string(),
            logs: None,
            status: None,
            transaction_hash: Some("tx".to_string()),
            signer_id: None,
            receiver_id: None,
            trigger_block_height: 42,
            trigger_block_timestamp: 1_700_000_000_000,
        }
    }

    #[test]
    fn coalesces_by_account_and_source() {
        let candidates = vec![
            RefreshCandidate {
                account_id: "dao.sputnik-dao.near".to_string(),
                source: PublicHistorySource::NearblocksFt,
                trigger_block_height: 10,
                trigger_transaction_hash: Some("a".to_string()),
            },
            RefreshCandidate {
                account_id: "dao.sputnik-dao.near".to_string(),
                source: PublicHistorySource::NearblocksFt,
                trigger_block_height: 11,
                trigger_transaction_hash: Some("b".to_string()),
            },
            RefreshCandidate {
                account_id: "dao.sputnik-dao.near".to_string(),
                source: PublicHistorySource::NearblocksMt,
                trigger_block_height: 9,
                trigger_transaction_hash: Some("c".to_string()),
            },
        ];

        let coalesced = coalesce_candidates(candidates);
        assert_eq!(coalesced.len(), 2);
        assert!(coalesced.iter().any(|candidate| {
            candidate.source == PublicHistorySource::NearblocksFt
                && candidate.trigger_block_height == 11
                && candidate.trigger_transaction_hash.as_deref() == Some("b")
        }));
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn outcome_pagination_orders_by_block_then_id(pool: PgPool) {
        sqlx::query(
            r#"
            INSERT INTO indexed_dao_outcomes (
                id,
                executor_id,
                trigger_block_height,
                trigger_block_timestamp
            )
            VALUES
                ('z', 'token.near', 41, 1700000000000),
                ('a', 'token.near', 42, 1700000001000),
                ('b', 'token.near', 42, 1700000002000),
                ('c', 'token.near', 43, 1700000003000)
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let outcomes = fetch_next_outcomes(&pool, 42, "a").await.unwrap();
        assert_eq!(
            outcomes
                .into_iter()
                .map(|outcome| outcome.id)
                .collect::<Vec<_>>(),
            vec!["b", "c"]
        );
    }

    #[test]
    fn nep141_mint_and_burn_refresh_the_owner() {
        let monitored = HashSet::from(["dao.near".to_string()]);
        let outcome = outcome();

        for event_name in ["ft_mint", "ft_burn"] {
            let event = EventJson {
                standard: "nep141".to_string(),
                event: event_name.to_string(),
                data: vec![serde_json::json!({
                    "owner_id": "dao.near",
                    "amount": "100"
                })],
            };
            let mut candidates = Vec::new();

            classify_event_json(&event, &monitored, &outcome, &mut candidates);

            assert_eq!(candidates.len(), 1, "{event_name} should enqueue once");
            assert_eq!(candidates[0].account_id, "dao.near");
            assert_eq!(candidates[0].source, PublicHistorySource::NearblocksFt);
        }
    }

    async fn make_readiness_ready(pool: &PgPool, account_id: &str) {
        sqlx::query(
            r#"
            INSERT INTO monitored_accounts (account_id, enabled, is_confidential_account)
            VALUES ($1, true, false)
            "#,
        )
        .bind(account_id)
        .execute(pool)
        .await
        .unwrap();
        for source in ["nearblocks_ft", "nearblocks_mt", "nearblocks_receipt"] {
            sqlx::query(
                r#"
                INSERT INTO bronze_public_history_cursors (account_id, source, backfill_done)
                VALUES ($1, $2::public_history_source, true)
                "#,
            )
            .bind(account_id)
            .bind(source)
            .execute(pool)
            .await
            .unwrap();
        }
        sqlx::query(
            r#"
            INSERT INTO gold_public_history_cursors (account_id, projection_ready_at)
            VALUES ($1, NOW())
            ON CONFLICT (account_id) DO UPDATE SET projection_ready_at = NOW()
            "#,
        )
        .bind(account_id)
        .execute(pool)
        .await
        .unwrap();
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn dispatcher_keeps_apalis_bounded_and_refills_from_durable_demands(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        crate::jobs::setup_apalis(&pool).await?;
        super::super::postgres::setup_public_history_jobs(&pool).await?;
        for index in 0..100 {
            upsert_latest_demand(
                &pool,
                &format!("dispatch-{index}.near"),
                PublicHistorySource::NearblocksFt,
                index,
                Some(&format!("tx-{index}")),
            )
            .await?;
        }

        let state = crate::AppState::builder()
            .db_pool(pool.clone())
            .build()
            .await
            .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
        // The dispatcher cycle never touches the Goldsky pool, so this test
        // holds whether or not the environment can reach the sink.
        let max_active = job_concurrency();
        let first_fill = max_active.min(100);
        assert_eq!(
            run_public_history_latest_dispatcher_cycle(&state).await?,
            first_fill
        );
        assert_eq!(run_public_history_latest_dispatcher_cycle(&state).await?, 0);

        let active = count_active_public_history_jobs_with_prefix(
            &pool,
            PUBLIC_HISTORY_LATEST_NAMESPACE,
            LATEST_JOB_KEY_PREFIX,
        )
        .await?;
        assert_eq!(active, first_fill as i64);
        assert_eq!(ready_latest_demand_count(&pool).await?, 100);

        // Simulate exactly one slot completing: production deletes its demand
        // row from the handler before Apalis acknowledges the token. The next
        // cycle must skip still-active demands and refill that one slot.
        let completed_account: String = sqlx::query_scalar(
            r#"
            SELECT split_part(metadata->>'job_key', ':', 2)
            FROM apalis.jobs
            WHERE job_type = $1
              AND status = 'Pending'
            ORDER BY id
            LIMIT 1
            "#,
        )
        .bind(PUBLIC_HISTORY_LATEST_NAMESPACE)
        .fetch_one(&pool)
        .await?;
        sqlx::query("DELETE FROM public_history_latest_demands WHERE account_id = $1")
            .bind(&completed_account)
            .execute(&pool)
            .await?;
        sqlx::query(
            r#"
            UPDATE apalis.jobs
            SET status = 'Done', done_at = NOW()
            WHERE job_type = $1
              AND status = 'Pending'
              AND metadata->>'job_key' = $2
            "#,
        )
        .bind(PUBLIC_HISTORY_LATEST_NAMESPACE)
        .bind(format!("latest:{completed_account}:nearblocks_ft"))
        .execute(&pool)
        .await?;

        assert_eq!(run_public_history_latest_dispatcher_cycle(&state).await?, 1);
        let active = count_active_public_history_jobs_with_prefix(
            &pool,
            PUBLIC_HISTORY_LATEST_NAMESPACE,
            LATEST_JOB_KEY_PREFIX,
        )
        .await?;
        assert_eq!(active, first_fill as i64);
        assert!(active <= max_active as i64);
        assert_eq!(ready_latest_demand_count(&pool).await?, 99);
        Ok(())
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn recovery_renotifies_only_the_oldest_bounded_batch_with_trigger_payload(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        crate::jobs::setup_apalis(&pool).await?;

        // Insert before LISTEN so every trigger notification is intentionally
        // missed. The recovery query must be the only wakeup the test sees.
        let ids: Vec<String> = (0..300).map(|index| format!("{index:026}")).collect();
        let ages: Vec<i64> = (2..302).collect();
        sqlx::query(
            r#"
            INSERT INTO apalis.jobs (job, id, job_type, run_at)
            SELECT decode('7b7d', 'hex'), pending.id,
                   'public_history_latest',
                   NOW() - make_interval(secs => pending.age::double precision)
            FROM UNNEST($1::text[], $2::bigint[]) AS pending(id, age)
            "#,
        )
        .bind(&ids)
        .bind(&ages)
        .execute(&pool)
        .await?;

        let mut listener = PgListener::connect_with(&pool).await?;
        listener.listen("apalis::job::insert").await?;

        let (renotified, oldest_age) = renotify_due_public_history_tokens(&pool).await?;
        assert_eq!(renotified, PUBLIC_HISTORY_RENOTIFY_BATCH);
        assert!(oldest_age.is_some_and(|age| age >= 300.0));

        let expected: std::collections::HashSet<&str> = ids
            .iter()
            .skip(ids.len() - PUBLIC_HISTORY_RENOTIFY_BATCH as usize)
            .map(String::as_str)
            .collect();
        let received = tokio::time::timeout(Duration::from_secs(3), async {
            let mut received = std::collections::HashSet::new();
            for _ in 0..PUBLIC_HISTORY_RENOTIFY_BATCH {
                let notification = listener.recv().await?;
                let payload: serde_json::Value = serde_json::from_str(notification.payload())
                    .map_err(|error| sqlx::Error::Decode(Box::new(error)))?;
                assert_eq!(
                    payload.get("job_type").and_then(serde_json::Value::as_str),
                    Some(PUBLIC_HISTORY_LATEST_NAMESPACE)
                );
                assert!(payload.get("run_at").is_some());
                let id = payload
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .expect("notification id");
                assert!(expected.contains(id), "recovery notified a newer token");
                received.insert(id.to_string());
            }
            Ok::<_, sqlx::Error>(received)
        })
        .await
        .expect("bounded recovery notifications should arrive")?;
        assert_eq!(received.len(), PUBLIC_HISTORY_RENOTIFY_BATCH as usize);
        Ok(())
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn readiness_candidates_require_backfill_gold_and_verifier_demand(pool: PgPool) {
        // Fully eligible: backfilled, gold ready, never gated.
        make_readiness_ready(&pool, "eligible.sputnik-dao.near").await;

        // Monitored but not backfilled: no readiness work.
        sqlx::query(
            r#"
            INSERT INTO monitored_accounts (account_id, enabled, is_confidential_account)
            VALUES ('unbackfilled.sputnik-dao.near', true, false)
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        // Failed recently: inside both the cool-off and the retry floor.
        make_readiness_ready(&pool, "cooling.sputnik-dao.near").await;
        sqlx::query(
            r#"
            INSERT INTO public_balance_verification_cursors (account_id, status, updated_at)
            VALUES ('cooling.sputnik-dao.near', 'failed', NOW())
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let candidates = load_readiness_candidates(&pool, 5).await.unwrap();

        assert_eq!(candidates, vec!["eligible.sputnik-dao.near".to_string()]);
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn failed_account_with_rebuilt_ledger_is_readiness_eligible_after_floor(pool: PgPool) {
        make_readiness_ready(&pool, "rebuilt.sputnik-dao.near").await;
        // Failed 30 minutes ago (past the 15-minute floor, inside the 6h
        // cool-off) with a silver rebuild after the failed check.
        sqlx::query(
            r#"
            INSERT INTO public_balance_verification_cursors (account_id, status, updated_at)
            VALUES ('rebuilt.sputnik-dao.near', 'failed', NOW() - INTERVAL '30 minutes')
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO silver_public_history_cursors (account_id, updated_at)
            VALUES ('rebuilt.sputnik-dao.near', NOW())
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let candidates = load_readiness_candidates(&pool, 5).await.unwrap();

        assert_eq!(candidates, vec!["rebuilt.sputnik-dao.near".to_string()]);
    }
}
