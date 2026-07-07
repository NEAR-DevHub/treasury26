use serde::Deserialize;
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};

use super::worker::{enqueue_backfill_page_job, enqueue_latest_refresh_job};
use crate::AppState;
use crate::handlers::public_history::bronze::store::PublicHistorySource;
use crate::services::goldsky_cursor::{load_goldsky_cursor, save_goldsky_cursor};

const SCHEDULER_BATCH_SIZE: i64 = 2_000;
const BACKFILL_SEED_LIMIT_PER_SOURCE: i64 = 100;
const CONSUMER_NAME: &str = "public_history_scheduler";

#[derive(Debug, Default)]
pub(crate) struct PublicHistorySchedulerStats {
    pub latest_enqueued: usize,
    pub backfill_enqueued: usize,
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
    let accounts: Vec<String> =
        sqlx::query_scalar("SELECT account_id FROM monitored_accounts WHERE enabled = true")
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
        "nep141" if event.event == "ft_transfer" => {
            for datum in &event.data {
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
            trigger_block_height
        FROM indexed_dao_outcomes
        WHERE trigger_block_height > $1
           OR (trigger_block_height = $1 AND id > $2)
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

async fn tick_goldsky_scheduler(
    state: &AppState,
    goldsky_pool: &PgPool,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let cursor = load_goldsky_cursor(&state.db_pool, goldsky_pool, CONSUMER_NAME).await?;
    let outcomes = fetch_next_outcomes(
        goldsky_pool,
        cursor.last_processed_block,
        &cursor.last_processed_id,
    )
    .await?;

    if outcomes.is_empty() {
        return Ok(0);
    }

    let monitored = load_monitored_accounts(&state.db_pool).await?;
    let mut all_candidates = Vec::new();
    let mut last_processed_id = cursor.last_processed_id;
    let mut last_processed_block = cursor.last_processed_block;

    for outcome in &outcomes {
        all_candidates.extend(classify_outcome(outcome, &monitored));
        last_processed_id = outcome.id.clone();
        last_processed_block = outcome.trigger_block_height;
    }

    let candidates = coalesce_candidates(all_candidates);
    let mut enqueued = 0usize;
    for candidate in candidates {
        if enqueue_latest_refresh_job(
            &state.db_pool,
            candidate.account_id,
            candidate.source,
            candidate.trigger_block_height,
            candidate.trigger_transaction_hash,
        )
        .await?
        {
            enqueued += 1;
        }
    }

    save_goldsky_cursor(
        &state.db_pool,
        CONSUMER_NAME,
        &last_processed_id,
        last_processed_block,
    )
    .await?;

    Ok(enqueued)
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

pub(crate) async fn run_public_history_scheduler_cycle(
    state: &AppState,
) -> Result<PublicHistorySchedulerStats, Box<dyn std::error::Error + Send + Sync>> {
    let latest_enqueued = if let Some(goldsky_pool) = state.goldsky_pool.as_ref() {
        tick_goldsky_scheduler(state, goldsky_pool).await?
    } else {
        tracing::debug!(
            "public history Goldsky latest scheduler skipped (GOLDSKY_DATABASE_URL not set)"
        );
        0
    };

    let backfill_enqueued = seed_backfill_jobs(state).await?;
    Ok(PublicHistorySchedulerStats {
        latest_enqueued,
        backfill_enqueued,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
