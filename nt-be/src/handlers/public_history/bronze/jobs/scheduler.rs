use chrono::{DateTime, Utc};
use near_api::{Chain, Reference};
use serde::Deserialize;
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};

use super::worker::{
    enqueue_backfill_page_job, enqueue_preverification_refresh_job, enqueue_latest_refresh_job,
};
use crate::AppState;
use crate::handlers::public_history::bronze::store::PublicHistorySource;
use crate::services::goldsky_cursor::{load_goldsky_cursor, save_goldsky_cursor};
use crate::services::public_balance_reader::with_transport_retry;

const SCHEDULER_BATCH_SIZE: i64 = 2_000;
const SCHEDULER_MAX_BATCHES: usize = 5;
const BACKFILL_SEED_LIMIT_PER_SOURCE: i64 = 100;
const CONSUMER_NAME: &str = "public_history_scheduler";
const PREVERIFICATION_REFRESH_PRIORITY: i32 = 100_000;
/// Freshness window on `latest_refresh_at` before an unverified account
/// triggers another priority drain of the NearBlocks sources.
pub const SOURCE_REFRESH_MAX_AGE_MINUTES: i64 = 15;
/// Lag allowance subtracted from the finalized head when recording the
/// verified provider cutoff for a drain.
pub const SOURCE_REFRESH_BLOCK_LAG_ALLOWANCE: i64 = 1_200;

