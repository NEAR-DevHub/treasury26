//! Real-RPC failover + parity checks for the multi-endpoint NetworkConfig used
//! by treasury creation.
//!
//!   * HTTP 408/429/5xx from a *reachable* provider  -> failover to next endpoint
//!   * Hard connection error / client timeout          -> `Critical`, NO failover
//!
//! The second case is why the creation flow ALSO wraps everything in an
//! idempotent, transport-aware retry loop (`run_creation`): near-api alone will
//! not fail over when the primary provider is unreachable or hangs.
//!

mod common;

use near_api::{Contract, NetworkConfig, RPCEndpoint};
use serde_json::json;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

const DEAD_PRIMARY: &str = "http://127.0.0.1:9"; // closed port → connection refused
const DEAD_SECONDARY: &str = "http://127.0.0.1:19";
const FREE_FASTNEAR: &str = "https://free.rpc.fastnear.com";
const NEAR_ORG: &str = "https://rpc.mainnet.near.org";

/// A read-only call identical in shape to the confidential idempotency guard.
/// Always returns false, but proves the endpoint accepts the exact request our
/// flow sends. Uses the real near-api client path.
async fn has_public_key(network: &NetworkConfig) -> Result<bool, String> {
    Contract("intents.near".parse().unwrap())
        .call_function(
            "has_public_key",
            json!({
                "account_id": "intents.near",
                "public_key": "ed25519:11111111111111111111111111111111",
            }),
        )
        .read_only::<bool>()
        .fetch_from(network)
        .await
        .map(|r| r.data)
        .map_err(|e| format!("{e:?}"))
}

fn ep(url: &str) -> RPCEndpoint {
    RPCEndpoint::new(url.parse().unwrap()).with_retries(2)
}

/// SURPRISING near-api behavior, pinned by this test: even a plain HTTP 503
/// from the primary does NOT fail over. A bare 503 (non-schema body) is decoded
/// as `UnexpectedResponse`, which near-api treats as `Critical` → it returns
/// immediately and never tries the healthy fallback. (Only a schema-matching
/// typed error at 408/429/5xx would fail over, which real providers rarely
/// return.) This is why endpoint failover can't be relied on and the creation
/// flow uses an application-level retry loop instead.
#[tokio::test]
async fn http_5xx_does_not_fail_over() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&mock)
        .await;

    let network = NetworkConfig {
        rpc_endpoints: vec![ep(&mock.uri()), ep(NEAR_ORG)],
        ..NetworkConfig::mainnet()
    };

    let result = has_public_key(&network).await;
    println!("http_5xx_does_not_fail_over: result={result:?}");
    assert!(
        result.is_err(),
        "documents that near-api does NOT fail over on a bare 503, got: {result:?}"
    );
}

/// Documents the near-api limitation: a hard connection error on the primary is
/// `Critical`, so near-api returns immediately WITHOUT trying the fallback.
/// (Resilience for this case comes from the creation-level retry loop, not from
/// endpoint failover.)
#[tokio::test]
async fn no_failover_on_connection_error() {
    let network = NetworkConfig {
        rpc_endpoints: vec![ep(DEAD_PRIMARY), ep(NEAR_ORG)],
        ..NetworkConfig::mainnet()
    };

    let result = has_public_key(&network).await;
    println!("no_failover_on_connection_error: result={result:?}");
    assert!(
        result.is_err(),
        "connection error is Critical in near-api → no failover expected, got: {result:?}"
    );

    // The surfaced error is transport-classified, so the creation retry loop
    // (is_transport_error) WILL retry it at the application level.
    let err = result.unwrap_err();
    assert!(
        nt_be::handlers::balance_changes::utils::is_transport_error(&err),
        "error should be transport-retryable by the creation loop, got: {err}"
    );
}

/// All endpoints unreachable → error (which the creation loop then retries).
#[tokio::test]
async fn all_endpoints_dead_returns_error() {
    let network = NetworkConfig {
        rpc_endpoints: vec![ep(DEAD_PRIMARY), ep(DEAD_SECONDARY)],
        ..NetworkConfig::mainnet()
    };

    let result = has_public_key(&network).await;
    println!("all_endpoints_dead_returns_error: result={result:?}");
    assert!(
        result.is_err(),
        "all-dead endpoints must error, got: {result:?}"
    );
}

/// Parity: each production endpoint (incl. authed FastNEAR) returns the SAME
/// result for the SAME request via the real near-api client path.
#[tokio::test]
async fn parity_across_production_endpoints() {
    let fastnear_key = common::get_fastnear_api_key();

    let endpoints: Vec<(&str, RPCEndpoint)> = vec![
        (
            "fastnear (authed)",
            RPCEndpoint::new("https://rpc.mainnet.fastnear.com/".parse().unwrap())
                .with_api_key(fastnear_key),
        ),
        (
            "free.fastnear",
            RPCEndpoint::new(FREE_FASTNEAR.parse().unwrap()),
        ),
        ("near.org", RPCEndpoint::new(NEAR_ORG.parse().unwrap())),
    ];

    let mut results = Vec::new();
    for (label, endpoint) in endpoints {
        let network = NetworkConfig {
            rpc_endpoints: vec![endpoint],
            ..NetworkConfig::mainnet()
        };
        let res = has_public_key(&network).await;
        println!("parity {label:20} -> {res:?}");
        results.push(res.unwrap_or_else(|e| panic!("{label} failed: {e}")));
    }

    assert!(
        results.windows(2).all(|w| w[0] == w[1]),
        "all endpoints must return identical results, got: {results:?}"
    );
}
