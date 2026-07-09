use std::str::FromStr;
use std::time::Duration;

use axum::http::StatusCode;
use bigdecimal::BigDecimal;
use serde::Deserialize;
use serde_json::Value;

use crate::AppState;
use crate::handlers::balance_changes::utils::block_timestamp_to_datetime;
use crate::handlers::public_history::bronze::NearblocksPriority;
use crate::handlers::public_history::bronze::store::{
    BronzePublicHistoryEvent, PublicHistorySource,
};

const NEARBLOCKS_V3_BASE_URL: &str = "https://api-beta.nearblocks.io";

#[derive(Debug, Clone)]
pub struct NearblocksPage {
    pub events: Vec<BronzePublicHistoryEvent>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NearblocksMeta {
    next_page: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NearblocksBlock {
    block_height: String,
    block_timestamp: String,
}

#[derive(Debug, Deserialize)]
struct NearblocksFtTransfer {
    affected_account_id: String,
    block: NearblocksBlock,
    #[serde(default)]
    block_timestamp: Option<String>,
    cause: Option<String>,
    contract_account_id: String,
    delta_amount: String,
    event_index: i32,
    involved_account_id: Option<String>,
    meta: Option<NearblocksFtMeta>,
    receipt_id: String,
    transaction_hash: String,
}

#[derive(Debug, Deserialize)]
struct NearblocksFtMeta {
    decimals: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct NearblocksMtTransfer {
    affected_account_id: String,
    block: NearblocksBlock,
    #[serde(default)]
    block_timestamp: Option<String>,
    cause: Option<String>,
    contract_account_id: String,
    delta_amount: String,
    event_index: i32,
    involved_account_id: Option<String>,
    base_meta: Option<NearblocksMtBaseMeta>,
    receipt_id: String,
    token_id: String,
    transaction_hash: String,
}

#[derive(Debug, Deserialize)]
struct NearblocksMtBaseMeta {
    decimals: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct NearblocksReceipt {
    receipt_id: String,
    #[serde(default, alias = "originated_from_transaction_hash")]
    transaction_hash: Option<String>,
    predecessor_account_id: Option<String>,
    receiver_account_id: Option<String>,
    block: NearblocksBlock,
    #[serde(default)]
    actions: Vec<NearblocksReceiptAction>,
    #[serde(default)]
    outcome: Option<NearblocksReceiptOutcome>,
    #[serde(default)]
    actions_agg: Option<NearblocksReceiptActionsAgg>,
}

#[derive(Debug, Deserialize)]
struct NearblocksReceiptAction {
    action: String,
    method: Option<String>,
    args: Option<Value>,
    deposit: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NearblocksReceiptActionsAgg {
    deposit: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NearblocksReceiptOutcome {
    status: Option<Value>,
}

fn parse_bigdecimal(value: &str, field: &str) -> Result<BigDecimal, (StatusCode, String)> {
    BigDecimal::from_str(value).map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("NearBlocks field {} is not numeric: {}", field, e),
        )
    })
}

fn parse_i64(value: &str, field: &str) -> Result<i64, (StatusCode, String)> {
    value.parse::<i64>().map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("NearBlocks field {} is not i64: {}", field, e),
        )
    })
}

fn block_timestamp<'a>(block: &'a NearblocksBlock, override_timestamp: Option<&'a str>) -> &'a str {
    override_timestamp.unwrap_or(&block.block_timestamp)
}

fn success_status(outcome: Option<&NearblocksReceiptOutcome>) -> Option<bool> {
    let status = outcome?.status.as_ref()?;
    if let Some(success) = status.as_bool() {
        return Some(success);
    }
    if status.get("SuccessValue").is_some()
        || status.get("SuccessReceiptId").is_some()
        || status.as_str() == Some("SUCCESS")
    {
        return Some(true);
    }
    if status.get("Failure").is_some() || status.as_str() == Some("FAILURE") {
        return Some(false);
    }
    None
}

/// Max attempts (including the first) before a 429 is surfaced as an error.
const NEARBLOCKS_MAX_ATTEMPTS: u32 = 4;
/// Fallback backoff when a 429 response omits a usable `Retry-After` header.
const NEARBLOCKS_DEFAULT_BACKOFF: Duration = Duration::from_secs(6);
/// Cap on any single backoff so a hostile `Retry-After` can't stall a worker.
const NEARBLOCKS_MAX_BACKOFF: Duration = Duration::from_secs(30);

/// Parse a `Retry-After` header (delta-seconds form) into a bounded delay.
fn retry_after_delay(response: &reqwest::Response) -> Duration {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(NEARBLOCKS_DEFAULT_BACKOFF)
        .min(NEARBLOCKS_MAX_BACKOFF)
}

