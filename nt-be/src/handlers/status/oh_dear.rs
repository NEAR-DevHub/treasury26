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

const SUPPORTED_SERVICES: &[&str] = &[
    "backend",
    "exchange",
    "near-intents",
    "near-protocol",
    "near-rpc",
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

#[derive(Debug, Clone, Copy)]
enum StatusService {
    Backend,
    Exchange,
    NearIntents,
    NearProtocol,
    NearRpc,
}

impl StatusService {
    fn parse(service: &str) -> Option<Self> {
        match service {
            "backend" => Some(Self::Backend),
            "exchange" => Some(Self::Exchange),
            "near-intents" => Some(Self::NearIntents),
            "near-protocol" => Some(Self::NearProtocol),
            "near-rpc" => Some(Self::NearRpc),
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
struct IntentsStatusResponse {
    posts: Vec<IntentsStatusPost>,
}

#[derive(Debug, Deserialize)]
struct IntentsStatusPost {
    title: String,
    post_type: String,
    starts_at: Option<i64>,
    ends_at: Option<i64>,
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
        StatusService::Exchange => check_exchange(&state).await,
        StatusService::NearIntents => check_near_intents(&state).await,
        StatusService::NearProtocol => check_near_protocol(&state).await,
        StatusService::NearRpc => check_near_rpc(&state).await,
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
    let config = OhDearHealthConfig::default();
    let request = state
        .http_client
        .get(&state.env_vars.near_intents_status_api_url);

    fetch_json_check::<IntentsStatusResponse, _>(
        request,
        &config,
        NEAR_INTENTS_CHECK,
        json!({}),
        map_near_intents_status,
    )
    .await
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

    async fn test_state(
        oneclick_url: Option<String>,
        near_status_url: Option<String>,
        near_intents_status_url: Option<String>,
        near_rpc_url: Option<String>,
    ) -> Arc<AppState> {
        dotenvy::from_filename(".env").ok();
        dotenvy::from_filename(".env.test").ok();

        let mut env_vars = crate::utils::env::EnvVars::default();
        if let Some(url) = oneclick_url {
            env_vars.oneclick_api_url = url;
        }
        if let Some(url) = near_status_url {
            env_vars.near_status_page_json_url = url;
        }
        if let Some(url) = near_intents_status_url {
            env_vars.near_intents_status_api_url = url;
        }
        if let Some(url) = near_rpc_url {
            env_vars.near_rpc_url = Some(url);
        }

        let db_pool = PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(100))
            .connect_lazy(&env_vars.database_url)
            .expect("failed to create lazy test pool");

        Arc::new(
            AppState::builder()
                .db_pool(db_pool)
                .env_vars(env_vars)
                .build()
                .await
                .expect("failed to build test state"),
        )
    }

    async fn get_status_json(state: Arc<AppState>, path: &str) -> Value {
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

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("failed to read body");
        serde_json::from_slice(&body).expect("failed to parse json")
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

        let state = test_state(Some(mock_server.uri()), None, None, None).await;
        let json = get_status_json(state, "/api/oh-dear/status/exchange").await;

        assert!(json["finishedAt"].as_i64().is_some());
        assert_eq!(json["checkResults"][0]["name"], "exchange.quote");
        assert_eq!(json["checkResults"][0]["status"], "ok");
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

        let state = test_state(Some(mock_server.uri()), None, None, None).await;
        let json = get_status_json(state, "/api/oh-dear/status/exchange").await;

        assert_eq!(json["checkResults"][0]["status"], "failed");
        assert_eq!(json["checkResults"][0]["meta"]["http_status"], 500);
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

        let state = test_state(
            None,
            Some(format!("{}/json", mock_server.uri())),
            None,
            None,
        )
        .await;
        let json = get_status_json(state, "/api/oh-dear/status/near-protocol").await;

        assert_eq!(json["checkResults"][0]["status"], "ok");
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

        let state = test_state(
            None,
            Some(format!("{}/json", mock_server.uri())),
            None,
            None,
        )
        .await;
        let json = get_status_json(state, "/api/oh-dear/status/near-protocol").await;

        assert_eq!(json["checkResults"][0]["status"], "failed");
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

        let state = test_state(
            None,
            None,
            Some(format!("{}/api/posts", mock_server.uri())),
            None,
        )
        .await;
        let json = get_status_json(state, "/api/oh-dear/status/near-intents").await;

        assert_eq!(json["checkResults"][0]["status"], "warning");
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

        let state = test_state(
            None,
            None,
            Some(format!("{}/api/posts", mock_server.uri())),
            None,
        )
        .await;
        let json = get_status_json(state, "/api/oh-dear/status/near-intents").await;

        assert_eq!(json["checkResults"][0]["status"], "failed");
    }

    #[tokio::test]
    async fn near_rpc_endpoint_maps_fresh_status_to_ok() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0",
                "id": "dontcare",
                "result": {
                    "sync_info": {
                        "latest_block_height": 123,
                        "latest_block_time": Utc::now().to_rfc3339(),
                        "syncing": false
                    }
                }
            })))
            .mount(&mock_server)
            .await;

        let state = test_state(None, None, None, Some(mock_server.uri())).await;
        let json = get_status_json(state, "/api/oh-dear/status/near-rpc").await;

        assert_eq!(json["checkResults"][0]["status"], "ok");
    }

    #[tokio::test]
    async fn backend_endpoint_returns_oh_dear_json_even_without_auth() {
        let state = test_state(None, None, None, None).await;
        let json = get_status_json(state, "/api/oh-dear/status/backend").await;

        assert!(json["finishedAt"].as_i64().is_some());
        assert_eq!(json["checkResults"][0]["name"], "backend.database");
        assert!(json["checkResults"][0]["status"].as_str().is_some());
    }
}
