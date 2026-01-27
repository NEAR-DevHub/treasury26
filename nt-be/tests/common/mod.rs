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

        // Start mock CoinGecko server
        let mock_server = MockServer::start().await;

        // Load price data from files and setup mock responses
        setup_coingecko_mocks(&mock_server).await;

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
            .env("COINGECKO_API_KEY", "test-api-key") // Enable price service
            .env("COINGECKO_API_BASE_URL", mock_server.uri()) // Point to mock server
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

/// Setup mock responses for CoinGecko API endpoints
async fn setup_coingecko_mocks(mock_server: &MockServer) {
    // Load price data from test files
    let assets = [
        ("near", include_str!("../test_data/price_data/near.json")),
        (
            "bitcoin",
            include_str!("../test_data/price_data/bitcoin.json"),
        ),
        (
            "ethereum",
            include_str!("../test_data/price_data/ethereum.json"),
        ),
        (
            "solana",
            include_str!("../test_data/price_data/solana.json"),
        ),
        (
            "ripple",
            include_str!("../test_data/price_data/ripple.json"),
        ),
        (
            "usd-coin",
            include_str!("../test_data/price_data/usd-coin.json"),
        ),
    ];

    for (asset_id, json_data) in assets {
        // Mock the market_chart/range endpoint (bulk historical prices)
        Mock::given(method("GET"))
            .and(path_regex(format!(
                r"^/coins/{}/market_chart/range",
                asset_id
            )))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(json_data)
                    .insert_header("content-type", "application/json"),
            )
            .mount(mock_server)
            .await;
    }

    // Return 404 for unknown assets
    Mock::given(method("GET"))
        .and(path_regex(r"^/coins/[^/]+/market_chart/range"))
        .respond_with(ResponseTemplate::new(404))
        .mount(mock_server)
        .await;
}