async fn fetch_raw_page(
    state: &AppState,
    account_id: &str,
    path: &str,
    cursor: Option<&str>,
    limit: u32,
    priority: NearblocksPriority,
) -> Result<Value, (StatusCode, String)> {
    let Some(api_key) = state.env_vars.nearblocks_api_key.as_ref() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "NEARBLOCKS_API_KEY is not configured".to_string(),
        ));
    };

    let url = format!(
        "{}/v3/accounts/{}/{}",
        NEARBLOCKS_V3_BASE_URL, account_id, path
    );
    let mut params = vec![("per_page", limit.to_string())];
    if let Some(cursor) = cursor {
        params.push(("cursor", cursor.to_string()));
    }

    let mut attempt = 0;
    loop {
        attempt += 1;

        // Draw on the shared NearBlocks budget before every request so all
        // callers stay collectively under the plan's per-minute ceiling; latest
        // requests preempt backfill for the next permit.
        state.nearblocks_gate.acquire(priority).await;

        let response = state
            .http_client
            .get(&url)
            .query(&params)
            .header("accept", "application/json")
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await
            .map_err(|e| {
                (
                    StatusCode::BAD_GATEWAY,
                    format!("NearBlocks request failed: {}", e),
                )
            })?;

        let status = response.status();

        if status == StatusCode::TOO_MANY_REQUESTS && attempt < NEARBLOCKS_MAX_ATTEMPTS {
            let backoff = retry_after_delay(&response);
            tracing::warn!(
                path = path,
                attempt,
                backoff_secs = backoff.as_secs(),
                "NearBlocks rate limited (429); backing off and retrying"
            );
            tokio::time::sleep(backoff).await;
            continue;
        }

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err((
                StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
                format!("NearBlocks returned {}: {}", status, body),
            ));
        }

        return response.json::<Value>().await.map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("NearBlocks response is not JSON: {}", e),
            )
        });
    }
}

fn raw_items(raw: &Value) -> Result<&Vec<Value>, (StatusCode, String)> {
    raw.get("txns")
        .or_else(|| raw.get("data"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            (
                StatusCode::BAD_GATEWAY,
                "NearBlocks response missing txns/data array".to_string(),
            )
        })
}

fn next_cursor(raw: &Value) -> Option<String> {
    raw.get("meta")
        .and_then(|meta| serde_json::from_value::<NearblocksMeta>(meta.clone()).ok())
        .and_then(|meta| meta.next_page)
}

pub async fn fetch_ft_transfers(
    state: &AppState,
    account_id: &str,
    cursor: Option<&str>,
    limit: u32,
    priority: NearblocksPriority,
) -> Result<NearblocksPage, (StatusCode, String)> {
    let raw = fetch_raw_page(state, account_id, "ft-txns", cursor, limit, priority).await?;
    let mut events = Vec::new();

    for (index, raw_item) in raw_items(&raw)?.iter().enumerate() {
        let item: NearblocksFtTransfer = serde_json::from_value(raw_item.clone()).map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("NearBlocks FT item {} parse failed: {}", index, e),
            )
        })?;
        let timestamp = block_timestamp(&item.block, item.block_timestamp.as_deref()).to_string();
        let block_timestamp = parse_bigdecimal(&timestamp, "block_timestamp")?;
        let block_height = parse_i64(&item.block.block_height, "block_height")?;
        let delta = parse_bigdecimal(&item.delta_amount, "delta_amount")?;

        events.push(BronzePublicHistoryEvent {
            account_id: account_id.to_string(),
            source: PublicHistorySource::NearblocksFt,
            source_event_key: format!(
                "{}:{}:{}:{}:{}",
                account_id,
                item.transaction_hash,
                item.receipt_id,
                item.event_index,
                item.contract_account_id
            ),
            transaction_hash: Some(item.transaction_hash),
            receipt_id: Some(item.receipt_id),
            event_index: Some(item.event_index),
            block_height,
            block_timestamp,
            block_time: block_timestamp_to_datetime(parse_i64(&timestamp, "block_timestamp")?),
            // Preserve NearBlocks account semantics: affected is the balance owner,
            // involved is the counterparty, contract is the FT token contract.
            affected_account_id: item.affected_account_id,
            involved_account_id: item.involved_account_id,
            contract_account_id: Some(item.contract_account_id),
            token_id: None,
            cause: item.cause,
            action_kind: None,
            method_name: None,
            delta_amount_raw: Some(delta),
            decimals: item.meta.and_then(|meta| meta.decimals),
            deposit_raw: None,
            outcome_status: None,
            raw_payload: raw_item.clone(),
        });
    }

    Ok(NearblocksPage {
        events,
        next_cursor: next_cursor(&raw),
    })
}

