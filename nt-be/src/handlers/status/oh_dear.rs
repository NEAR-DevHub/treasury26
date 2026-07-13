use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use reqwest::RequestBuilder;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use super::config::OhDearHealthConfig;
use crate::AppState;
use crate::constants::external_apis::{
    FASTNEAR_ACCOUNT_API_BASE, FASTNEAR_TRANSFERS_BASE, NEARBLOCKS_API_BASE, NEARDATA_DEFAULT_BASE,
};
use crate::utils::jsonrpc::{JsonRpcRequest, JsonRpcResponse};

pub const SUPPORTED_SERVICES: &[&str] = &[
    "backend",
    "bridge-rpc",
    "defillama",
    "exchange",
    "fastnear",
    "goldsky",
    "intents-explorer",
    "near-intents",
    "near-protocol",
    "near-rpc",
    "nearblocks",
    "neardata",
];
const NEAR_STATUS_UP: &str = "up";
const INTENTS_POST_INCIDENT: &str = "incident";
const INTENTS_POST_MAINTENANCE: &str = "maintenance";

const BACKEND_DATABASE_CHECK: CheckDefinition = CheckDefinition {
    name: "backend.database",
    label: "Backend database",
    notification_subject: "Database",
    short_subject: "Database",
};
const BRIDGE_RPC_CHECK: CheckDefinition = CheckDefinition {
    name: "bridge-rpc.supported-tokens",
    label: "Bridge RPC",
    notification_subject: "Bridge RPC",
    short_subject: "Bridge RPC",
};
const EXCHANGE_QUOTE_CHECK: CheckDefinition = CheckDefinition {
    name: "exchange.quote",
    label: "Exchange quote",
    notification_subject: "Quote API",
    short_subject: "Quote",
};
const NEAR_INTENTS_CHECK: CheckDefinition = CheckDefinition {
    name: "near-intents.status",
    label: "NEAR Intents",
    notification_subject: "NEAR Intents status API",
    short_subject: "Status",
};
const NEAR_PROTOCOL_CHECK: CheckDefinition = CheckDefinition {
    name: "near-protocol.status-page",
    label: "NEAR Protocol",
    notification_subject: "NEAR protocol status API",
    short_subject: "Status",
};
const NEAR_RPC_CHECK: CheckDefinition = CheckDefinition {
    name: "near-rpc.status",
    label: "NEAR RPC",
    notification_subject: "NEAR RPC",
    short_subject: "RPC",
};
const FASTNEAR_CHECK: CheckDefinition = CheckDefinition {
    name: "fastnear.api",
    label: "FastNear",
    notification_subject: "FastNear API",
    short_subject: "FastNear",
};
const GOLDSKY_CHECK: CheckDefinition = CheckDefinition {
    name: "goldsky.database",
    label: "Goldsky DB",
    notification_subject: "Goldsky database",
    short_subject: "Goldsky",
};
const DEFILLAMA_CHECK: CheckDefinition = CheckDefinition {
    name: "defillama.prices",
    label: "DeFiLlama",
    notification_subject: "DeFiLlama prices API",
    short_subject: "DeFiLlama",
};
const NEARBLOCKS_CHECK: CheckDefinition = CheckDefinition {
    name: "nearblocks.api",
    label: "NearBlocks",
    notification_subject: "NearBlocks API",
    short_subject: "NearBlocks",
};
const INTENTS_EXPLORER_CHECK: CheckDefinition = CheckDefinition {
    name: "intents-explorer.api",
    label: "Intents Explorer",
    notification_subject: "Intents Explorer API",
    short_subject: "Intents Explorer",
};
const NEARDATA_CHECK: CheckDefinition = CheckDefinition {
    name: "neardata.api",
    label: "Neardata",
    notification_subject: "Neardata API",
    short_subject: "Neardata",
};

#[derive(Debug, Clone, Copy)]
enum StatusService {
    Backend,
    BridgeRpc,
    DeFiLlama,
    Exchange,
    FastNear,
    Goldsky,
    IntentsExplorer,
    NearIntents,
    NearProtocol,
    NearRpc,
    Nearblocks,
    Neardata,
}

