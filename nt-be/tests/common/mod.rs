use near_api::{NetworkConfig, RPCEndpoint};
use std::process::{Child, Command};
use std::sync::Once;
use std::time::Duration;
use tokio::time::sleep;
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

static INIT: Once = Once::new();

/// Load test environment variables. Safe to call multiple times - only runs once.
/// Loads .env first, then .env.test which overrides (e.g., DATABASE_URL for test database).
///
/// NOTE: Keep in sync with `src/utils/test_utils.rs::load_test_env()` which serves
/// unit tests. Integration tests can't access #[cfg(test)] items from the library.
pub fn load_test_env() {
    INIT.call_once(|| {
        dotenvy::from_filename(".env").ok();
        dotenvy::from_filename_override(".env.test").ok();
    });
}

/// Create archival network config for tests with fastnear API key
pub fn create_archival_network() -> NetworkConfig {
    load_test_env();

    let fastnear_api_key =
        std::env::var("FASTNEAR_API_KEY").expect("FASTNEAR_API_KEY must be set in .env");

    // Use fastnear archival RPC which supports historical queries
    NetworkConfig {
        rpc_endpoints: vec![
            RPCEndpoint::new(
                "https://archival-rpc.mainnet.fastnear.com/"
                    .parse()
                    .unwrap(),
            )
            .with_api_key(fastnear_api_key),
        ],
        ..NetworkConfig::mainnet()
    }
}

/// Get the FastNear API key for authenticated requests
pub fn get_fastnear_api_key() -> String {
    load_test_env();
    std::env::var("FASTNEAR_API_KEY").expect("FASTNEAR_API_KEY must be set in .env")
}

pub struct TestServer {
    process: Child,
    port: u16,
    _mock_server: MockServer, // Keep mock server alive
}

impl TestServer {
    pub async fn start() -> Self {
        load_test_env();

        let db_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");

        // Start mock DeFiLlama server
        let mock_server = MockServer::start().await;

        // Load price data from files and setup mock responses
        setup_defillama_mocks(&mock_server).await;

        // Start the server in the background with mock CoinGecko URL
        let mut process = Command::new("cargo")
            .args(["run", "--bin", "nt-be"])
            .env("PORT", "3001")
            .env("RUST_LOG", "info")
            .env("MONITOR_INTERVAL_SECONDS", "0") // Disable background monitoring
            .env("DATABASE_URL", &db_url) // Override with test database
            .env(
                "SIGNER_KEY",
                "ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB",
            )
            .env("SIGNER_ID", "sandbox")
            .env("DEFILLAMA_API_BASE_URL", mock_server.uri()) // Point to mock DeFiLlama server
            .spawn()
            .expect("Failed to start server");

        let port = 3001;

        // Wait for server to be ready
        let client = reqwest::Client::new();
        for attempt in 0..60 {
            if attempt % 10 == 0 && attempt > 0 {
                println!("Still waiting for server... (attempt {}/60)", attempt);
            }
            sleep(Duration::from_millis(500)).await;
            if let Ok(response) = client
                .get(format!("http://localhost:{}/api/health", port))
                .send()
                .await
                && response.status().is_success()
            {
                println!("Server ready after {} attempts", attempt + 1);
                return TestServer {
                    process,
                    port,
                    _mock_server: mock_server,
                };
            }
        }

        // Kill process before panicking to avoid zombie
        let _ = process.kill();
        let _ = process.wait();
        panic!("Server failed to start within timeout");
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://localhost:{}{}", self.port, path)
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        let _ = self.process.kill();
    }
}

