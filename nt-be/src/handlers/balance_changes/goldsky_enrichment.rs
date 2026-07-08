//! Goldsky Enrichment Worker
//!
//! Reads indexed execution outcomes from the Goldsky sink database
//! and writes enriched balance_changes records to the app database.
//!
//! Architecture:
//! - Goldsky sink DB (read-only): `indexed_dao_outcomes` populated by Goldsky pipeline
//! - App DB (read-write): `balance_changes` + `goldsky_cursors` for progress tracking
//!
//! Idempotent: uses INSERT ... ON CONFLICT DO UPDATE so replays overwrite
//! with potentially higher-quality data

use super::balance::get_balance_change_at_block;
use super::counterparty::ensure_ft_metadata;
use super::swap_detector::{
    classify_proposal_swap_deposits, detect_swaps_from_api_with_client, store_detected_swaps,
};
use super::transfer_hints::tx_resolver::{TxActionInfo, resolve_receipt_block_height};
use super::utils::block_timestamp_to_datetime;
use crate::AppState;
use crate::handlers::intents::confidential::bronze::store::{
    link_intent_to_history_event, mark_confidential_history_activity_due,
};
use crate::handlers::intents::confidential::gold::history_events::refresh_gold_metadata_for_intent;
use crate::handlers::proposals::scraper::{extract_payload_hash_from_kind, fetch_proposal};
use base64::Engine;
use bigdecimal::Zero;
use near_api::NetworkConfig;
use serde::Deserialize;
use sqlx::PgPool;

// ---------------------------------------------------------------------------
// Goldsky sink row struct (runtime query — Goldsky DB is not managed by sqlx migrations)
// ---------------------------------------------------------------------------

#[derive(Debug, sqlx::FromRow)]
struct IndexedDaoOutcome {
    id: String,
    executor_id: String,
    logs: Option<String>,
    #[allow(dead_code)]
    status: Option<String>,
    transaction_hash: Option<String>,
    signer_id: Option<String>,
    receiver_id: Option<String>,
    #[allow(dead_code)]
    gas_burnt: Option<i64>,
    #[allow(dead_code)]
    tokens_burnt: Option<String>,
    trigger_block_height: i64,
    #[allow(dead_code)]
    trigger_block_hash: Option<String>,
    trigger_block_timestamp: i64, // milliseconds since epoch
}

// ---------------------------------------------------------------------------
// Parsed event
// ---------------------------------------------------------------------------

/// A single balance-affecting event parsed from an IndexedDaoOutcome.
/// One outcome can produce multiple ParsedEvents (Path A + Path B + Path C).
#[derive(Debug, Clone)]
struct ParsedEvent {
    account_id: String,
    token_id: String,
    counterparty: String,
    action_kind: Option<String>,
    #[allow(dead_code)]
    method_name: Option<String>,
    /// Path C events: trigger_block_height may be 2-3 blocks before the actual
    /// state change. When true, the enrichment loop scans forward to find the
    /// correct block.
    #[allow(dead_code)]
    forward_scan: bool,
}

// ---------------------------------------------------------------------------
// Cursor management
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Cursor {
    last_processed_id: String,
    last_processed_block: i64,
}

async fn get_cursor(
    app_pool: &PgPool,
    goldsky_pool: &PgPool,
    consumer_name: &str,
) -> Result<Cursor, Box<dyn std::error::Error>> {
    let row = sqlx::query_as::<_, (String, i64)>(
        "SELECT last_processed_id, last_processed_block FROM goldsky_cursors WHERE consumer_name = $1",
    )
    .bind(consumer_name)
    .fetch_optional(app_pool)
    .await?;

    match row {
        Some((id, block)) => Ok(Cursor {
            last_processed_id: id,
            last_processed_block: block,
        }),
        None => {
            // No cursor yet — seed from the latest block in the Goldsky sink so we
            // don't reprocess the entire history on first deploy.
            let latest: Option<(String, i64)> = sqlx::query_as(
                "SELECT id, trigger_block_height FROM indexed_dao_outcomes ORDER BY trigger_block_height DESC, id DESC LIMIT 1",
            )
            .fetch_optional(goldsky_pool)
            .await?;

            match latest {
                Some((id, block)) => {
                    tracing::info!(
                        "No cursor found, seeding from latest block {} in Goldsky sink",
                        block
                    );
                    update_cursor(app_pool, consumer_name, &id, block).await?;
                    Ok(Cursor {
                        last_processed_id: id,
                        last_processed_block: block,
                    })
                }
                None => Ok(Cursor {
                    last_processed_id: String::new(),
                    last_processed_block: 0,
                }),
            }
        }
    }
}