impl StatusService {
    fn parse(service: &str) -> Option<Self> {
        match service {
            "backend" => Some(Self::Backend),
            "bridge-rpc" => Some(Self::BridgeRpc),
            "defillama" => Some(Self::DeFiLlama),
            "exchange" => Some(Self::Exchange),
            "fastnear" => Some(Self::FastNear),
            "goldsky" => Some(Self::Goldsky),
            "intents-explorer" => Some(Self::IntentsExplorer),
            "near-intents" => Some(Self::NearIntents),
            "near-protocol" => Some(Self::NearProtocol),
            "near-rpc" => Some(Self::NearRpc),
            "nearblocks" => Some(Self::Nearblocks),
            "neardata" => Some(Self::Neardata),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct CheckDefinition {
    name: &'static str,
    label: &'static str,
    notification_subject: &'static str,
    short_subject: &'static str,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OhDearStatus {
    Ok,
    Warning,
    Failed,
    Crashed,
    Skipped,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OhDearCheckResult {
    pub name: String,
    pub label: String,
    pub status: OhDearStatus,
    pub notification_message: String,
    pub short_summary: String,
    pub meta: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OhDearResponse {
    pub finished_at: i64,
    pub check_results: Vec<OhDearCheckResult>,
}

#[derive(Debug, Clone, Copy)]
enum HealthHttpError {
    Timeout,
    RequestFailed,
    UnsuccessfulStatus(u16),
    InvalidJson,
}

#[derive(Debug, Deserialize)]
struct NearStatusPage {
    #[serde(rename = "summarizedStatus")]
    summarized_status: String,
    monitors: NearStatusMonitorGroups,
}

#[derive(Debug, Deserialize)]
struct NearStatusMonitorGroups {
    mainnet: Vec<NearStatusMonitor>,
}

#[derive(Debug, Deserialize)]
struct NearStatusMonitor {
    label: String,
    status: String,
}

#[derive(Debug, Deserialize)]
pub struct IntentsStatusResponse {
    pub posts: Vec<IntentsStatusPost>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct IntentsStatusPost {
    pub id: Option<String>,
    pub title: String,
    pub post_type: String,
    pub starts_at: Option<i64>,
    pub ends_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RpcStatusResponse {
    result: RpcStatusResult,
}

#[derive(Debug, Deserialize)]
struct RpcStatusResult {
    sync_info: RpcSyncInfo,
}

#[derive(Debug, Deserialize)]
struct RpcSyncInfo {
    latest_block_height: u64,
    latest_block_time: String,
    syncing: bool,
}

async fn send_json_check<T>(
    request: RequestBuilder,
    timeout: Duration,
) -> Result<T, HealthHttpError>
where
    T: DeserializeOwned,
{
    let response = match tokio::time::timeout(timeout, request.send()).await {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => return Err(HealthHttpError::RequestFailed),
        Err(_) => return Err(HealthHttpError::Timeout),
    };

    if !response.status().is_success() {
        return Err(HealthHttpError::UnsuccessfulStatus(
            response.status().as_u16(),
        ));
    }

    response
        .json::<T>()
        .await
        .map_err(|_| HealthHttpError::InvalidJson)
}

async fn fetch_json_check<T, F>(
    request: RequestBuilder,
    config: &OhDearHealthConfig,
    check: CheckDefinition,
    extra_meta: Value,
    map_ok: F,
) -> OhDearCheckResult
where
    T: DeserializeOwned,
    F: FnOnce(T, u128) -> OhDearCheckResult,
{
    let started = Instant::now();
    let result =
        send_json_check::<T>(request, Duration::from_secs(config.http_timeout_seconds)).await;
    let duration_ms = started.elapsed().as_millis();

    match result {
        Ok(payload) => map_ok(payload, duration_ms),
        Err(error) => check.failed_http(error, duration_ms, extra_meta),
    }
}

pub async fn run_service_check(state: &AppState, service: &str) -> Option<OhDearCheckResult> {
    let service = StatusService::parse(service)?;
    Some(match service {
        StatusService::Backend => check_backend(state).await,
        StatusService::BridgeRpc => check_bridge_rpc(state).await,
        StatusService::DeFiLlama => check_defillama(state).await,
        StatusService::Exchange => check_exchange(state).await,
        StatusService::FastNear => check_fastnear(state).await,
        StatusService::Goldsky => check_goldsky(state).await,
        StatusService::IntentsExplorer => check_intents_explorer(state).await,
        StatusService::NearIntents => check_near_intents(state).await,
        StatusService::NearProtocol => check_near_protocol(state).await,
        StatusService::NearRpc => check_near_rpc(state).await,
        StatusService::Nearblocks => check_nearblocks(state).await,
        StatusService::Neardata => check_neardata(state).await,
    })
}

/// Whether the status-monitor should treat a check result as an incident.
///
/// Soft `warning` is only actionable for `near-intents` (maintenance). Other
/// services' warnings (e.g. near-protocol summary, near-rpc syncing/stale) are
/// treated as healthy so they do not open incidents or page Telegram.
pub fn is_unhealthy_for_monitor(service: &str, status: &OhDearStatus) -> bool {
    match status {
        OhDearStatus::Failed | OhDearStatus::Crashed => true,
        OhDearStatus::Warning => service == "near-intents",
        OhDearStatus::Ok | OhDearStatus::Skipped => false,
    }
}

pub async fn get_status(
    State(state): State<Arc<AppState>>,
    Path(service): Path<String>,
) -> Result<Json<OhDearResponse>, (StatusCode, Json<Value>)> {
    let Some(service) = StatusService::parse(&service) else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": "unsupported_service",
                "supported": SUPPORTED_SERVICES
            })),
        ));
    };

    let result = match service {
        StatusService::Backend => check_backend(&state).await,
        StatusService::BridgeRpc => check_bridge_rpc(&state).await,
        StatusService::DeFiLlama => check_defillama(&state).await,
        StatusService::Exchange => check_exchange(&state).await,
        StatusService::FastNear => check_fastnear(&state).await,
        StatusService::Goldsky => check_goldsky(&state).await,
        StatusService::IntentsExplorer => check_intents_explorer(&state).await,
        StatusService::NearIntents => check_near_intents(&state).await,
        StatusService::NearProtocol => check_near_protocol(&state).await,
        StatusService::NearRpc => check_near_rpc(&state).await,
        StatusService::Nearblocks => check_nearblocks(&state).await,
        StatusService::Neardata => check_neardata(&state).await,
    };

    Ok(Json(OhDearResponse {
        finished_at: Utc::now().timestamp(),
        check_results: vec![result],
    }))
}

async fn check_backend(state: &AppState) -> OhDearCheckResult {
    let config = OhDearHealthConfig::default();
    let started = Instant::now();
    let db_connected = tokio::time::timeout(
        Duration::from_secs(config.database_timeout_seconds),
        sqlx::query("SELECT 1").fetch_one(&state.db_pool),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .is_some();

    if db_connected {
        BACKEND_DATABASE_CHECK.ok(
            "Database OK",
            json!({
                "pool_size": state.db_pool.size(),
                "idle_connections": state.db_pool.num_idle(),
                "duration_ms": started.elapsed().as_millis()
            }),
        )
    } else {
        BACKEND_DATABASE_CHECK.failed(
            "Database connection failed",
            "Database unavailable",
            json!({
                "pool_size": state.db_pool.size(),
                "idle_connections": state.db_pool.num_idle(),
                "duration_ms": started.elapsed().as_millis()
            }),
        )
    }
}

async fn check_bridge_rpc(state: &AppState) -> OhDearCheckResult {
    let config = OhDearHealthConfig::default();
    let rpc_request = JsonRpcRequest::new(
        "supported_tokens",
        "supportedTokensFetchAll",
        vec![json!({})],
    );
    let request = state
        .http_client
        .post(&state.env_vars.bridge_rpc_url)
        .header("content-type", "application/json")
        .json(&rpc_request);

    fetch_json_check::<JsonRpcResponse<Value>, _>(
        request,
        &config,
        BRIDGE_RPC_CHECK,
        json!({ "method": "supportedTokensFetchAll" }),
        map_bridge_rpc_status,
    )
    .await
}

fn map_bridge_rpc_status(body: JsonRpcResponse<Value>, duration_ms: u128) -> OhDearCheckResult {
    if let Some(error) = body.error {
        return BRIDGE_RPC_CHECK.failed(
            &format!("Bridge RPC returned an error: {}", error.message),
            "Bridge RPC error",
            json!({
                "duration_ms": duration_ms,
                "method": "supportedTokensFetchAll",
                "error": error.message
            }),
        );
    }

    if body.result.is_some() {
        return BRIDGE_RPC_CHECK.ok(
            "Bridge RPC reachable",
            json!({
                "duration_ms": duration_ms,
                "method": "supportedTokensFetchAll"
            }),
        );
    }

    BRIDGE_RPC_CHECK.failed(
        "Bridge RPC response was missing result data",
        "Invalid Bridge RPC response",
        json!({
            "duration_ms": duration_ms,
            "method": "supportedTokensFetchAll",
            "error": "missing_result"
        }),
    )
}

async fn check_exchange(state: &AppState) -> OhDearCheckResult {
    let config = OhDearHealthConfig::default();
    let url = format!("{}/v0/quote", state.env_vars.oneclick_api_url);
    let deadline =
        (Utc::now() + chrono::Duration::hours(config.exchange_deadline_hours)).to_rfc3339();
    let body = json!({
        "dry": true,
        "swapType": &config.exchange_swap_type,
        "slippageTolerance": config.exchange_slippage_tolerance,
        "originAsset": &config.exchange_origin_asset,
        "depositType": &config.exchange_deposit_type,
        "destinationAsset": &config.exchange_destination_asset,
        "amount": &config.exchange_amount,
        "refundTo": &config.exchange_account_id,
        "refundType": &config.exchange_refund_type,
        "recipient": &config.exchange_account_id,
        "recipientType": &config.exchange_recipient_type,
        "deadline": deadline,
        "quoteWaitingTimeMs": config.exchange_quote_waiting_time_ms
    });

    let mut request = state
        .http_client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body);

    if let Some(token) = state.env_vars.oneclick_jwt_token.as_deref() {
        request = request.header("Authorization", format!("Bearer {}", token));
    }

    if let Some(api_key) = state.env_vars.oneclick_api_key.as_deref() {
        request = request.header("x-api-key", api_key);
    }

    let route = config.exchange_route_label.clone();
    fetch_json_check::<Value, _>(
        request,
        &config,
        EXCHANGE_QUOTE_CHECK,
        json!({ "route": route }),
        |body, duration_ms| {
            map_exchange_quote_status(body, duration_ms, &config.exchange_route_label)
        },
    )
    .await
}

async fn check_near_intents(state: &AppState) -> OhDearCheckResult {
    let (result, duration_ms) = fetch_intents_response(state).await;
    match result {
        Ok(response) => map_near_intents_status(response, duration_ms),
        Err(error) => NEAR_INTENTS_CHECK.failed_http(error, duration_ms, json!({})),
    }
}

/// Build and send the NEAR Intents status request, returning the decoded
/// response (or a categorized HTTP error) together with the elapsed time.
/// Shared by the Oh Dear health check and the lightweight `fetch_intents_posts`.
async fn fetch_intents_response(
    state: &AppState,
) -> (Result<IntentsStatusResponse, HealthHttpError>, u128) {
    let config = OhDearHealthConfig::default();
    let request = state
        .http_client
        .get(&state.env_vars.near_intents_status_api_url);

    let started = Instant::now();
    let result = send_json_check::<IntentsStatusResponse>(
        request,
        Duration::from_secs(config.http_timeout_seconds),
    )
    .await;
    (result, started.elapsed().as_millis())
}

async fn check_near_protocol(state: &AppState) -> OhDearCheckResult {
    let config = OhDearHealthConfig::default();
    let request = state
        .http_client
        .get(&state.env_vars.near_status_page_json_url);

    fetch_json_check::<NearStatusPage, _>(
        request,
        &config,
        NEAR_PROTOCOL_CHECK,
        json!({}),
        |status_page, duration_ms| map_near_protocol_status(status_page, duration_ms, &config),
    )
    .await
}

async fn check_near_rpc(state: &AppState) -> OhDearCheckResult {
    let config = OhDearHealthConfig::default();
    let started = Instant::now();
    let Some(endpoint) = state.network.rpc_endpoints.first() else {
        return NEAR_RPC_CHECK.failed(
            "No NEAR RPC endpoint is configured",
            "RPC not configured",
            json!({
                "duration_ms": started.elapsed().as_millis(),
                "error": "missing_rpc_endpoint"
            }),
        );
    };

    let mut request = state
        .http_client
        .post(endpoint.url.clone())
        .header("content-type", "application/json")
        .json(&json!({
            "jsonrpc": "2.0",
            "id": "dontcare",
            "method": "status",
            "params": []
        }));

    if let Some(bearer_header) = endpoint.bearer_header.as_deref() {
        request = request
            .header("Authorization", bearer_header)
            .header("x-api-key", bearer_header);
    }

    fetch_json_check::<RpcStatusResponse, _>(
        request,
        &config,
        NEAR_RPC_CHECK,
        json!({}),
        |status, duration_ms| map_near_rpc_status(status, duration_ms, &config),
    )
    .await
}

#[derive(Debug, Deserialize)]
struct FastNearTransfersProbeResponse {
    #[allow(dead_code)]
    transfers: Vec<Value>,
}

#[derive(Debug, Serialize)]
struct ProbeResult {
    probe: &'static str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
    duration_ms: u128,
}

async fn check_fastnear(state: &AppState) -> OhDearCheckResult {
    let config = OhDearHealthConfig::default();
    let timeout = Duration::from_secs(config.http_timeout_seconds);
    let transfers_base_url = state
        .env_vars
        .transfer_hints_base_url
        .as_deref()
        .unwrap_or(FASTNEAR_TRANSFERS_BASE);
    let account_id = &config.fastnear_probe_account_id;
    let api_key = &state.env_vars.fastnear_api_key;

    let (account_result, transfers_result, archival_rpc_result) = tokio::join!(
        probe_fastnear_account(state, account_id, api_key, timeout),
        probe_fastnear_transfers(state, account_id, api_key, transfers_base_url, timeout),
        probe_fastnear_archival_rpc(state, timeout),
    );

    let probes = vec![account_result, transfers_result, archival_rpc_result];
    map_probe_results(
        FASTNEAR_CHECK,
        "FastNear APIs reachable",
        "FastNear degraded",
        probes,
    )
}

async fn probe_fastnear_account(
    state: &AppState,
    account_id: &str,
    api_key: &str,
    timeout: Duration,
) -> ProbeResult {
    let started = Instant::now();
    let url = format!("{FASTNEAR_ACCOUNT_API_BASE}/v1/account/{account_id}/full");
    let request = state
        .http_client
        .get(url)
        .header("Authorization", format!("Bearer {api_key}"));

    match send_json_check::<Value>(request, timeout).await {
        Ok(_) => ProbeResult {
            probe: "account_api",
            ok: true,
            error: None,
            http_status: None,
            duration_ms: started.elapsed().as_millis(),
        },
        Err(error) => probe_error("account_api", error, started.elapsed().as_millis()),
    }
}

async fn probe_fastnear_transfers(
    state: &AppState,
    account_id: &str,
    api_key: &str,
    base_url: &str,
    timeout: Duration,
) -> ProbeResult {
    let started = Instant::now();
    let url = format!("{}/v0/transfers", base_url.trim_end_matches('/'));
    let request = state
        .http_client
        .post(url)
        .header("content-type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&json!({
            "account_id": account_id,
            "limit": 1
        }));

    match send_json_check::<FastNearTransfersProbeResponse>(request, timeout).await {
        Ok(_) => ProbeResult {
            probe: "transfers_api",
            ok: true,
            error: None,
            http_status: None,
            duration_ms: started.elapsed().as_millis(),
        },
        Err(error) => probe_error("transfers_api", error, started.elapsed().as_millis()),
    }
}