/// Setup mock responses for DeFiLlama API endpoints
///
/// Converts CoinGecko-format test data to DeFiLlama response format.
/// DeFiLlama historical endpoint: /prices/historical/{timestamp}/{coins}
/// DeFiLlama chart endpoint: /chart/{coins}?start={timestamp}&span={days}&period=1d
async fn setup_defillama_mocks(mock_server: &MockServer) {
    use serde_json::{json, Value};

    // Load price data from test files (CoinGecko format: {"prices": [[timestamp_ms, price], ...]})
    let assets = [
        ("coingecko:near", include_str!("../test_data/price_data/near.json")),
        ("coingecko:bitcoin", include_str!("../test_data/price_data/bitcoin.json")),
        ("coingecko:ethereum", include_str!("../test_data/price_data/ethereum.json")),
        ("coingecko:solana", include_str!("../test_data/price_data/solana.json")),
        ("coingecko:ripple", include_str!("../test_data/price_data/ripple.json")),
        ("coingecko:usd-coin", include_str!("../test_data/price_data/usd-coin.json")),
    ];

    // Parse and store price data for each asset
    let mut price_data: std::collections::HashMap<String, Vec<(i64, f64)>> = std::collections::HashMap::new();

    for (asset_id, json_data) in assets {
        let data: Value = serde_json::from_str(json_data).expect("Invalid JSON in test data");
        let prices = data["prices"].as_array().expect("prices should be an array");

        let parsed_prices: Vec<(i64, f64)> = prices
            .iter()
            .map(|p| {
                let arr = p.as_array().expect("price entry should be array");
                let timestamp_ms = arr[0].as_i64().expect("timestamp should be i64");
                let price = arr[1].as_f64().expect("price should be f64");
                (timestamp_ms / 1000, price) // Convert ms to seconds
            })
            .collect();

        price_data.insert(asset_id.to_string(), parsed_prices);
    }

    // Clone for the closure
    let price_data_for_historical = price_data.clone();
    let price_data_for_chart = price_data.clone();

    // Mock the /prices/historical/{timestamp}/{coins} endpoint
    Mock::given(method("GET"))
        .and(path_regex(r"^/prices/historical/\d+/coingecko:[a-z-]+"))
        .respond_with(move |req: &wiremock::Request| {
            let path = req.url.path();
            let parts: Vec<&str> = path.split('/').collect();
            // Path format: /prices/historical/{timestamp}/{coin}
            if parts.len() < 4 {
                return ResponseTemplate::new(404);
            }

            let timestamp: i64 = parts[3].parse().unwrap_or(0);
            let coin = parts[4];

            if let Some(prices) = price_data_for_historical.get(coin) {
                // Find the closest price to the requested timestamp
                let mut closest_price = None;
                let mut closest_diff = i64::MAX;

                for (ts, price) in prices {
                    let diff = (ts - timestamp).abs();
                    if diff < closest_diff {
                        closest_diff = diff;
                        closest_price = Some((*ts, *price));
                    }
                }

                if let Some((ts, price)) = closest_price {
                    let response = json!({
                        "coins": {
                            coin: {
                                "price": price,
                                "symbol": coin.split(':').last().unwrap_or("").to_uppercase(),
                                "timestamp": ts,
                                "confidence": 0.99
                            }
                        }
                    });
                    return ResponseTemplate::new(200)
                        .set_body_json(response)
                        .insert_header("content-type", "application/json");
                }
            }

            // Asset not found
            ResponseTemplate::new(200)
                .set_body_json(json!({"coins": {}}))
                .insert_header("content-type", "application/json")
        })
        .mount(mock_server)
        .await;

    // Mock the /chart/{coins} endpoint for bulk historical prices
    Mock::given(method("GET"))
        .and(path_regex(r"^/chart/coingecko:[a-z-]+"))
        .respond_with(move |req: &wiremock::Request| {
            let path = req.url.path();
            let coin = path.strip_prefix("/chart/").unwrap_or("");

            if let Some(prices) = price_data_for_chart.get(coin) {
                let price_points: Vec<Value> = prices
                    .iter()
                    .map(|(ts, price)| json!({"timestamp": ts, "price": price}))
                    .collect();

                let response = json!({
                    "coins": {
                        coin: {
                            "prices": price_points,
                            "symbol": coin.split(':').last().unwrap_or("").to_uppercase()
                        }
                    }
                });
                return ResponseTemplate::new(200)
                    .set_body_json(response)
                    .insert_header("content-type", "application/json");
            }

            // Asset not found
            ResponseTemplate::new(200)
                .set_body_json(json!({"coins": {}}))
                .insert_header("content-type", "application/json")
        })
        .mount(mock_server)
        .await;
}