async fn update_cursor(
    app_pool: &PgPool,
    consumer_name: &str,
    last_id: &str,
    last_block: i64,
) -> Result<(), Box<dyn std::error::Error>> {
    sqlx::query(
        "INSERT INTO goldsky_cursors (consumer_name, last_processed_id, last_processed_block, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (consumer_name) DO UPDATE SET
           last_processed_id = EXCLUDED.last_processed_id,
           last_processed_block = EXCLUDED.last_processed_block,
           updated_at = NOW()",
    )
    .bind(consumer_name)
    .bind(last_id)
    .bind(last_block)
    .execute(app_pool)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Log parsing — EVENT_JSON structs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct EventJson {
    standard: String,
    #[serde(default)]
    event: String,
    #[serde(default)]
    data: Vec<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Event parsing (all local, no RPC)
// ---------------------------------------------------------------------------

/// Parse all balance-affecting events from a single IndexedDaoOutcome.
/// A single outcome can produce events from Path A (logs), Path B (receiver), and/or Path C (executor).
fn parse_outcome_events(outcome: &IndexedDaoOutcome) -> Vec<ParsedEvent> {
    let mut events = Vec::new();

    // Path A: Log-based events (logs mention sputnik-dao.near)
    if let Some(logs) = &outcome.logs {
        events.extend(parse_log_events(logs, &outcome.executor_id));
    }

    // Path B: Receiver-based events (receiver_id is a DAO)
    // forward_scan=true because cross-shard receipt processing means the NEAR
    // balance change often lands 1-3 blocks after the trigger block.
    let receiver_is_dao = outcome
        .receiver_id
        .as_ref()
        .is_some_and(|r| r.ends_with(".sputnik-dao.near"));

    if receiver_is_dao {
        events.push(ParsedEvent {
            account_id: outcome.receiver_id.clone().unwrap(),
            token_id: "near".to_string(),
            counterparty: outcome
                .signer_id
                .clone()
                .unwrap_or_else(|| "UNKNOWN".to_string()),
            action_kind: None,
            method_name: None,
            forward_scan: true,
        });
    }

    // Path C: Executor-based events (DAO executes cross-contract call)
    // Captures add_proposal / act_proposal outcomes where the DAO is the executor
    // but the receipt is sent to another contract (e.g., olskik.near).
    // forward_scan=true because trigger_block_height is typically 2-3 blocks before
    // the actual NEAR state change (cross-shard receipt processing).
    if outcome.executor_id.ends_with(".sputnik-dao.near") && !receiver_is_dao {
        events.push(ParsedEvent {
            account_id: outcome.executor_id.clone(),
            token_id: "near".to_string(),
            counterparty: outcome
                .receiver_id
                .clone()
                .unwrap_or_else(|| "UNKNOWN".to_string()),
            action_kind: None,
            method_name: None,
            forward_scan: true,
        });
    }

    events
}

/// Parse log lines into events (Path A).
/// Handles NEP-141, NEP-245, and wrap.near plain-text formats.
fn parse_log_events(logs: &str, executor_id: &str) -> Vec<ParsedEvent> {
    let mut events = Vec::new();

    // Goldsky stores log line separators as literal "\n" (two chars: backslash + n),
    // not actual newline bytes. Handle both.
    for line in logs.split('\n').flat_map(|l| l.split("\\n")) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // Only process lines that mention a sputnik-dao account
        if !line.contains("sputnik-dao.near") {
            continue;
        }

        if let Some(json_str) = line.strip_prefix("EVENT_JSON:") {
            // Parse EVENT_JSON (NEP-141 or NEP-245)
            if let Ok(event) = serde_json::from_str::<EventJson>(json_str) {
                match event.standard.as_str() {
                    "nep141" => {
                        events.extend(parse_nep141_event(&event, executor_id));
                    }
                    "nep245" => {
                        events.extend(parse_nep245_event(&event, executor_id));
                    }
                    _ => {
                        tracing::debug!("Unknown event standard: {}", event.standard);
                    }
                }
            }
        } else {
            // Plain-text log (wrap.near style)
            events.extend(parse_plain_text_transfer(line, executor_id));
        }
    }

    events
}

/// Parse NEP-141 ft_transfer event.
fn parse_nep141_event(event: &EventJson, executor_id: &str) -> Vec<ParsedEvent> {
    let mut events = Vec::new();
    if event.event != "ft_transfer" {
        return events;
    }

    for datum in &event.data {
        let old_owner = datum.get("old_owner_id").and_then(|v| v.as_str());
        let new_owner = datum.get("new_owner_id").and_then(|v| v.as_str());

        if let (Some(old_owner), Some(new_owner)) = (old_owner, new_owner) {
            if old_owner.contains("sputnik-dao.near") {
                events.push(ParsedEvent {
                    account_id: old_owner.to_string(),
                    token_id: executor_id.to_string(),
                    counterparty: new_owner.to_string(),
                    action_kind: Some("TRANSFER".to_string()),
                    method_name: None,
                    forward_scan: false,
                });
            }
            if new_owner.contains("sputnik-dao.near") {
                events.push(ParsedEvent {
                    account_id: new_owner.to_string(),
                    token_id: executor_id.to_string(),
                    counterparty: old_owner.to_string(),
                    action_kind: Some("TRANSFER".to_string()),
                    method_name: None,
                    forward_scan: false,
                });
            }
        }
    }

    events
}

/// Parse NEP-245 mt_transfer / mt_mint / mt_burn events (intents).
fn parse_nep245_event(event: &EventJson, executor_id: &str) -> Vec<ParsedEvent> {
    let mut events = Vec::new();

    match event.event.as_str() {
        "mt_transfer" => {
            for datum in &event.data {
                let old_owner = datum.get("old_owner_id").and_then(|v| v.as_str());
                let new_owner = datum.get("new_owner_id").and_then(|v| v.as_str());
                let token_ids = datum.get("token_ids").and_then(|v| v.as_array());

                if let (Some(old_owner), Some(new_owner), Some(token_ids)) =
                    (old_owner, new_owner, token_ids)
                {
                    for token_value in token_ids {
                        if let Some(token_id_str) = token_value.as_str() {
                            let full_token_id = format!("{}:{}", executor_id, token_id_str);

                            if old_owner.contains("sputnik-dao.near") {
                                events.push(ParsedEvent {
                                    account_id: old_owner.to_string(),
                                    token_id: full_token_id.clone(),
                                    counterparty: new_owner.to_string(),
                                    action_kind: Some("TRANSFER".to_string()),
                                    method_name: None,
                                    forward_scan: false,
                                });
                            }
                            if new_owner.contains("sputnik-dao.near") {
                                events.push(ParsedEvent {
                                    account_id: new_owner.to_string(),
                                    token_id: full_token_id,
                                    counterparty: old_owner.to_string(),
                                    action_kind: Some("TRANSFER".to_string()),
                                    method_name: None,
                                    forward_scan: false,
                                });
                            }
                        }
                    }
                }
            }
        }
        "mt_mint" => {
            // mt_mint: tokens minted to the DAO (e.g. intents deposit).
            // Use forward_scan because the balance change may lag by 1-3 blocks.
            for datum in &event.data {
                let owner = datum.get("owner_id").and_then(|v| v.as_str());
                let token_ids = datum.get("token_ids").and_then(|v| v.as_array());

                if let (Some(owner), Some(token_ids)) = (owner, token_ids)
                    && owner.contains("sputnik-dao.near")
                {
                    for token_value in token_ids {
                        if let Some(token_id_str) = token_value.as_str() {
                            let full_token_id = format!("{}:{}", executor_id, token_id_str);
                            events.push(ParsedEvent {
                                account_id: owner.to_string(),
                                token_id: full_token_id,
                                counterparty: executor_id.to_string(),
                                action_kind: Some("MINT".to_string()),
                                method_name: None,
                                forward_scan: true,
                            });
                        }
                    }
                }
            }
        }
        "mt_burn" => {
            // mt_burn: the DAO's intents balance decreases. Use forward_scan
            // because the balance change may lag the trigger block by 1-3 blocks.
            for datum in &event.data {
                let owner = datum.get("owner_id").and_then(|v| v.as_str());
                let token_ids = datum.get("token_ids").and_then(|v| v.as_array());

                if let (Some(owner), Some(token_ids)) = (owner, token_ids)
                    && owner.contains("sputnik-dao.near")
                {
                    for token_value in token_ids {
                        if let Some(token_id_str) = token_value.as_str() {
                            let full_token_id = format!("{}:{}", executor_id, token_id_str);
                            events.push(ParsedEvent {
                                account_id: owner.to_string(),
                                token_id: full_token_id,
                                counterparty: executor_id.to_string(),
                                action_kind: Some("BURN".to_string()),
                                method_name: None,
                                forward_scan: true,
                            });
                        }
                    }
                }
            }
        }
        _ => {}
    }

    events
}

/// Parse wrap.near plain-text transfer log.
/// Format: "Transfer NNN from alice.near to bob.sputnik-dao.near"
fn parse_plain_text_transfer(line: &str, executor_id: &str) -> Vec<ParsedEvent> {
    let mut events = Vec::new();

    if !line.starts_with("Transfer ") {
        return events;
    }

    // Parse: "Transfer <amount> from <sender> to <receiver>"
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() >= 6 && parts[2] == "from" && parts[4] == "to" {
        let sender = parts[3];
        let receiver = parts[5];

        if sender.contains("sputnik-dao.near") {
            events.push(ParsedEvent {
                account_id: sender.to_string(),
                token_id: executor_id.to_string(),
                counterparty: receiver.to_string(),
                action_kind: Some("TRANSFER".to_string()),
                method_name: None,
                forward_scan: false,
            });
        }
        if receiver.contains("sputnik-dao.near") {
            events.push(ParsedEvent {
                account_id: receiver.to_string(),
                token_id: executor_id.to_string(),
                counterparty: sender.to_string(),
                action_kind: Some("TRANSFER".to_string()),
                method_name: None,
                forward_scan: false,
            });
        }
    }

    events
}

// ---------------------------------------------------------------------------
// Upsert to app DB
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
async fn upsert_balance_change(
    app_pool: &PgPool,
    account_id: &str,
    token_id: &str,
    block_height: i64,
    block_timestamp_nanos: i64,
    block_time: sqlx::types::chrono::DateTime<sqlx::types::chrono::Utc>,
    amount: &bigdecimal::BigDecimal,
    balance_before: &bigdecimal::BigDecimal,
    balance_after: &bigdecimal::BigDecimal,
    transaction_hashes: &[String],
    signer_id: Option<&str>,
    receiver_id: Option<&str>,
    counterparty: &str,
    action_kind: Option<&str>,
    method_name: Option<&str>,
    actions: &serde_json::Value,
    raw_data: &serde_json::Value,
) -> Result<i64, Box<dyn std::error::Error>> {
    let row = sqlx::query!(
        r#"
        INSERT INTO balance_changes
        (account_id, token_id, block_height, block_timestamp, block_time,
         amount, balance_before, balance_after,
         transaction_hashes, receipt_id, signer_id, receiver_id,
         counterparty, actions, raw_data, action_kind, method_name)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (account_id, block_height, token_id) DO UPDATE SET
          amount = EXCLUDED.amount,
          balance_before = EXCLUDED.balance_before,
          balance_after = EXCLUDED.balance_after,
          transaction_hashes = EXCLUDED.transaction_hashes,
          signer_id = EXCLUDED.signer_id,
          receiver_id = EXCLUDED.receiver_id,
          counterparty = EXCLUDED.counterparty,
          action_kind = EXCLUDED.action_kind,
          method_name = EXCLUDED.method_name,
          raw_data = EXCLUDED.raw_data,
          updated_at = NOW()
        RETURNING id
        "#,
        account_id,
        token_id,
        block_height,
        block_timestamp_nanos,
        block_time,
        amount,
        balance_before,
        balance_after,
        transaction_hashes,
        &Vec::<String>::new() as &[String], // receipt_id — not available from Goldsky
        signer_id,
        receiver_id,
        counterparty,
        actions,
        raw_data,
        action_kind,
        method_name,
    )
    .fetch_one(app_pool)
    .await?;

    Ok(row.id)
}

// ---------------------------------------------------------------------------
// Main enrichment cycle
// ---------------------------------------------------------------------------

/// Fetch monitored accounts from the app DB keyed by account_id → `is_confidential_account`.
async fn get_monitored_accounts(
    app_pool: &PgPool,
) -> Result<std::collections::HashMap<String, bool>, Box<dyn std::error::Error>> {
    let rows: Vec<(String, bool)> = sqlx::query_as(
        "SELECT account_id, is_confidential_account FROM monitored_accounts WHERE enabled = true",
    )
    .fetch_all(app_pool)
    .await?;
    Ok(rows.into_iter().collect())
}

pub(crate) fn decode_success_value_u64(status: &str) -> Option<u64> {
    fn extract_encoded(status: &str) -> Option<String> {
        let status = status.trim();
        if status.is_empty() {
            return None;
        }

        if let Ok(value) = serde_json::from_str::<serde_json::Value>(status) {
            return value
                .get("SuccessValue")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string);
        }

        let inner = status
            .strip_prefix("SuccessValue(")?
            .strip_suffix(')')?
            .trim();
        let encoded = inner.strip_prefix('"')?.strip_suffix('"')?.trim();
        (!encoded.is_empty()).then(|| encoded.to_string())
    }

    let encoded = extract_encoded(status)?;

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    decoded.trim().parse::<u64>().ok()
}

