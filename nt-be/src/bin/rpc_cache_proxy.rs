//! Caching HTTP proxy for NEAR RPC and other external APIs.
//!
//! Sits between tests and real API endpoints. Caches responses to disk so that
//! repeated test runs (especially in CI) don't hit the network.
//!
//! Usage:
//!   CACHE_DIR=tests/fixtures/rpc_cache cargo run --bin rpc_cache_proxy
//!
//! Then point tests at this proxy:
//!   NEAR_RPC_URL=http://127.0.0.1:18552
//!   NEAR_ARCHIVAL_RPC_URL=http://127.0.0.1:18552
//!   TRANSFER_HINTS_BASE_URL=http://127.0.0.1:18552
//!
//! The proxy transparently forwards ALL requests to the upstream derived from the
//! original Host/URL. On cache hit it returns the cached response instantly.
//!
//! Cache key = SHA-256 of (upstream_host, path, query, body).
//! Stored as individual JSON files: {cache_dir}/{sha256_hex}.json
//!
//! Set RECORD=1 to forward cache misses to the real upstream and record responses.
//! Without RECORD=1, cache misses return 502 (useful in CI to detect missing fixtures).

use axum::{
    Router, body::Body, extract::State, http::StatusCode, response::IntoResponse, routing::any,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;

const DEFAULT_PORT: u16 = 18552;

/// Mapping from proxy path prefix to upstream base URL.
/// Requests to `http://proxy/{prefix}/...` are forwarded to `{upstream}/...`.
struct UpstreamRoute {
    prefix: &'static str,
    upstream: &'static str,
}

const ROUTES: &[UpstreamRoute] = &[
    UpstreamRoute {
        prefix: "/near-rpc",
        upstream: "https://rpc.mainnet.fastnear.com",
    },
    UpstreamRoute {
        prefix: "/near-archival",
        upstream: "https://archival-rpc.mainnet.fastnear.com",
    },
    UpstreamRoute {
        prefix: "/fastnear-hints",
        upstream: "https://transfers.main.fastnear.com",
    },
    UpstreamRoute {
        prefix: "/neardata",
        upstream: "https://mainnet.neardata.xyz",
    },
    UpstreamRoute {
        prefix: "/intents-explorer",
        upstream: "https://explorer.near-intents.org",
    },
];

#[derive(Clone)]
struct ProxyState {
    cache_dir: PathBuf,
    http_client: reqwest::Client,
    record: bool,
    api_key: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct CachedResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

#[tokio::main]
async fn main() {
    let cache_dir = std::env::var("CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("tests/fixtures/rpc_cache"));

    let record = std::env::var("RECORD").map(|v| v == "1").unwrap_or(false);

    let api_key = std::env::var("FASTNEAR_API_KEY").ok();

    fs::create_dir_all(&cache_dir)
        .await
        .expect("Failed to create cache directory");

    let state = Arc::new(ProxyState {
        cache_dir,
        http_client: reqwest::Client::new(),
        record,
        api_key,
    });

    let app = Router::new()
        .fallback(any(proxy_handler))
        .with_state(state.clone());

    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let addr = format!("127.0.0.1:{}", port);
    eprintln!(
        "RPC cache proxy listening on {} (record={}, cache={})",
        addr,
        record,
        state.cache_dir.display()
    );
    eprintln!("Routes:");
    for route in ROUTES {
        eprintln!("  {} -> {}", route.prefix, route.upstream);
    }

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn proxy_handler(
    State(state): State<Arc<ProxyState>>,
    req: axum::extract::Request,
) -> impl IntoResponse {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let headers = req.headers().clone();

    // Read body
    let body_bytes = match axum::body::to_bytes(req.into_body(), 10 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                format!("Failed to read request body: {}", e),
            )
                .into_response();
        }
    };

    // Find upstream route
    let (upstream_base, remaining_path) = match find_upstream(&path) {
        Some(r) => r,
        None => {
            // No prefix match — try to use the path as-is with the first route
            // This supports the case where tests point directly at the proxy
            // as an RPC endpoint (e.g., NEAR_RPC_URL=http://proxy:18552)
            // In that case, figure out upstream from request headers or default to archival
            return (
                StatusCode::BAD_GATEWAY,
                format!("No upstream route for path: {}", path),
            )
                .into_response();
        }
    };

    // Compute cache key from upstream + path + query + body
    let cache_key = compute_cache_key(upstream_base, &remaining_path, &query, &body_bytes);
    let cache_path = state.cache_dir.join(format!("{}.json", cache_key));

    // Check cache
    if let Ok(data) = fs::read(&cache_path).await
        && let Ok(cached) = serde_json::from_slice::<CachedResponse>(&data)
    {
        let status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
        let mut response = axum::response::Response::builder().status(status);
        for (k, v) in &cached.headers {
            response = response.header(k.as_str(), v.as_str());
        }
        return response
            .body(Body::from(cached.body))
            .unwrap()
            .into_response();
    }

    // Cache miss
    if !state.record {
        let body_preview = String::from_utf8_lossy(&body_bytes);
        let body_preview = if body_preview.len() > 200 {
            format!("{}...", &body_preview[..200])
        } else {
            body_preview.to_string()
        };
        eprintln!(
            "CACHE MISS: {} {} key={} body={}",
            method, remaining_path, cache_key, body_preview
        );
        return (
            StatusCode::BAD_GATEWAY,
            format!(
                "Cache miss (RECORD not enabled): {} {}{}",
                method,
                remaining_path,
                if query.is_empty() {
                    String::new()
                } else {
                    format!("?{}", query)
                }
            ),
        )
            .into_response();
    }

    // Forward to upstream
    let upstream_url = if query.is_empty() {
        format!("{}{}", upstream_base, remaining_path)
    } else {
        format!("{}{}?{}", upstream_base, remaining_path, query)
    };

    let mut upstream_req = state
        .http_client
        .request(method.clone(), &upstream_url)
        .body(body_bytes.to_vec());

    // Forward relevant headers
    if let Some(ct) = headers.get("content-type") {
        upstream_req = upstream_req.header("content-type", ct);
    }
    // Add API key: prefer env var, fall back to forwarding from incoming request
    if let Some(ref key) = state.api_key {
        upstream_req = upstream_req.header("Authorization", format!("Bearer {}", key));
    } else if let Some(auth) = headers.get("authorization") {
        upstream_req = upstream_req.header("authorization", auth);
    }

    let upstream_response = match upstream_req.send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Upstream error for {}: {}", upstream_url, e);
            return (StatusCode::BAD_GATEWAY, format!("Upstream error: {}", e)).into_response();
        }
    };

    let resp_status = upstream_response.status().as_u16();
    let resp_headers: Vec<(String, String)> = upstream_response
        .headers()
        .iter()
        .filter(|(k, _)| {
            let name = k.as_str();
            name == "content-type" || name == "content-encoding"
        })
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let resp_body = match upstream_response.text().await {
        Ok(t) => t,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("Failed to read upstream response: {}", e),
            )
                .into_response();
        }
    };

    // Cache successful (2xx) and client error (4xx) responses.
    // 4xx responses like 422 are deterministic (e.g., NEAR RPC "block unavailable")
    // and some tests depend on receiving them.
    // Skip caching 429 (rate limit) and 5xx (server errors) as they're transient.
    let should_cache = (200..300).contains(&resp_status)
        || ((400..500).contains(&resp_status) && resp_status != 429);
    if should_cache {
        let cached = CachedResponse {
            status: resp_status,
            headers: resp_headers.clone(),
            body: resp_body.clone(),
        };
        if let Ok(json) = serde_json::to_string_pretty(&cached)
            && let Err(e) = fs::write(&cache_path, json).await
        {
            eprintln!("Failed to write cache file {:?}: {}", cache_path, e);
        }
    } else {
        eprintln!(
            "Not caching {} response for {} {}",
            resp_status, remaining_path, query
        );
    }

    let status = StatusCode::from_u16(resp_status).unwrap_or(StatusCode::OK);
    let mut response = axum::response::Response::builder().status(status);
    for (k, v) in &resp_headers {
        response = response.header(k.as_str(), v.as_str());
    }
    response
        .body(Body::from(resp_body))
        .unwrap()
        .into_response()
}