pub async fn fetch_mt_transfers(
    state: &AppState,
    account_id: &str,
    cursor: Option<&str>,
    limit: u32,
    priority: NearblocksPriority,
) -> Result<NearblocksPage, (StatusCode, String)> {
    let raw = fetch_raw_page(state, account_id, "mt-txns", cursor, limit, priority).await?;
    let mut events = Vec::new();

    for (index, raw_item) in raw_items(&raw)?.iter().enumerate() {
        let item: NearblocksMtTransfer = serde_json::from_value(raw_item.clone()).map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("NearBlocks MT item {} parse failed: {}", index, e),
            )
        })?;
        let timestamp = block_timestamp(&item.block, item.block_timestamp.as_deref()).to_string();
        let block_timestamp = parse_bigdecimal(&timestamp, "block_timestamp")?;
        let block_height = parse_i64(&item.block.block_height, "block_height")?;
        let delta = parse_bigdecimal(&item.delta_amount, "delta_amount")?;

        events.push(BronzePublicHistoryEvent {
            account_id: account_id.to_string(),
            source: PublicHistorySource::NearblocksMt,
            source_event_key: format!(
                "{}:{}:{}:{}:{}:{}",
                account_id,
                item.transaction_hash,
                item.receipt_id,
                item.event_index,
                item.contract_account_id,
                item.token_id
            ),
            transaction_hash: Some(item.transaction_hash),
            receipt_id: Some(item.receipt_id),
            event_index: Some(item.event_index),
            block_height,
            block_timestamp,
            block_time: block_timestamp_to_datetime(parse_i64(&timestamp, "block_timestamp")?),
            // Preserve NearBlocks account semantics: affected is the balance owner,
            // involved is the counterparty, contract is the MT token contract.
            affected_account_id: item.affected_account_id,
            involved_account_id: item.involved_account_id,
            contract_account_id: Some(item.contract_account_id),
            token_id: Some(item.token_id),
            cause: item.cause,
            action_kind: None,
            method_name: None,
            delta_amount_raw: Some(delta),
            decimals: item.base_meta.and_then(|meta| meta.decimals),
            deposit_raw: None,
            outcome_status: None,
            raw_payload: raw_item.clone(),
        });
    }

    Ok(NearblocksPage {
        events,
        next_cursor: next_cursor(&raw),
    })
}

pub async fn fetch_receipts(
    state: &AppState,
    account_id: &str,
    cursor: Option<&str>,
    limit: u32,
    priority: NearblocksPriority,
) -> Result<NearblocksPage, (StatusCode, String)> {
    let raw = fetch_raw_page(state, account_id, "receipts", cursor, limit, priority).await?;
    let mut events = Vec::new();

    for (receipt_index, raw_item) in raw_items(&raw)?.iter().enumerate() {
        let item: NearblocksReceipt = serde_json::from_value(raw_item.clone()).map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!(
                    "NearBlocks receipt item {} parse failed: {}",
                    receipt_index, e
                ),
            )
        })?;
        let timestamp = item.block.block_timestamp.clone();
        let block_timestamp = parse_bigdecimal(&timestamp, "block_timestamp")?;
        let block_height = parse_i64(&item.block.block_height, "block_height")?;
        let outcome_status = success_status(item.outcome.as_ref());
        let actions = if item.actions.is_empty() {
            vec![NearblocksReceiptAction {
                action: "UNKNOWN".to_string(),
                method: None,
                args: None,
                deposit: None,
            }]
        } else {
            item.actions
        };

        let aggregate_deposit = item
            .actions_agg
            .as_ref()
            .and_then(|agg| agg.deposit.as_deref())
            .filter(|deposit| !deposit.is_empty());

        for (action_index, action) in actions.into_iter().enumerate() {
            let event_index = i32::try_from(action_index).unwrap_or(i32::MAX);
            let deposit = action
                .deposit
                .as_deref()
                .filter(|deposit| !deposit.is_empty());
            let deposit_raw = deposit
                .or_else(|| {
                    action
                        .action
                        .eq_ignore_ascii_case("TRANSFER")
                        .then_some(aggregate_deposit)
                        .flatten()
                })
                .and_then(|deposit| BigDecimal::from_str(deposit).ok());
            events.push(BronzePublicHistoryEvent {
                account_id: account_id.to_string(),
                source: PublicHistorySource::NearblocksReceipt,
                source_event_key: format!("{}:{}:{}", account_id, item.receipt_id, action_index),
                transaction_hash: item.transaction_hash.clone(),
                receipt_id: Some(item.receipt_id.clone()),
                event_index: Some(event_index),
                block_height,
                block_timestamp: block_timestamp.clone(),
                block_time: block_timestamp_to_datetime(parse_i64(&timestamp, "block_timestamp")?),
                // Receipts are not token balance rows: use receiver as affected/contract
                // and predecessor as involved so proposal/linking code can reason over them.
                affected_account_id: item
                    .receiver_account_id
                    .clone()
                    .unwrap_or_else(|| account_id.to_string()),
                involved_account_id: item.predecessor_account_id.clone(),
                contract_account_id: item.receiver_account_id.clone(),
                token_id: None,
                cause: None,
                action_kind: Some(action.action),
                method_name: action.method,
                delta_amount_raw: None,
                decimals: Some(24),
                deposit_raw,
                outcome_status,
                raw_payload: serde_json::json!({
                    "receipt": raw_item,
                    "action_index": action_index,
                    "action": action.args
                }),
            });
        }
    }

    Ok(NearblocksPage {
        events,
        next_cursor: next_cursor(&raw),
    })
}