fn confidential_dao_for_outcome(
    outcome: &IndexedDaoOutcome,
    monitored: &std::collections::HashMap<String, bool>,
) -> Option<String> {
    if matches!(monitored.get(&outcome.executor_id), Some(true)) {
        return Some(outcome.executor_id.clone());
    }

    let receiver_id = outcome.receiver_id.as_deref()?;
    if matches!(monitored.get(receiver_id), Some(true)) {
        return Some(receiver_id.to_string());
    }

    None
}

async fn update_confidential_intent_proposal(
    app_pool: &PgPool,
    dao_id: &str,
    payload_hash: &str,
    proposal_id: u64,
    proposal_created_at: chrono::DateTime<chrono::Utc>,
) -> Result<bool, Box<dyn std::error::Error>> {
    let proposal_id = i64::try_from(proposal_id)?;
    let result = sqlx::query(
        r#"
        UPDATE confidential_intents
        SET proposal_id = COALESCE(proposal_id, $3),
            proposal_created_at = COALESCE(proposal_created_at, $4),
            updated_at = NOW()
        WHERE dao_id = $1
          AND payload_hash = $2
        "#,
    )
    .bind(dao_id)
    .bind(payload_hash)
    .bind(proposal_id)
    .bind(proposal_created_at)
    .execute(app_pool)
    .await?;

    if result.rows_affected() > 0 {
        if let Some(history_event_id) =
            link_intent_to_history_event(app_pool, dao_id, payload_hash).await?
        {
            tracing::info!(
                "linked proposal intent {}/{} to history_event_id={}",
                dao_id,
                payload_hash,
                history_event_id
            );
        }
        refresh_gold_metadata_for_intent(app_pool, dao_id, payload_hash).await?;
        return Ok(true);
    }

    Ok(false)
}

async fn handle_confidential_add_proposal(
    app_pool: &PgPool,
    network: &NetworkConfig,
    dao_id: &str,
    proposal_id: u64,
    proposal_created_at: chrono::DateTime<chrono::Utc>,
) -> Result<bool, Box<dyn std::error::Error>> {
    let dao_account: near_api::AccountId = match dao_id.parse() {
        Ok(account) => account,
        Err(e) => {
            tracing::warn!(
                "invalid DAO account id for proposal lookup {}: {}",
                dao_id,
                e
            );
            return Ok(false);
        }
    };

    let proposal = match fetch_proposal(network, &dao_account, proposal_id).await {
        Ok(proposal) => proposal,
        Err(e) => {
            tracing::warn!(
                "failed to fetch proposal {}/{}: {:?}",
                dao_id,
                proposal_id,
                e
            );
            return Ok(false);
        }
    };

    let Some(payload_hash) = extract_payload_hash_from_kind(&proposal.kind) else {
        return Ok(false);
    };

    let updated = update_confidential_intent_proposal(
        app_pool,
        dao_id,
        &payload_hash,
        proposal_id,
        proposal_created_at,
    )
    .await?;

    if updated {
        tracing::info!(
            "linked confidential proposal {}/{} to payload_hash={}",
            dao_id,
            proposal_id,
            payload_hash
        );
    }

    Ok(updated)
}