#[derive(Debug, Default)]
pub(crate) struct PublicHistoryDetectorStats {
    pub outcomes_seen: usize,
    pub batches_processed: usize,
    pub latest_enqueued: usize,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct IndexedDaoOutcome {
    id: String,
    executor_id: String,
    logs: Option<String>,
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

#[derive(Debug, sqlx::FromRow)]
struct PreverificationRefreshRow {
    account_id: String,
    source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreverificationRefreshCandidate {
    account_id: String,
    source: PublicHistorySource,
}

impl TryFrom<PreverificationRefreshRow> for PreverificationRefreshCandidate {
    type Error =
        crate::handlers::public_history::bronze::store::models::PublicHistorySourceParseError;

    fn try_from(row: PreverificationRefreshRow) -> Result<Self, Self::Error> {
        Ok(Self {
            account_id: row.account_id,
            source: PublicHistorySource::from_db(&row.source)?,
        })
    }
}

async fn load_monitored_accounts(pool: &PgPool) -> Result<HashSet<String>, sqlx::Error> {
    let accounts: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT account_id
        FROM monitored_accounts
        WHERE enabled = true
          AND COALESCE(is_confidential_account, false) = false
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
        for outcome in &outcomes {
            all_candidates.extend(classify_outcome(outcome, &monitored));
        }

        for candidate in coalesce_candidates(all_candidates) {
            if enqueue_latest_refresh_job(
                &state.db_pool,
                candidate.account_id,
                candidate.source,
                candidate.trigger_block_height,
                candidate.trigger_transaction_hash,
            )
            .await?
            {
                stats.latest_enqueued += 1;
            }
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

async fn seed_backfill_jobs(state: &AppState) -> Result<usize, sqlx::Error> {
    let mut enqueued = 0usize;
    for source in PublicHistorySource::all() {
        let rows: Vec<(String, Option<String>)> = sqlx::query_as(
            r#"
            SELECT ma.account_id, c.backward_cursor
            FROM monitored_accounts ma
            LEFT JOIN bronze_public_history_cursors c
              ON c.account_id = ma.account_id
             AND c.source = $1::public_history_source
            WHERE ma.enabled = true
              AND COALESCE(ma.is_confidential_account, false) = false
              AND COALESCE(c.backfill_done, false) = false
            ORDER BY c.updated_at ASC NULLS FIRST, ma.account_id ASC
            LIMIT $2
            "#,
        )
        .bind(source.as_str())
        .bind(BACKFILL_SEED_LIMIT_PER_SOURCE)
        .fetch_all(&state.db_pool)
        .await?;

        for (account_id, cursor) in rows {
            if enqueue_backfill_page_job(&state.db_pool, account_id, source, cursor).await? {
                enqueued += 1;
            }
        }
    }
    Ok(enqueued)
}

/// Durably refresh every source for accounts that have not yet passed
/// on-chain balance verification. A successful drain of all three sources
/// writes `latest_refresh_at`/`latest_refresh_cutoff_block_height`, which is
/// exactly the "bronze covered through block B" proof the verifier needs
/// before comparing ledger balances against chain.
///
/// The existing Apalis job key makes repeated scheduler cycles idempotent
/// while a refresh is pending or retryable. The 15-minute freshness window
/// prevents rapid re-enqueueing while still allowing a long initial build to
/// refresh its verified provider-head marker.
async fn load_preverification_refresh_candidates(
    pool: &PgPool,
) -> Result<Vec<PreverificationRefreshCandidate>, Box<dyn std::error::Error + Send + Sync>> {
    let source_names = PublicHistorySource::all()
        .map(PublicHistorySource::as_str)
        .to_vec();
    let rows: Vec<PreverificationRefreshRow> = sqlx::query_as(
        r#"
        SELECT ma.account_id, requested.source
        FROM monitored_accounts ma
        CROSS JOIN UNNEST($1::text[]) WITH ORDINALITY
          AS requested(source, source_order)
        LEFT JOIN bronze_public_history_cursors cursor
          ON cursor.account_id = ma.account_id
         AND cursor.source = requested.source::public_history_source
        WHERE ma.enabled = true
          AND COALESCE(ma.is_confidential_account, false) = false
          AND NOT EXISTS (
              SELECT 1
              FROM public_balance_verification_cursors verification
              WHERE verification.account_id = ma.account_id
                AND verification.status = 'passed'
          )
          AND (
              cursor.latest_refresh_at IS NULL
              OR cursor.latest_refresh_at
                    < NOW() - make_interval(mins => $2::integer)
          )
        ORDER BY ma.account_id, requested.source_order
        "#,
    )
    .bind(&source_names)
    .bind(SOURCE_REFRESH_MAX_AGE_MINUTES as i32)
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(PreverificationRefreshCandidate::try_from)
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into)
}

async fn seed_preverification_refresh_jobs(
    state: &AppState,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    // Keep each account's three sources adjacent in the queue. Verification
    // requires all three freshness markers at once, so source-major
    // scheduling can never satisfy the freshness window on a rate-limited API.
    let candidates = load_preverification_refresh_candidates(&state.db_pool).await?;

    if candidates.is_empty() {
        return Ok(0);
    }

    // Every job in this seed pass carries the same lag-adjusted finalized
    // cutoff. A successful drain persists its preflight provider head, letting
    // the balance verifier compare verified coverage with its own anchor.
    let final_block = with_transport_retry("preverification_refresh_final_block", || {
        Chain::block()
            .at(Reference::Final)
            .fetch_from(&state.archival_network)
    })
    .await?;
    let cutoff = i64::try_from(final_block.header.height)
        .map_err(|_| std::io::Error::other("final block height exceeds i64"))?
        .saturating_sub(SOURCE_REFRESH_BLOCK_LAG_ALLOWANCE);

    let mut enqueued = 0;
    for (index, candidate) in candidates.into_iter().enumerate() {
        let priority = PREVERIFICATION_REFRESH_PRIORITY.saturating_sub(index as i32);
        if enqueue_preverification_refresh_job(
            &state.db_pool,
            candidate.account_id,
            candidate.source,
            cutoff,
            priority,
        )
        .await?
        {
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

pub(crate) async fn run_public_history_readiness_scheduler_cycle(
    state: &AppState,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    seed_preverification_refresh_jobs(state).await
}

pub(crate) async fn run_public_history_backfill_scheduler_cycle(
    state: &AppState,
) -> Result<usize, sqlx::Error> {
    seed_backfill_jobs(state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome() -> IndexedDaoOutcome {
        IndexedDaoOutcome {
            id: "outcome".to_string(),
            executor_id: "token.near".to_string(),
            logs: None,
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

    #[sqlx::test(migrations = "./migrations")]
    async fn preverification_refreshes_are_loaded_account_first(pool: PgPool) {
        sqlx::query(
            r#"
            INSERT INTO monitored_accounts (
                account_id, enabled, is_confidential_account
            )
            VALUES
                ('b.sputnik-dao.near', true, false),
                ('a.sputnik-dao.near', true, false)
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let candidates = load_preverification_refresh_candidates(&pool)
            .await
            .unwrap();

        assert_eq!(
            candidates,
            vec![
                PreverificationRefreshCandidate {
                    account_id: "a.sputnik-dao.near".to_string(),
                    source: PublicHistorySource::NearblocksFt,
                },
                PreverificationRefreshCandidate {
                    account_id: "a.sputnik-dao.near".to_string(),
                    source: PublicHistorySource::NearblocksMt,
                },
                PreverificationRefreshCandidate {
                    account_id: "a.sputnik-dao.near".to_string(),
                    source: PublicHistorySource::NearblocksReceipt,
                },
                PreverificationRefreshCandidate {
                    account_id: "b.sputnik-dao.near".to_string(),
                    source: PublicHistorySource::NearblocksFt,
                },
                PreverificationRefreshCandidate {
                    account_id: "b.sputnik-dao.near".to_string(),
                    source: PublicHistorySource::NearblocksMt,
                },
                PreverificationRefreshCandidate {
                    account_id: "b.sputnik-dao.near".to_string(),
                    source: PublicHistorySource::NearblocksReceipt,
                },
            ]
        );
    }
}