async fn probe_fastnear_archival_rpc(state: &AppState, timeout: Duration) -> ProbeResult {
    let started = Instant::now();
    let Some(endpoint) = state.archival_network.rpc_endpoints.first() else {
        return ProbeResult {
            probe: "archival_rpc",
            ok: false,
            error: Some("missing_archival_rpc_endpoint".to_string()),
            http_status: None,
            duration_ms: started.elapsed().as_millis(),
        };
    };

    let mut request = state
        .http_client
        .post(endpoint.url.clone())
        .header("content-type", "application/json")
        .json(&json!({
            "jsonrpc": "2.0",
            "id": "dontcare",
            "method": "status",
            "params": []
        }));

    if let Some(bearer_header) = endpoint.bearer_header.as_deref() {
        request = request
            .header("Authorization", bearer_header)
            .header("x-api-key", bearer_header);
    }

    match send_json_check::<RpcStatusResponse>(request, timeout).await {
        Ok(_) => ProbeResult {
            probe: "archival_rpc",
            ok: true,
            error: None,
            http_status: None,
            duration_ms: started.elapsed().as_millis(),
        },
        Err(error) => probe_error("archival_rpc", error, started.elapsed().as_millis()),
    }
}

fn probe_error(probe: &'static str, error: HealthHttpError, duration_ms: u128) -> ProbeResult {
    let (error_code, http_status) = match error {
        HealthHttpError::Timeout => ("timeout", None),
        HealthHttpError::RequestFailed => ("request_failed", None),
        HealthHttpError::UnsuccessfulStatus(status) => ("unsuccessful_status", Some(status)),
        HealthHttpError::InvalidJson => ("invalid_json", None),
    };

    ProbeResult {
        probe,
        ok: false,
        error: Some(error_code.to_string()),
        http_status,
        duration_ms,
    }
}