fn find_upstream(path: &str) -> Option<(&'static str, String)> {
    for route in ROUTES {
        if let Some(remaining) = path.strip_prefix(route.prefix) {
            let remaining = if remaining.is_empty() {
                "/".to_string()
            } else {
                remaining.to_string()
            };
            return Some((route.upstream, remaining));
        }
    }
    None
}

fn compute_cache_key(upstream: &str, path: &str, query: &str, body: &[u8]) -> String {
    // Normalize JSON-RPC body by removing the "id" field which varies between runs
    let normalized_body = normalize_jsonrpc_body(body);

    let mut hasher = Sha256::new();
    hasher.update(upstream.as_bytes());
    hasher.update(b"|");
    hasher.update(path.as_bytes());
    hasher.update(b"|");
    hasher.update(query.as_bytes());
    hasher.update(b"|");
    hasher.update(&normalized_body);
    hex::encode(hasher.finalize())
}

/// Remove the "id" field from JSON-RPC request bodies so that cache keys
/// are stable across runs. The near-api crate generates random IDs.
fn normalize_jsonrpc_body(body: &[u8]) -> Vec<u8> {
    if let Ok(mut json) = serde_json::from_slice::<serde_json::Value>(body) {
        if let Some(obj) = json.as_object_mut() {
            obj.remove("id");
        }
        serde_json::to_vec(&json).unwrap_or_else(|_| body.to_vec())
    } else {
        body.to_vec()
    }
}