/// Keep the Goldsky cursor moving; history polling and Gold projection run in
/// the confidential-history scheduler.
#[tracing::instrument(level = "debug", skip_all, fields(dao_id = dao_id))]
async fn mark_confidential_history_due_for_execution(
    history_state: Option<&AppState>,
    monitored: &std::collections::HashMap<String, bool>,
    dao_id: &str,
    recipient: Option<&str>,
) {
    let Some(state) = history_state else {
        return;
    };

    if let Err(e) = mark_confidential_history_activity_due(&state.db_pool, dao_id).await {
        tracing::warn!("cannot mark confidential history due for {}: {}", dao_id, e);
    }

    let Some(recipient) = recipient else {
        return;
    };
    if recipient == dao_id {
        return;
    }
    if matches!(monitored.get(recipient), Some(true))
        && let Err(e) = mark_confidential_history_activity_due(&state.db_pool, recipient).await
    {
        tracing::warn!(
            "cannot mark confidential history due for {}: {}",
            recipient,
            e
        );
    }
}

/// Run one enrichment cycle: fetch unprocessed outcomes from Goldsky sink, enrich with RPC,
/// write to app DB.
///
/// Returns the number of outcomes processed (not the number of balance_changes written,
/// since one outcome can produce multiple events and some may be skipped).
#[tracing::instrument(level = "info", skip_all, fields(job = "goldsky_enrichment"))]
pub async fn run_enrichment_cycle(
    goldsky_pool: &PgPool,
    app_pool: &PgPool,
    network: &NetworkConfig,
    intents_api_key: Option<&str>,
    intents_api_url: &str,
    history_state: Option<&AppState>,
) -> Result<usize, Box<dyn std::error::Error>> {
    let http_client = reqwest::Client::new();
    let consumer_name = "balance_enrichment";
    let cursor = get_cursor(app_pool, goldsky_pool, consumer_name).await?;

    // Only enrich accounts that are being monitored — avoids wasting RPC calls
    // on unmonitored DAOs (e.g., hot-dao produces thousands of outcomes)
    let monitored = get_monitored_accounts(app_pool).await?;

    // Fetch next batch from Goldsky sink (runtime query — not managed by sqlx migrations)
    let outcomes: Vec<IndexedDaoOutcome> = sqlx::query_as(
        "SELECT id, executor_id, logs, status, transaction_hash, signer_id, receiver_id,
                gas_burnt, tokens_burnt, trigger_block_height, trigger_block_hash, trigger_block_timestamp
         FROM indexed_dao_outcomes
         WHERE trigger_block_height > $1
            OR (trigger_block_height = $1 AND id > $2)
         ORDER BY trigger_block_height ASC, id ASC
         LIMIT 100",
    )
    .bind(cursor.last_processed_block)
    .bind(&cursor.last_processed_id)
    .fetch_all(goldsky_pool)
    .await?;

    if outcomes.is_empty() {
        return Ok(0);
    }

    let batch_size = outcomes.len();
    tracing::info!(
        "Processing batch of {} outcomes (cursor: block={}, id={})",
        batch_size,
        cursor.last_processed_block,
        if cursor.last_processed_id.is_empty() {
            "<start>"
        } else {
            &cursor.last_processed_id
        },
    );

    let mut last_processed_id = cursor.last_processed_id.clone();
    let mut last_processed_block = cursor.last_processed_block;
    let mut affected_accounts: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut swap_candidate_accounts: std::collections::HashSet<String> =
        std::collections::HashSet::new();

    // Cache resolved (block_height, action_info) per receipt ID to avoid redundant RPC calls
    // if the same outcome appears more than once in a batch.
    let mut receipt_block_cache: std::collections::HashMap<
        String,
        (Option<u64>, Option<TxActionInfo>),
    > = std::collections::HashMap::new();

    for outcome in &outcomes {
        // Timestamp conversion: Goldsky ms → balance_changes nanos.
        // We compute this up-front because the v1.signer confidential
        // short-circuit (below) runs before the normal event loop and
        // needs these values too.
        let block_timestamp_nanos = outcome.trigger_block_timestamp * 1_000_000;
        let block_time = block_timestamp_to_datetime(block_timestamp_nanos);
        let block_height = outcome.trigger_block_height as u64;

        if let Some(status) = outcome.status.as_deref()
            && let Some(proposal_id) = decode_success_value_u64(status)
            && let Some(dao_id) = confidential_dao_for_outcome(outcome, &monitored)
        {
            match handle_confidential_add_proposal(
                app_pool,
                network,
                &dao_id,
                proposal_id,
                block_time,
            )
            .await
            {
                Ok(true) => {}
                Ok(false) => {}
                Err(e) => {
                    tracing::error!(
                        "confidential proposal linkage failed for {}/{}: {}",
                        dao_id,
                        proposal_id,
                        e
                    );
                }
            }
        }

        // Confidential DAO short-circuit (runs before the normal event loop):
        // v1.signer emits exactly one `sign: predecessor=AccountId("…"),
        // request=…payload_v2: Some(Eddsa(Bytes("…")))` log per executed
        // confidential intent. We detect that, look up the stored quote, and
        // synthesize the outgoing balance_change row — no RPC balance queries.
        if outcome.executor_id == "v1.signer"
            && let Some(logs) = outcome.logs.as_deref()
            && let Some(call) = super::confidential_enrichment::extract_sign_call_from_logs(logs)
            && matches!(monitored.get(&call.dao_id), Some(true))
        {
            let submitted_intent =
                match super::confidential_enrichment::mark_confidential_intent_submitted(
                    app_pool,
                    &call.dao_id,
                    &call.payload_hash,
                    block_time,
                    Some(block_height as i64),
                    outcome.transaction_hash.as_deref(),
                )
                .await
                {
                    Ok(info) => info,
                    Err(e) => {
                        tracing::error!(
                            "failed to mark confidential intent submitted for {}: {}",
                            call.dao_id,
                            e
                        );
                        None
                    }
                };

            match super::confidential_enrichment::handle_confidential_outgoing(
                app_pool,
                network,
                &call.dao_id,
                &call.payload_hash,
                block_height as i64,
                block_timestamp_nanos,
                block_time,
                outcome.transaction_hash.clone(),
                outcome.signer_id.as_deref(),
            )
            .await
            {
                Ok(true) => {
                    affected_accounts.insert(call.dao_id.clone());
                }
                Ok(false) => {}
                Err(e) => {
                    tracing::error!("confidential outgoing failed for {}: {}", call.dao_id, e);
                }
            }
            mark_confidential_history_due_for_execution(
                history_state,
                &monitored,
                &call.dao_id,
                submitted_intent
                    .as_ref()
                    .and_then(|info| info.recipient.as_deref()),
            )
            .await;
            last_processed_id = outcome.id.clone();
            last_processed_block = outcome.trigger_block_height;
            continue;
        }

        let events = parse_outcome_events(outcome);

        if events.is_empty() {
            // No balance-affecting events parsed — still advance cursor
            last_processed_id = outcome.id.clone();
            last_processed_block = outcome.trigger_block_height;
            continue;
        }

        // Resolve the exact block height and transaction action data using tx_status.
        // The Goldsky outcome ID is the receipt ID — look it up directly in the
        // tx's receipts_outcome to get the block where this receipt executed.
        let (receipt_block, tx_action_info): (Option<u64>, Option<TxActionInfo>) = if let (
            Some(tx_hash),
            Some(signer),
        ) =
            (&outcome.transaction_hash, &outcome.signer_id)
        {
            if let Some(cached) = receipt_block_cache.get(&outcome.id) {
                cached.clone()
            } else {
                // Only resolve counterparty data (predecessor + child receipts) for
                // native NEAR events where tx-level signer/receiver is unreliable.
                let has_near_event = events
                    .iter()
                    .any(|e| e.token_id.eq_ignore_ascii_case("near"));
                let resolved = match resolve_receipt_block_height(
                    network,
                    tx_hash,
                    signer,
                    &outcome.id,
                    has_near_event,
                )
                .await
                {
                    Ok((block, action_info)) => {
                        tracing::debug!(
                            "receipt {} → block {:?} (trigger was {})",
                            outcome.id,
                            block,
                            block_height,
                        );
                        (block, action_info)
                    }
                    Err(e) => {
                        tracing::warn!(
                            "Failed to resolve receipt {}: {} — using trigger block",
                            outcome.id,
                            e,
                        );
                        (None, None)
                    }
                };
                receipt_block_cache.insert(outcome.id.clone(), resolved.clone());
                resolved
            }
        } else {
            (None, None)
        };

        for event in &events {
            if !monitored.contains_key(&event.account_id) {
                tracing::warn!("Unmonitored account {}", event.account_id);
            }

            // Ensure FT metadata is cached (needed for decimal conversion in RPC balance queries)
            if event.token_id != "near"
                && event.token_id != "NEAR"
                && !event.token_id.contains(':')
                && let Err(e) = ensure_ft_metadata(app_pool, network, &event.token_id).await
            {
                tracing::warn!(
                    "Failed to ensure FT metadata for {}: {} — skipping",
                    event.token_id,
                    e
                );
                continue;
            }

            // Use the exact receipt block if resolved, otherwise fall back to trigger block.
            let check_block = receipt_block.unwrap_or(block_height);
            let (actual_block, balance_before, balance_after) = match get_balance_change_at_block(
                app_pool,
                network,
                &event.account_id,
                &event.token_id,
                check_block,
            )
            .await
            {
                Ok((bb, ba)) => (check_block, bb, ba),
                Err(e) => {
                    tracing::warn!(
                        "RPC error for {}/{} at block {}: {} — skipping",
                        event.account_id,
                        event.token_id,
                        check_block,
                        e
                    );
                    continue;
                }
            };

            let amount = &balance_after - &balance_before;

            let transaction_hashes: Vec<String> = outcome
                .transaction_hash
                .as_ref()
                .map(|h| vec![h.clone()])
                .unwrap_or_default();

            // Prefer action_kind / method_name from tx_status, fall back to parsed event
            let effective_action_kind = tx_action_info
                .as_ref()
                .and_then(|info| info.action_kind.as_deref())
                .or(event.action_kind.as_deref());
            let effective_method_name = tx_action_info
                .as_ref()
                .and_then(|info| info.method_name.as_deref());
            let effective_actions = tx_action_info
                .as_ref()
                .map(|info| &info.actions)
                .cloned()
                .unwrap_or(serde_json::json!({"source": "goldsky"}));

            // For native NEAR events (Path B/C), the parsed counterparty comes from
            // transaction-level signer_id/receiver_id which is often the approver or
            // meta-tx relayer, not the actual sender/recipient of funds.
            //
            // Use receipt-level data from tx_status to find the real counterparty:
            //   - Incoming (amount > 0): receipt_predecessor_id is the sender
            //   - Outgoing (amount < 0): transfer_receiver_id is the recipient
            let effective_counterparty = if event.token_id.eq_ignore_ascii_case("near") {
                if amount > bigdecimal::BigDecimal::zero() {
                    // Incoming: predecessor created the Transfer receipt → sender
                    tx_action_info
                        .as_ref()
                        .and_then(|info| info.receipt_predecessor_id.as_deref())
                        .filter(|p| *p != event.account_id)
                        .unwrap_or(&event.counterparty)
                } else {
                    // Outgoing: child receipt executor → recipient
                    tx_action_info
                        .as_ref()
                        .and_then(|info| info.transfer_receiver_id.as_deref())
                        .filter(|r| *r != event.account_id)
                        .unwrap_or(&event.counterparty)
                }
            } else {
                &event.counterparty
            };

            match upsert_balance_change(
                app_pool,
                &event.account_id,
                &event.token_id,
                actual_block as i64,
                block_timestamp_nanos,
                block_time,
                &amount,
                &balance_before,
                &balance_after,
                &transaction_hashes,
                outcome.signer_id.as_deref(),
                outcome.receiver_id.as_deref(),
                effective_counterparty,
                effective_action_kind,
                effective_method_name,
                &effective_actions,
                &serde_json::json!({}),
            )
            .await
            {
                Ok(_) => {
                    tracing::info!(
                        "Upserted {}/{} at block {} amount={}",
                        event.account_id,
                        event.token_id,
                        actual_block,
                        amount,
                    );
                    affected_accounts.insert(event.account_id.clone());
                    if event.token_id.starts_with("intents.near:") {
                        swap_candidate_accounts.insert(event.account_id.clone());
                    }
                }
                Err(e) => tracing::error!(
                    "Failed to upsert {}/{} at block {}: {}",
                    event.account_id,
                    event.token_id,
                    block_height,
                    e
                ),
            }
        }

        // Advance cursor after each outcome (even if some events failed)
        last_processed_id = outcome.id.clone();
        last_processed_block = outcome.trigger_block_height;
    }

    // Persist cursor in app DB
    update_cursor(
        app_pool,
        consumer_name,
        &last_processed_id,
        last_processed_block,
    )
    .await?;

    // Run swap detection only for non-confidential monitored accounts with intents
    // token events — confidential DAOs have no public intents activity, and we
    // skip non-monitored accounts to avoid unnecessary API calls.
    let swap_candidates: Vec<&String> = swap_candidate_accounts
        .iter()
        .filter(|a| matches!(monitored.get(a.as_str()), Some(false)))
        .collect();
    for account_id in &swap_candidates {
        match detect_swaps_from_api_with_client(
            &http_client,
            app_pool,
            account_id,
            intents_api_key,
            intents_api_url,
        )
        .await
        {
            Ok(swaps) if !swaps.is_empty() => match store_detected_swaps(app_pool, &swaps).await {
                Ok(inserted) if inserted > 0 => {
                    tracing::info!("Detected and stored {} swaps for {}", inserted, account_id);
                }
                Err(e) => {
                    tracing::error!("Error storing swaps for {}: {}", account_id, e);
                }
                _ => {}
            },
            Err(e) => {
                tracing::error!("Error detecting swaps for {}: {}", account_id, e);
            }
            _ => {}
        }

        // Classify DAO proposal-based swap deposits
        match classify_proposal_swap_deposits(app_pool, network, account_id).await {
            Ok(count) if count > 0 => {
                tracing::info!(
                    "Classified {} proposal swap deposits for {}",
                    count,
                    account_id
                );
            }
            Err(e) => {
                tracing::warn!(
                    "Error classifying proposal swap deposits for {}: {}",
                    account_id,
                    e
                );
            }
            _ => {}
        }
    }

    tracing::info!(
        "Batch complete: {} outcomes, cursor now at block={}, id={}",
        batch_size,
        last_processed_block,
        last_processed_id,
    );

    Ok(batch_size)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_success_value_proposal_id() {
        assert_eq!(
            decode_success_value_u64(r#"SuccessValue("MTE=")"#),
            Some(11)
        );
        assert_eq!(
            decode_success_value_u64(r#"{"SuccessValue":"MTM2"}"#),
            Some(136)
        );
        assert_eq!(
            decode_success_value_u64(r#"  {"SuccessValue":"IDEyMyA="}  "#),
            Some(123)
        );
        assert_eq!(decode_success_value_u64(r#"SuccessValue("")"#), None);
        assert_eq!(
            decode_success_value_u64(r#"{"SuccessReceiptId":"abc"}"#),
            None
        );
        assert_eq!(decode_success_value_u64(r#"garbage "MTE=""#), None);
        assert_eq!(
            decode_success_value_u64(r#"SuccessValue("not-base64")"#),
            None
        );
        assert_eq!(
            decode_success_value_u64(r#"{"SuccessValue":"bm90LWEtbnVtYmVy"}"#),
            None
        );
    }

    #[test]
    fn test_parse_nep141_ft_transfer_to_dao() {
        let logs = r#"EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[{"old_owner_id":"alice.near","new_owner_id":"treasury.sputnik-dao.near","amount":"1000000"}]}"#;
        let events = parse_log_events(logs, "usdc.near");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].account_id, "treasury.sputnik-dao.near");
        assert_eq!(events[0].token_id, "usdc.near");
        assert_eq!(events[0].counterparty, "alice.near");
    }

    #[test]
    fn test_parse_nep141_ft_transfer_from_dao() {
        let logs = r#"EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[{"old_owner_id":"treasury.sputnik-dao.near","new_owner_id":"bob.near","amount":"5000000"}]}"#;
        let events = parse_log_events(logs, "usdc.near");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].account_id, "treasury.sputnik-dao.near");
        assert_eq!(events[0].token_id, "usdc.near");
        assert_eq!(events[0].counterparty, "bob.near");
    }

    #[test]
    fn test_parse_nep245_mt_transfer() {
        let logs = r#"EVENT_JSON:{"standard":"nep245","event":"mt_transfer","data":[{"old_owner_id":"solver.near","new_owner_id":"treasury.sputnik-dao.near","token_ids":["nep141:wrap.near"],"amounts":["100"]}]}"#;
        let events = parse_log_events(logs, "intents.near");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].account_id, "treasury.sputnik-dao.near");
        assert_eq!(events[0].token_id, "intents.near:nep141:wrap.near");
        assert_eq!(events[0].counterparty, "solver.near");
    }

    #[test]
    fn test_parse_wrap_near_plain_text() {
        let logs = "Transfer 100000000000000000000000 from alice.near to treasury.sputnik-dao.near";
        let events = parse_log_events(logs, "wrap.near");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].account_id, "treasury.sputnik-dao.near");
        assert_eq!(events[0].token_id, "wrap.near");
        assert_eq!(events[0].counterparty, "alice.near");
    }

    #[test]
    fn test_parse_wrap_near_plain_text_from_dao() {
        let logs = "Transfer 100000000000000000000000 from treasury.sputnik-dao.near to alice.near";
        let events = parse_log_events(logs, "wrap.near");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].account_id, "treasury.sputnik-dao.near");
        assert_eq!(events[0].token_id, "wrap.near");
        assert_eq!(events[0].counterparty, "alice.near");
    }

    #[test]
    fn test_parse_outcome_both_paths() {
        let outcome = IndexedDaoOutcome {
            id: "test-id".to_string(),
            executor_id: "usdc.near".to_string(),
            logs: Some(
                r#"EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[{"old_owner_id":"alice.near","new_owner_id":"treasury.sputnik-dao.near","amount":"1000000"}]}"#
                    .to_string(),
            ),
            status: Some("SuccessValue".to_string()),
            transaction_hash: Some("abc123".to_string()),
            signer_id: Some("alice.near".to_string()),
            receiver_id: Some("treasury.sputnik-dao.near".to_string()),
            gas_burnt: Some(1000),
            tokens_burnt: Some("100".to_string()),
            trigger_block_height: 180000000,
            trigger_block_hash: Some("hash".to_string()),
            trigger_block_timestamp: 1709000000000,
        };

        let events = parse_outcome_events(&outcome);
        // Path A (FT log) + Path B (receiver is DAO)
        assert_eq!(events.len(), 2);

        // Path A event
        assert_eq!(events[0].token_id, "usdc.near");
        assert_eq!(events[0].counterparty, "alice.near");

        // Path B event
        assert_eq!(events[1].token_id, "near");
        assert_eq!(events[1].counterparty, "alice.near");
    }

    #[test]
    fn test_parse_receiver_only_path_b() {
        let outcome = IndexedDaoOutcome {
            id: "test-id-2".to_string(),
            executor_id: "system".to_string(),
            logs: None,
            status: Some("SuccessValue".to_string()),
            transaction_hash: Some("tx123".to_string()),
            signer_id: Some("bob.near".to_string()),
            receiver_id: Some("treasury.sputnik-dao.near".to_string()),
            gas_burnt: Some(500),
            tokens_burnt: Some("50".to_string()),
            trigger_block_height: 180000001,
            trigger_block_hash: Some("hash2".to_string()),
            trigger_block_timestamp: 1709000001000,
        };

        let events = parse_outcome_events(&outcome);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].account_id, "treasury.sputnik-dao.near");
        assert_eq!(events[0].token_id, "near");
        assert_eq!(events[0].counterparty, "bob.near");
    }

    #[test]
    fn test_parse_irrelevant_log_skipped() {
        let logs = r#"EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[{"old_owner_id":"alice.near","new_owner_id":"bob.near","amount":"100"}]}"#;
        let events = parse_log_events(logs, "usdc.near");
        assert_eq!(events.len(), 0);
    }

    #[test]
    fn test_parse_multiple_log_lines() {
        let logs = "Some irrelevant log\nTransfer 100 from alice.near to treasury.sputnik-dao.near\nAnother log";
        let events = parse_log_events(logs, "wrap.near");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].account_id, "treasury.sputnik-dao.near");
    }

    #[test]
    fn test_parse_non_dao_receiver_no_path_b() {
        let outcome = IndexedDaoOutcome {
            id: "test-id-3".to_string(),
            executor_id: "usdc.near".to_string(),
            logs: Some(
                r#"EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[{"old_owner_id":"alice.near","new_owner_id":"treasury.sputnik-dao.near","amount":"100"}]}"#
                    .to_string(),
            ),
            status: Some("SuccessValue".to_string()),
            transaction_hash: Some("tx456".to_string()),
            signer_id: Some("alice.near".to_string()),
            receiver_id: Some("usdc.near".to_string()), // NOT a DAO
            gas_burnt: Some(500),
            tokens_burnt: Some("50".to_string()),
            trigger_block_height: 180000002,
            trigger_block_hash: Some("hash3".to_string()),
            trigger_block_timestamp: 1709000002000,
        };

        let events = parse_outcome_events(&outcome);
        // Only Path A, no Path B
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].token_id, "usdc.near");
    }

    #[test]
    fn test_timestamp_conversion() {
        let goldsky_ms: i64 = 1709000000000;
        let nanos = goldsky_ms * 1_000_000;
        assert_eq!(nanos, 1709000000000000000);

        let dt = block_timestamp_to_datetime(nanos);
        assert_eq!(dt.timestamp(), 1709000000);
    }

    #[test]
    fn test_parse_nep141_both_parties_are_daos() {
        // Transfer between two DAOs — should produce 2 events
        let logs = r#"EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[{"old_owner_id":"dao-a.sputnik-dao.near","new_owner_id":"dao-b.sputnik-dao.near","amount":"100"}]}"#;
        let events = parse_log_events(logs, "usdc.near");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].account_id, "dao-a.sputnik-dao.near");
        assert_eq!(events[0].counterparty, "dao-b.sputnik-dao.near");
        assert_eq!(events[1].account_id, "dao-b.sputnik-dao.near");
        assert_eq!(events[1].counterparty, "dao-a.sputnik-dao.near");
    }

    #[test]
    fn test_parse_empty_logs() {
        let events = parse_log_events("", "usdc.near");
        assert_eq!(events.len(), 0);
    }

    #[test]
    fn test_parse_nep141_non_transfer_event_skipped() {
        let logs = r#"EVENT_JSON:{"standard":"nep141","event":"ft_mint","data":[{"owner_id":"treasury.sputnik-dao.near","amount":"1000"}]}"#;
        let events = parse_log_events(logs, "usdc.near");
        // ft_mint is not ft_transfer — currently skipped
        assert_eq!(events.len(), 0);
    }

    #[test]
    fn test_parse_nep245_mt_mint() {
        let logs = r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_mint","data":[{"owner_id":"webassemblymusic.sputnik-dao.near","token_ids":["nep141:wrap.near"],"amounts":["5000000000000000000000000"]}]}"#;
        let events = parse_log_events(logs, "intents.near");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].account_id, "webassemblymusic.sputnik-dao.near");
        assert_eq!(events[0].token_id, "intents.near:nep141:wrap.near");
        assert_eq!(events[0].counterparty, "intents.near");
        assert_eq!(events[0].action_kind.as_deref(), Some("MINT"));
        assert!(events[0].forward_scan);
    }

    #[test]
    fn test_parse_literal_backslash_n_separator() {
        // Goldsky stores log separators as literal "\n" (backslash + n), not real newlines
        let logs = r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_mint","data":[{"owner_id":"hot-dao.sputnik-dao.near","token_ids":["137_abc"],"amounts":["142"]}]}\nEVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_transfer","data":[{"old_owner_id":"hot-dao.sputnik-dao.near","new_owner_id":"intents.near","token_ids":["137_abc"],"amounts":["142"]}]}"#;
        let events = parse_log_events(logs, "v2_1.omni.hot.tg");
        // mt_mint produces 1 event (owner is DAO), mt_transfer produces 1 event (old_owner is DAO)
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].account_id, "hot-dao.sputnik-dao.near");
        assert_eq!(events[0].token_id, "v2_1.omni.hot.tg:137_abc");
        assert_eq!(events[0].counterparty, "v2_1.omni.hot.tg");
        assert_eq!(events[0].action_kind.as_deref(), Some("MINT"));
        assert_eq!(events[1].account_id, "hot-dao.sputnik-dao.near");
        assert_eq!(events[1].token_id, "v2_1.omni.hot.tg:137_abc");
        assert_eq!(events[1].counterparty, "intents.near");
    }

    #[test]
    fn test_parse_executor_only_path_c() {
        // executor_id is a DAO, receiver_id is NOT — Path C fires
        let outcome = IndexedDaoOutcome {
            id: "test-path-c".to_string(),
            executor_id: "treasury.sputnik-dao.near".to_string(),
            logs: None,
            status: Some("{\"SuccessValue\":\"NDg=\"}".to_string()),
            transaction_hash: Some("tx789".to_string()),
            signer_id: Some("sponsor.trezu.near".to_string()),
            receiver_id: Some("olskik.near".to_string()),
            gas_burnt: Some(1000),
            tokens_burnt: Some("100".to_string()),
            trigger_block_height: 188066404,
            trigger_block_hash: Some("hash".to_string()),
            trigger_block_timestamp: 1772623617359,
        };

        let events = parse_outcome_events(&outcome);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].account_id, "treasury.sputnik-dao.near");
        assert_eq!(events[0].token_id, "near");
        assert_eq!(events[0].counterparty, "olskik.near");
    }

    #[test]
    fn test_parse_executor_and_receiver_both_dao() {
        // Both executor_id and receiver_id are DAOs — only Path B, no Path C duplicate
        let outcome = IndexedDaoOutcome {
            id: "test-both-dao".to_string(),
            executor_id: "treasury.sputnik-dao.near".to_string(),
            logs: None,
            status: Some("{\"SuccessValue\":\"\"}".to_string()),
            transaction_hash: Some("tx-both".to_string()),
            signer_id: Some("sponsor.trezu.near".to_string()),
            receiver_id: Some("treasury.sputnik-dao.near".to_string()),
            gas_burnt: Some(500),
            tokens_burnt: Some("50".to_string()),
            trigger_block_height: 188066398,
            trigger_block_hash: Some("hash2".to_string()),
            trigger_block_timestamp: 1772623613898,
        };

        let events = parse_outcome_events(&outcome);
        // Only Path B fires (receiver is DAO), Path C skipped
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].account_id, "treasury.sputnik-dao.near");
        assert_eq!(events[0].token_id, "near");
        assert_eq!(events[0].counterparty, "sponsor.trezu.near");
    }

    #[test]
    fn test_parse_path_a_and_path_c() {
        // Executor is a DAO, receiver is NOT a DAO, and logs mention the DAO.
        // Path A fires (log event) + Path C fires (executor is DAO, receiver isn't).
        // Path B does NOT fire (receiver isn't a DAO).
        let outcome = IndexedDaoOutcome {
            id: "test-a-and-c".to_string(),
            executor_id: "treasury.sputnik-dao.near".to_string(),
            logs: Some(
                r#"EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[{"old_owner_id":"treasury.sputnik-dao.near","new_owner_id":"alice.near","amount":"100"}]}"#
                    .to_string(),
            ),
            status: Some("{\"SuccessValue\":\"\"}".to_string()),
            transaction_hash: Some("tx-ac".to_string()),
            signer_id: Some("sponsor.trezu.near".to_string()),
            receiver_id: Some("usdc.near".to_string()),
            gas_burnt: Some(1000),
            tokens_burnt: Some("100".to_string()),
            trigger_block_height: 188000000,
            trigger_block_hash: Some("hash3".to_string()),
            trigger_block_timestamp: 1772600000000,
        };

        let events = parse_outcome_events(&outcome);
        assert_eq!(events.len(), 2);
        // Path A: FT transfer from treasury DAO
        assert_eq!(events[0].account_id, "treasury.sputnik-dao.near");
        assert_eq!(events[0].token_id, "treasury.sputnik-dao.near");
        assert_eq!(events[0].counterparty, "alice.near");
        // Path C: executor DAO gets NEAR event
        assert_eq!(events[1].account_id, "treasury.sputnik-dao.near");
        assert_eq!(events[1].token_id, "near");
        assert_eq!(events[1].counterparty, "usdc.near");
    }

    #[test]
    fn test_parse_nep245_mt_burn() {
        // mt_burn event from intents.near — DAO is the owner_id losing tokens.
        let outcome = IndexedDaoOutcome {
            id: "test-mt-burn".to_string(),
            executor_id: "intents.near".to_string(),
            logs: Some(
                r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_burn","data":[{"owner_id":"treasury.sputnik-dao.near","token_ids":["nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"],"amounts":["10000000"],"memo":"withdraw"}]}"#
                    .to_string(),
            ),
            status: Some("{\"SuccessReceiptId\":\"abc\"}".to_string()),
            transaction_hash: Some("tx-burn".to_string()),
            signer_id: Some("sponsor.trezu.near".to_string()),
            receiver_id: Some("someone.near".to_string()),
            gas_burnt: Some(1000),
            tokens_burnt: Some("100".to_string()),
            trigger_block_height: 188000000,
            trigger_block_hash: Some("hash-burn".to_string()),
            trigger_block_timestamp: 1772600000000,
        };

        let events = parse_outcome_events(&outcome);
        // Path A fires for mt_burn (DAO is owner losing tokens)
        let burn_events: Vec<_> = events
            .iter()
            .filter(|e| e.action_kind.as_deref() == Some("BURN"))
            .collect();
        assert_eq!(burn_events.len(), 1);
        assert_eq!(burn_events[0].account_id, "treasury.sputnik-dao.near");
        assert_eq!(
            burn_events[0].token_id,
            "intents.near:nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
        );
        assert_eq!(burn_events[0].counterparty, "intents.near");
    }

    // -----------------------------------------------------------------------
    // Real on-chain log data tests
    // Verified against webassemblymusic-treasury.sputnik-dao.near transactions
    // -----------------------------------------------------------------------

    #[test]
    fn test_real_nep141_ft_transfer_incoming_arizcredits() {
        // Block 187700484, tx 9usX85qKp3fY9cav1X7i8WrmTZ8K9r4qEAvDGLWi8iNK
        // petersalomonsen.near sends 0.2 arizcredits to DAO
        let logs = r#"EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"petersalomonsen.near","new_owner_id":"webassemblymusic-treasury.sputnik-dao.near","amount":"200000"}]}"#;
        let events = parse_log_events(logs, "arizcredits.near");
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].account_id,
            "webassemblymusic-treasury.sputnik-dao.near"
        );
        assert_eq!(events[0].token_id, "arizcredits.near");
        assert_eq!(events[0].counterparty, "petersalomonsen.near");
        assert_eq!(events[0].action_kind.as_deref(), Some("TRANSFER"));
    }

    #[test]
    fn test_real_nep141_ft_transfer_outgoing_usdc() {
        // Block 188373079, tx 9EehtCBSY4a2szcqFHRoQ1LUUrQkBwJQHiu7m2gmQyEd
        // DAO sends 1.2 USDC to petersalomonsen.near
        let logs = r#"EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"webassemblymusic-treasury.sputnik-dao.near","new_owner_id":"petersalomonsen.near","amount":"1200000","memo":"* Title: Payment Request"}]}"#;
        let events = parse_log_events(
            logs,
            "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        );
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].account_id,
            "webassemblymusic-treasury.sputnik-dao.near"
        );
        assert_eq!(
            events[0].token_id,
            "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
        );
        assert_eq!(events[0].counterparty, "petersalomonsen.near");
        assert_eq!(events[0].action_kind.as_deref(), Some("TRANSFER"));
    }

    #[test]
    fn test_real_wrap_near_plain_text_incoming() {
        // Block 187693308, tx 2JfropCvbKY879mi35p4SfV8UYYEXt6HaK1y8q6KruTS
        // petersalomonsen.near wraps 0.35 NEAR and sends to DAO
        let logs = "Transfer 350000000000000000000000 from petersalomonsen.near to webassemblymusic-treasury.sputnik-dao.near";
        let events = parse_log_events(logs, "wrap.near");
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].account_id,
            "webassemblymusic-treasury.sputnik-dao.near"
        );
        assert_eq!(events[0].token_id, "wrap.near");
        assert_eq!(events[0].counterparty, "petersalomonsen.near");
        assert_eq!(events[0].action_kind.as_deref(), Some("TRANSFER"));
    }

    #[test]
    fn test_real_nep245_mt_burn_intents_usdc() {
        // Block 188102395, tx 9noKHxN7Rj7tNhZVfZZbCRu1ZiWSq8cqDr9RAwX1TL7U
        // DAO burns 10 USDC via intents swap (from webassemblymusic fixtures)
        let logs = r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_burn","data":[{"owner_id":"webassemblymusic-treasury.sputnik-dao.near","token_ids":["nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"],"amounts":["10000000"],"memo":"withdraw"}]}"#;
        let events = parse_log_events(logs, "intents.near");
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].account_id,
            "webassemblymusic-treasury.sputnik-dao.near"
        );
        assert_eq!(
            events[0].token_id,
            "intents.near:nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
        );
        // Counterparty for mt_burn is the executor (intents.near), since the DAO
        // is burning tokens held on the intents contract
        assert_eq!(events[0].counterparty, "intents.near");
        assert_eq!(events[0].action_kind.as_deref(), Some("BURN"));
    }
}