fn map_probe_results(
    check: CheckDefinition,
    ok_summary: &str,
    failed_summary: &str,
    probes: Vec<ProbeResult>,
) -> OhDearCheckResult {
    let failed: Vec<_> = probes.iter().filter(|probe| !probe.ok).collect();

    if failed.is_empty() {
        return check.ok(ok_summary, json!({ "probes": probes }));
    }

    let failed_names: Vec<_> = failed.iter().map(|probe| probe.probe).collect();
    let message = format!(
        "{} probe(s) failed: {}",
        check.short_subject,
        failed_names.join(", ")
    );

    check.failed(
        &message,
        failed_summary,
        json!({
            "probes": probes,
            "failed_probes": failed_names,
        }),
    )
}

async fn check_goldsky(state: &AppState) -> OhDearCheckResult {
    let config = OhDearHealthConfig::default();
    let Some(pool) = state.goldsky_pool.as_ref() else {
        return GOLDSKY_CHECK.skipped(
            "Goldsky not configured",
            json!({ "reason": "goldsky_database_url_missing" }),
        );
    };

    let started = Instant::now();
    let connected = tokio::time::timeout(
        Duration::from_secs(config.database_timeout_seconds),
        sqlx::query("SELECT 1").fetch_one(pool),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .is_some();

    if connected {
        GOLDSKY_CHECK.ok(
            "Goldsky database OK",
            json!({ "duration_ms": started.elapsed().as_millis() }),
        )
    } else {
        GOLDSKY_CHECK.failed(
            "Goldsky database connection failed",
            "Goldsky unavailable",
            json!({ "duration_ms": started.elapsed().as_millis() }),
        )
    }
}

async fn check_defillama(state: &AppState) -> OhDearCheckResult {
    let config = OhDearHealthConfig::default();
    let base_url = state.env_vars.defillama_api_base_url.trim_end_matches('/');
    let request = state
        .http_client
        .get(format!("{base_url}/prices/current/coingecko:near"))
        .header("accept", "application/json");

    fetch_json_check::<Value, _>(
        request,
        &config,
        DEFILLAMA_CHECK,
        json!({ "asset": "coingecko:near" }),
        |body, duration_ms| {
            if body.get("coins").is_some() {
                DEFILLAMA_CHECK.ok(
                    "DeFiLlama prices reachable",
                    json!({ "duration_ms": duration_ms, "asset": "coingecko:near" }),
                )
            } else {
                DEFILLAMA_CHECK.failed(
                    "DeFiLlama response was missing price data",
                    "Invalid DeFiLlama response",
                    json!({
                        "duration_ms": duration_ms,
                        "asset": "coingecko:near",
                        "error": "missing_coins"
                    }),
                )
            }
        },
    )
    .await
}

async fn check_nearblocks(state: &AppState) -> OhDearCheckResult {
    let config = OhDearHealthConfig::default();
    let Some(api_key) = state.env_vars.nearblocks_api_key.as_deref() else {
        return NEARBLOCKS_CHECK.skipped(
            "NearBlocks not configured",
            json!({ "reason": "nearblocks_api_key_missing" }),
        );
    };

    let request = state
        .http_client
        .get(format!("{NEARBLOCKS_API_BASE}/v1/fts/?search=wrap.near"))
        .header("accept", "application/json")
        .header("Authorization", format!("Bearer {api_key}"));

    fetch_json_check::<Value, _>(
        request,
        &config,
        NEARBLOCKS_CHECK,
        json!({ "search": "wrap.near" }),
        |_, duration_ms| {
            NEARBLOCKS_CHECK.ok(
                "NearBlocks API reachable",
                json!({ "duration_ms": duration_ms, "search": "wrap.near" }),
            )
        },
    )
    .await
}

async fn check_intents_explorer(state: &AppState) -> OhDearCheckResult {
    let config = OhDearHealthConfig::default();
    let Some(api_key) = state.env_vars.intents_explorer_api_key.as_deref() else {
        return INTENTS_EXPLORER_CHECK.skipped(
            "Intents Explorer not configured",
            json!({ "reason": "intents_explorer_api_key_missing" }),
        );
    };

    let account_id = &config.fastnear_probe_account_id;
    let api_url = state
        .env_vars
        .intents_explorer_api_url
        .trim_end_matches('/');
    let request = state
        .http_client
        .get(format!(
            "{api_url}/transactions?search={account_id}&numberOfTransactions=1&statuses=SUCCESS"
        ))
        .header("Authorization", format!("Bearer {api_key}"));

    fetch_json_check::<Value, _>(
        request,
        &config,
        INTENTS_EXPLORER_CHECK,
        json!({ "search": account_id }),
        |_, duration_ms| {
            INTENTS_EXPLORER_CHECK.ok(
                "Intents Explorer API reachable",
                json!({ "duration_ms": duration_ms, "search": account_id }),
            )
        },
    )
    .await
}

async fn check_neardata(state: &AppState) -> OhDearCheckResult {
    let config = OhDearHealthConfig::default();
    let timeout = Duration::from_secs(config.http_timeout_seconds);
    let base_url =
        std::env::var("NEARDATA_BASE_URL").unwrap_or_else(|_| NEARDATA_DEFAULT_BASE.to_string());
    let block_height = config.neardata_probe_block_height;
    let started = Instant::now();
    let mut request = state.http_client.get(format!(
        "{}/v0/block/{}",
        base_url.trim_end_matches('/'),
        block_height
    ));

    if !state.env_vars.fastnear_api_key.is_empty() {
        request = request.header(
            "Authorization",
            format!("Bearer {}", state.env_vars.fastnear_api_key),
        );
    }

    match send_json_check::<Value>(request, timeout).await {
        Ok(_) => NEARDATA_CHECK.ok(
            "Neardata API reachable",
            json!({
                "duration_ms": started.elapsed().as_millis(),
                "block_height": block_height
            }),
        ),
        Err(error) => NEARDATA_CHECK.failed_http(
            error,
            started.elapsed().as_millis(),
            json!({
                "block_height": block_height
            }),
        ),
    }
}

fn map_exchange_quote_status(body: Value, duration_ms: u128, route: &str) -> OhDearCheckResult {
    if body.get("quote").is_some() {
        EXCHANGE_QUOTE_CHECK.ok(
            "Quote OK",
            json!({
                "route": route,
                "duration_ms": duration_ms
            }),
        )
    } else {
        EXCHANGE_QUOTE_CHECK.failed(
            "Quote response was missing quote data",
            "Invalid quote response",
            json!({
                "route": route,
                "duration_ms": duration_ms,
                "error": "missing_quote"
            }),
        )
    }
}

fn map_near_intents_status(
    status_page: IntentsStatusResponse,
    duration_ms: u128,
) -> OhDearCheckResult {
    let now = Utc::now().timestamp_millis();
    let active_posts: Vec<_> = status_page
        .posts
        .into_iter()
        .filter(|post| match (post.starts_at, post.ends_at) {
            (Some(start), Some(end)) => now >= start && now <= end,
            (Some(start), None) => now >= start,
            _ => true,
        })
        .collect();

    if let Some(incident) = active_posts
        .iter()
        .find(|post| post.post_type == INTENTS_POST_INCIDENT)
    {
        return NEAR_INTENTS_CHECK.failed(
            "NEAR Intents has an active incident",
            "Incident active",
            json!({
                "duration_ms": duration_ms,
                "post_type": incident.post_type,
                "title": incident.title
            }),
        );
    }

    if let Some(maintenance) = active_posts
        .iter()
        .find(|post| post.post_type == INTENTS_POST_MAINTENANCE)
    {
        return NEAR_INTENTS_CHECK.warning(
            "NEAR Intents has active maintenance",
            "Maintenance active",
            json!({
                "duration_ms": duration_ms,
                "post_type": maintenance.post_type,
                "title": maintenance.title
            }),
        );
    }

    NEAR_INTENTS_CHECK.ok(
        "No active NEAR Intents incidents",
        json!({ "duration_ms": duration_ms, "active_posts": 0 }),
    )
}

fn map_near_protocol_status(
    status_page: NearStatusPage,
    duration_ms: u128,
    config: &OhDearHealthConfig,
) -> OhDearCheckResult {
    let mainnet_status = status_page
        .monitors
        .mainnet
        .iter()
        .find(|monitor| monitor.label == config.near_protocol_mainnet_label.as_str())
        .map(|monitor| monitor.status.as_str());

    match (status_page.summarized_status.as_str(), mainnet_status) {
        (NEAR_STATUS_UP, Some(NEAR_STATUS_UP)) => NEAR_PROTOCOL_CHECK.ok(
            "NEAR protocol status is up",
            json!({
                "duration_ms": duration_ms,
                "summarized_status": status_page.summarized_status,
                "mainnet_status": "up"
            }),
        ),
        (_, Some(NEAR_STATUS_UP)) => NEAR_PROTOCOL_CHECK.warning(
            "NEAR status page reports a non-up summary",
            "Status page degraded",
            json!({
                "duration_ms": duration_ms,
                "summarized_status": status_page.summarized_status,
                "mainnet_status": "up"
            }),
        ),
        (_, Some(status)) => NEAR_PROTOCOL_CHECK.failed(
            "NEAR mainnet is not up on the NEAR status page",
            "Mainnet not up",
            json!({
                "duration_ms": duration_ms,
                "summarized_status": status_page.summarized_status,
                "mainnet_status": status
            }),
        ),
        (_, None) => NEAR_PROTOCOL_CHECK.failed(
            "NEAR mainnet monitor was missing from the NEAR status page",
            "Mainnet status missing",
            json!({
                "duration_ms": duration_ms,
                "summarized_status": status_page.summarized_status,
                "mainnet_label": &config.near_protocol_mainnet_label,
                "error": "mainnet_monitor_missing"
            }),
        ),
    }
}

fn map_near_rpc_status(
    status: RpcStatusResponse,
    duration_ms: u128,
    config: &OhDearHealthConfig,
) -> OhDearCheckResult {
    let parsed_block_time =
        DateTime::parse_from_rfc3339(&status.result.sync_info.latest_block_time)
            .map(|time| time.with_timezone(&Utc));

    let Ok(block_time) = parsed_block_time else {
        return NEAR_RPC_CHECK.failed(
            "NEAR RPC returned an invalid latest block time",
            "Invalid block time",
            json!({
                "duration_ms": duration_ms,
                "latest_block_height": status.result.sync_info.latest_block_height,
                "error": "invalid_block_time"
            }),
        );
    };

    let block_age_seconds = (Utc::now() - block_time).num_seconds();

    if status.result.sync_info.syncing {
        return NEAR_RPC_CHECK.warning(
            "NEAR RPC node reports that it is syncing",
            "RPC syncing",
            json!({
                "duration_ms": duration_ms,
                "latest_block_height": status.result.sync_info.latest_block_height,
                "block_age_seconds": block_age_seconds
            }),
        );
    }

    if block_age_seconds > config.near_rpc_stale_after_seconds {
        return NEAR_RPC_CHECK.warning(
            "NEAR RPC latest block is stale",
            "RPC stale",
            json!({
                "duration_ms": duration_ms,
                "latest_block_height": status.result.sync_info.latest_block_height,
                "block_age_seconds": block_age_seconds,
                "stale_after_seconds": config.near_rpc_stale_after_seconds
            }),
        );
    }

    NEAR_RPC_CHECK.ok(
        "NEAR RPC is reachable",
        json!({
            "duration_ms": duration_ms,
            "latest_block_height": status.result.sync_info.latest_block_height,
            "block_age_seconds": block_age_seconds,
            "stale_after_seconds": config.near_rpc_stale_after_seconds
        }),
    )
}

impl CheckDefinition {
    fn ok(self, short_summary: &str, meta: Value) -> OhDearCheckResult {
        self.result(OhDearStatus::Ok, "", short_summary, meta)
    }

    fn skipped(self, short_summary: &str, meta: Value) -> OhDearCheckResult {
        self.result(OhDearStatus::Skipped, "", short_summary, meta)
    }

    fn warning(
        self,
        notification_message: &str,
        short_summary: &str,
        meta: Value,
    ) -> OhDearCheckResult {
        self.result(
            OhDearStatus::Warning,
            notification_message,
            short_summary,
            meta,
        )
    }

    fn failed(
        self,
        notification_message: &str,
        short_summary: &str,
        meta: Value,
    ) -> OhDearCheckResult {
        self.result(
            OhDearStatus::Failed,
            notification_message,
            short_summary,
            meta,
        )
    }

    fn failed_http(
        self,
        error: HealthHttpError,
        duration_ms: u128,
        extra_meta: Value,
    ) -> OhDearCheckResult {
        let notification_message = match error {
            HealthHttpError::Timeout => format!("{} timed out", self.notification_subject),
            HealthHttpError::RequestFailed => {
                format!("{} could not be reached", self.notification_subject)
            }
            HealthHttpError::UnsuccessfulStatus(_) => {
                format!(
                    "{} returned an unsuccessful status",
                    self.notification_subject
                )
            }
            HealthHttpError::InvalidJson => {
                format!("{} response could not be parsed", self.notification_subject)
            }
        };
        let short_summary = match error {
            HealthHttpError::Timeout => format!("{} timed out", self.short_subject),
            HealthHttpError::InvalidJson => format!("Invalid {} response", self.short_subject),
            HealthHttpError::RequestFailed | HealthHttpError::UnsuccessfulStatus(_) => {
                format!("{} failed", self.short_subject)
            }
        };
        let mut meta = match extra_meta {
            Value::Object(meta) => meta,
            _ => Map::new(),
        };
        meta.insert("duration_ms".to_string(), json!(duration_ms));

        match error {
            HealthHttpError::Timeout => {
                meta.insert("error".to_string(), json!("timeout"));
            }
            HealthHttpError::RequestFailed => {
                meta.insert("error".to_string(), json!("request_failed"));
            }
            HealthHttpError::UnsuccessfulStatus(status) => {
                meta.insert("http_status".to_string(), json!(status));
            }
            HealthHttpError::InvalidJson => {
                meta.insert("error".to_string(), json!("invalid_json"));
            }
        };

        self.failed(&notification_message, &short_summary, Value::Object(meta))
    }

    fn result(
        self,
        status: OhDearStatus,
        notification_message: &str,
        short_summary: &str,
        meta: Value,
    ) -> OhDearCheckResult {
        OhDearCheckResult {
            name: self.name.to_string(),
            label: self.label.to_string(),
            status,
            notification_message: notification_message.to_string(),
            short_summary: short_summary.to_string(),
            meta,
        }
    }
}

/// Fetch the current posts from the NEAR Intents status API.
/// Used by the monitor for post-level linked warning resolution and by the admin endpoint.
pub async fn fetch_intents_posts(state: &AppState) -> Result<Vec<IntentsStatusPost>, String> {
    match fetch_intents_response(state).await.0 {
        Ok(response) => Ok(response.posts),
        Err(_) => Err("Failed to fetch NEAR Intents status posts".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::create_routes;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{method, path},
    };

    #[derive(Default)]
    struct TestStateOptions {
        goldsky_pool: bool,
    }

    async fn build_test_state(
        configure: impl FnOnce(&mut crate::utils::env::EnvVars),
        options: TestStateOptions,
    ) -> Arc<AppState> {
        dotenvy::from_filename(".env").ok();
        dotenvy::from_filename(".env.test").ok();

        let mut env_vars = crate::utils::env::EnvVars::default();
        configure(&mut env_vars);

        let database_url = env_vars.database_url.clone();
        let db_pool = lazy_test_pool(&database_url);

        let mut builder = AppState::builder().db_pool(db_pool).env_vars(env_vars);

        if options.goldsky_pool {
            builder = builder.goldsky_pool(lazy_test_pool(&database_url));
        }

        Arc::new(builder.build().await.expect("failed to build test state"))
    }

    async fn test_state(configure: impl FnOnce(&mut crate::utils::env::EnvVars)) -> Arc<AppState> {
        build_test_state(configure, TestStateOptions::default()).await
    }

    fn lazy_test_pool(database_url: &str) -> sqlx::PgPool {
        PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(100))
            .connect_lazy(database_url)
            .expect("failed to create lazy test pool")
    }

    /// Keeps `NEARDATA_BASE_URL` scoped to a single test (must run serially).
    struct NeardataEnvGuard;

    impl NeardataEnvGuard {
        fn set(base_url: impl AsRef<str>) -> Self {
            unsafe {
                std::env::set_var("NEARDATA_BASE_URL", base_url.as_ref());
            }
            Self
        }
    }

    impl Drop for NeardataEnvGuard {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("NEARDATA_BASE_URL");
            }
        }
    }

    fn fresh_near_rpc_status_body() -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": "dontcare",
            "result": {
                "sync_info": {
                    "latest_block_height": 123,
                    "latest_block_time": Utc::now().to_rfc3339(),
                    "syncing": false
                }
            }
        })
    }

    fn without_nearblocks_key(env: &mut crate::utils::env::EnvVars) {
        env.nearblocks_api_key = None;
    }

    fn without_intents_explorer_key(env: &mut crate::utils::env::EnvVars) {
        env.intents_explorer_api_key = None;
    }

    fn with_intents_explorer_key(env: &mut crate::utils::env::EnvVars, key: &str) {
        env.intents_explorer_api_key = Some(key.to_string());
    }

    fn without_goldsky(env: &mut crate::utils::env::EnvVars) {
        env.goldsky_database_url = None;
    }

    async fn get_status_response(state: Arc<AppState>, path: &str) -> (StatusCode, Value) {
        let app = create_routes(state);
        let response = app
            .oneshot(
                Request::builder()
                    .uri(path)
                    .body(Body::empty())
                    .expect("failed to build request"),
            )
            .await
            .expect("request failed");

        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("failed to read body");
        let json = serde_json::from_slice(&body).unwrap_or(json!({}));
        (status, json)
    }

    async fn get_status_json(state: Arc<AppState>, path: &str) -> Value {
        let (status, json) = get_status_response(state, path).await;
        assert_eq!(status, StatusCode::OK, "unexpected response: {json}");
        json
    }

    fn assert_check(json: &Value, name: &str, status: &str) {
        assert_eq!(json["checkResults"][0]["name"], name);
        assert_eq!(json["checkResults"][0]["status"], status);
    }

    #[tokio::test]
    async fn unsupported_service_returns_not_found() {
        let state = test_state(|_| {}).await;
        let (status, json) = get_status_response(state, "/api/oh-dear/status/not-a-service").await;

        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(json["error"], "unsupported_service");
        assert_eq!(json["supported"], json!(SUPPORTED_SERVICES));
    }

    #[tokio::test]
    async fn exchange_endpoint_returns_oh_dear_json_without_auth() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v0/quote"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "quote": {
                    "amountIn": "1000000000000000000000000",
                    "amountOut": "1000000"
                }
            })))
            .mount(&mock_server)
            .await;

        let state = test_state(|env| env.oneclick_api_url = mock_server.uri()).await;
        let json = get_status_json(state, "/api/oh-dear/status/exchange").await;

        assert!(json["finishedAt"].as_i64().is_some());
        assert_check(&json, "exchange.quote", "ok");
    }

    #[tokio::test]
    async fn exchange_endpoint_maps_quote_failure_to_failed() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v0/quote"))
            .respond_with(ResponseTemplate::new(500).set_body_json(json!({
                "error": "provider unavailable"
            })))
            .mount(&mock_server)
            .await;

        let state = test_state(|env| env.oneclick_api_url = mock_server.uri()).await;
        let json = get_status_json(state, "/api/oh-dear/status/exchange").await;

        assert_check(&json, "exchange.quote", "failed");
        assert_eq!(json["checkResults"][0]["meta"]["http_status"], 500);
    }

    #[tokio::test]
    async fn bridge_rpc_endpoint_maps_success_to_ok() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0",
                "id": "dontcare",
                "result": { "tokens": [] }
            })))
            .mount(&mock_server)
            .await;

        let state = test_state(|env| env.bridge_rpc_url = mock_server.uri()).await;
        let json = get_status_json(state, "/api/oh-dear/status/bridge-rpc").await;

        assert_check(&json, "bridge-rpc.supported-tokens", "ok");
    }

    #[tokio::test]
    async fn bridge_rpc_endpoint_maps_http_error_to_failed() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&mock_server)
            .await;

        let state = test_state(|env| env.bridge_rpc_url = mock_server.uri()).await;
        let json = get_status_json(state, "/api/oh-dear/status/bridge-rpc").await;

        assert_check(&json, "bridge-rpc.supported-tokens", "failed");
        assert_eq!(json["checkResults"][0]["meta"]["http_status"], 503);
    }

    #[tokio::test]
    async fn defillama_endpoint_maps_prices_to_ok() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/prices/current/coingecko:near"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "coins": {
                    "coingecko:near": { "price": 3.5 }
                }
            })))
            .mount(&mock_server)
            .await;

        let state = test_state(|env| env.defillama_api_base_url = mock_server.uri()).await;
        let json = get_status_json(state, "/api/oh-dear/status/defillama").await;

        assert_check(&json, "defillama.prices", "ok");
    }

    #[tokio::test]
    async fn defillama_endpoint_maps_missing_coins_to_failed() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/prices/current/coingecko:near"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "status": "ok" })))
            .mount(&mock_server)
            .await;

        let state = test_state(|env| env.defillama_api_base_url = mock_server.uri()).await;
        let json = get_status_json(state, "/api/oh-dear/status/defillama").await;

        assert_check(&json, "defillama.prices", "failed");
        assert_eq!(json["checkResults"][0]["meta"]["error"], "missing_coins");
    }

    #[tokio::test]
    async fn near_protocol_endpoint_maps_up_status_to_ok() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "summarizedStatus": "up",
                "monitors": {
                    "mainnet": [
                        { "label": "NEAR Network (mainnet)", "status": "up" }
                    ]
                }
            })))
            .mount(&mock_server)
            .await;

        let state = test_state(|env| {
            env.near_status_page_json_url = format!("{}/json", mock_server.uri());
        })
        .await;
        let json = get_status_json(state, "/api/oh-dear/status/near-protocol").await;

        assert_check(&json, "near-protocol.status-page", "ok");
    }

    #[tokio::test]
    async fn near_protocol_endpoint_maps_down_mainnet_to_failed() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "summarizedStatus": "down",
                "monitors": {
                    "mainnet": [
                        { "label": "NEAR Network (mainnet)", "status": "down" }
                    ]
                }
            })))
            .mount(&mock_server)
            .await;

        let state = test_state(|env| {
            env.near_status_page_json_url = format!("{}/json", mock_server.uri());
        })
        .await;
        let json = get_status_json(state, "/api/oh-dear/status/near-protocol").await;

        assert_check(&json, "near-protocol.status-page", "failed");
    }

    #[tokio::test]
    async fn near_intents_endpoint_maps_maintenance_to_warning() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/posts"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "posts": [
                    {
                        "id": "1",
                        "title": "Maintenance",
                        "post_type": "maintenance",
                        "starts_at": 0,
                        "ends_at": null
                    }
                ]
            })))
            .mount(&mock_server)
            .await;

        let state = test_state(|env| {
            env.near_intents_status_api_url = format!("{}/api/posts", mock_server.uri());
        })
        .await;
        let json = get_status_json(state, "/api/oh-dear/status/near-intents").await;

        assert_check(&json, "near-intents.status", "warning");
    }

    #[tokio::test]
    async fn near_intents_endpoint_maps_incident_to_failed() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/posts"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "posts": [
                    {
                        "id": "1",
                        "title": "Incident",
                        "post_type": "incident",
                        "starts_at": 0,
                        "ends_at": null
                    }
                ]
            })))
            .mount(&mock_server)
            .await;

        let state = test_state(|env| {
            env.near_intents_status_api_url = format!("{}/api/posts", mock_server.uri());
        })
        .await;
        let json = get_status_json(state, "/api/oh-dear/status/near-intents").await;

        assert_check(&json, "near-intents.status", "failed");
    }

    #[tokio::test]
    async fn near_rpc_endpoint_maps_fresh_status_to_ok() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(fresh_near_rpc_status_body()))
            .mount(&mock_server)
            .await;

        let state = test_state(|env| env.near_rpc_url = Some(mock_server.uri())).await;
        let json = get_status_json(state, "/api/oh-dear/status/near-rpc").await;

        assert_check(&json, "near-rpc.status", "ok");
    }

    #[tokio::test]
    async fn fastnear_endpoint_returns_oh_dear_json() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v0/transfers"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "transfers": [] })))
            .mount(&mock_server)
            .await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(fresh_near_rpc_status_body()))
            .mount(&mock_server)
            .await;

        let state = test_state(|env| {
            env.transfer_hints_base_url = Some(mock_server.uri());
            env.near_archival_rpc_url = Some(mock_server.uri());
        })
        .await;
        let json = get_status_json(state, "/api/oh-dear/status/fastnear").await;

        assert_eq!(json["checkResults"][0]["name"], "fastnear.api");
        assert!(json["checkResults"][0]["status"].as_str().is_some());
    }

    #[tokio::test]
    async fn goldsky_endpoint_skips_when_not_configured() {
        let state = test_state(without_goldsky).await;
        let json = get_status_json(state, "/api/oh-dear/status/goldsky").await;

        assert_check(&json, "goldsky.database", "skipped");
    }

    #[tokio::test]
    async fn goldsky_endpoint_maps_connected_pool_to_ok() {
        let state =
            build_test_state(without_goldsky, TestStateOptions { goldsky_pool: true }).await;
        let json = get_status_json(state, "/api/oh-dear/status/goldsky").await;

        assert_check(&json, "goldsky.database", "ok");
    }

    #[tokio::test]
    async fn nearblocks_endpoint_skips_without_api_key() {
        let state = test_state(without_nearblocks_key).await;
        let json = get_status_json(state, "/api/oh-dear/status/nearblocks").await;

        assert_check(&json, "nearblocks.api", "skipped");
    }

    #[tokio::test]
    async fn intents_explorer_endpoint_skips_without_api_key() {
        let state = test_state(without_intents_explorer_key).await;
        let json = get_status_json(state, "/api/oh-dear/status/intents-explorer").await;

        assert_check(&json, "intents-explorer.api", "skipped");
    }

    #[tokio::test]
    async fn intents_explorer_endpoint_maps_success_to_ok() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/transactions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "transactions": [] })))
            .mount(&mock_server)
            .await;

        let state = test_state(|env| {
            env.intents_explorer_api_url = mock_server.uri();
            with_intents_explorer_key(env, "test-key");
        })
        .await;
        let json = get_status_json(state, "/api/oh-dear/status/intents-explorer").await;

        assert_check(&json, "intents-explorer.api", "ok");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn neardata_endpoint_maps_success_to_ok() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v0/block/100000000"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "header": {} })))
            .mount(&mock_server)
            .await;

        let _neardata_env = NeardataEnvGuard::set(mock_server.uri());
        let state = test_state(|_| {}).await;
        let json = get_status_json(state, "/api/oh-dear/status/neardata").await;

        assert_check(&json, "neardata.api", "ok");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn neardata_endpoint_maps_http_error_to_failed() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v0/block/100000000"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&mock_server)
            .await;

        let _neardata_env = NeardataEnvGuard::set(mock_server.uri());
        let state = test_state(|_| {}).await;
        let json = get_status_json(state, "/api/oh-dear/status/neardata").await;

        assert_check(&json, "neardata.api", "failed");
        assert_eq!(json["checkResults"][0]["meta"]["http_status"], 503);
    }

    #[test]
    fn monitor_treats_non_intents_warnings_as_healthy() {
        assert!(!is_unhealthy_for_monitor(
            "near-protocol",
            &OhDearStatus::Warning
        ));
        assert!(!is_unhealthy_for_monitor(
            "near-rpc",
            &OhDearStatus::Warning
        ));
        assert!(!is_unhealthy_for_monitor(
            "exchange",
            &OhDearStatus::Warning
        ));
        assert!(!is_unhealthy_for_monitor("backend", &OhDearStatus::Ok));
        assert!(!is_unhealthy_for_monitor("backend", &OhDearStatus::Skipped));
    }

    #[test]
    fn monitor_treats_near_intents_warning_and_hard_failures_as_unhealthy() {
        assert!(is_unhealthy_for_monitor(
            "near-intents",
            &OhDearStatus::Warning
        ));
        assert!(is_unhealthy_for_monitor(
            "near-protocol",
            &OhDearStatus::Failed
        ));
        assert!(is_unhealthy_for_monitor("near-rpc", &OhDearStatus::Crashed));
        assert!(is_unhealthy_for_monitor(
            "near-intents",
            &OhDearStatus::Failed
        ));
    }

    #[test]
    fn probe_mapper_reports_ok_when_all_probes_succeed() {
        let result = map_probe_results(
            FASTNEAR_CHECK,
            "FastNear APIs reachable",
            "FastNear degraded",
            vec![
                ProbeResult {
                    probe: "account_api",
                    ok: true,
                    error: None,
                    http_status: None,
                    duration_ms: 10,
                },
                ProbeResult {
                    probe: "transfers_api",
                    ok: true,
                    error: None,
                    http_status: None,
                    duration_ms: 12,
                },
                ProbeResult {
                    probe: "archival_rpc",
                    ok: true,
                    error: None,
                    http_status: None,
                    duration_ms: 8,
                },
            ],
        );

        assert_eq!(result.status, OhDearStatus::Ok);
        assert_eq!(result.short_summary, "FastNear APIs reachable");
    }

    #[test]
    fn probe_mapper_reports_failed_when_any_probe_fails() {
        let result = map_probe_results(
            FASTNEAR_CHECK,
            "FastNear APIs reachable",
            "FastNear degraded",
            vec![
                ProbeResult {
                    probe: "account_api",
                    ok: false,
                    error: Some("unsuccessful_status".to_string()),
                    http_status: Some(403),
                    duration_ms: 10,
                },
                ProbeResult {
                    probe: "transfers_api",
                    ok: true,
                    error: None,
                    http_status: None,
                    duration_ms: 12,
                },
                ProbeResult {
                    probe: "archival_rpc",
                    ok: false,
                    error: Some("unsuccessful_status".to_string()),
                    http_status: Some(429),
                    duration_ms: 8,
                },
            ],
        );

        assert_eq!(result.status, OhDearStatus::Failed);
        assert_eq!(result.short_summary, "FastNear degraded");
        assert!(result.notification_message.contains("account_api"));
        assert!(result.notification_message.contains("archival_rpc"));
    }

    #[tokio::test]
    async fn backend_endpoint_returns_oh_dear_json_even_without_auth() {
        let state = test_state(|_| {}).await;
        let json = get_status_json(state, "/api/oh-dear/status/backend").await;

        assert!(json["finishedAt"].as_i64().is_some());
        assert_eq!(json["checkResults"][0]["name"], "backend.database");
        assert!(json["checkResults"][0]["status"].as_str().is_some());
    }
}
