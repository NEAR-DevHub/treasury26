use near_api::{NetworkConfig, RPCEndpoint};
use std::process::{Child, Command};
use std::sync::Once;
use std::time::Duration;
use tokio::time::sleep;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path_regex},
};

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

/// Start a mock DeFiLlama server with test data
///
/// This function sets up wiremock to respond to DeFiLlama API requests with deterministic test data.
/// The mock data is stored in `tests/test_data/defillama_mocks/` directory.
///
/// ## Mock Data Generation
///
/// The mock files were generated using real DeFiLlama API queries (365 days of data):
///
/// ```bash
/// # Example queries used to generate mock data (from 2024-12-06 to 2025-12-05):
/// # https://coins.llama.fi/chart/coingecko:near?start=1733443200&span=365&period=1d
/// # https://coins.llama.fi/chart/coingecko:bitcoin?start=1733443200&span=365&period=1d
/// # https://coins.llama.fi/chart/coingecko:ethereum?start=1733443200&span=365&period=1d
/// # https://coins.llama.fi/chart/coingecko:solana?start=1733443200&span=365&period=1d
/// # https://coins.llama.fi/chart/coingecko:ripple?start=1733443200&span=365&period=1d
/// # https://coins.llama.fi/chart/coingecko:usd-coin?start=1733443200&span=365&period=1d
/// ```
///
/// Each mock file contains the JSON response from DeFiLlama's `/chart` endpoint.
pub async fn start_mock_defillama_server() -> MockServer {
    let mock_server = MockServer::start().await;

    // Map of asset IDs to their mock response files
    let assets = vec![
        "coingecko:near",
        "coingecko:bitcoin",
        "coingecko:ethereum",
        "coingecko:solana",
        "coingecko:ripple",
        "coingecko:usd-coin",
    ];

    for asset_id in assets {
        // Extract the coin name from the coingecko:coin-name format
        let coin_name = asset_id.strip_prefix("coingecko:").unwrap();
        let mock_file = format!("tests/test_data/defillama_mocks/{}.json", coin_name);

        let mock_data = std::fs::read_to_string(&mock_file).unwrap_or_else(|_| {
            panic!(
                "Failed to read mock DeFiLlama data from {}.\n\
                 See function docs for how to generate this file from real DeFiLlama API.",
                mock_file
            )
        });

        // Mock the /chart/{coin} endpoint used by background price sync
        // Example: /chart/coingecko:near?start=1733443200&span=365&period=1d
        // The background sync service bulk-loads all historical prices using this endpoint,
        // then the API reads from the database cache (no need to mock /prices/historical)
        Mock::given(method("GET"))
            .and(path_regex(format!(
                r"^/chart/{}(\?.*)?$",
                regex::escape(asset_id)
            )))
            .respond_with(ResponseTemplate::new(200).set_body_string(mock_data))
            .mount(&mock_server)
            .await;
    }

    println!("✓ Mock DeFiLlama server started at {}", mock_server.uri());

    mock_server
}

pub struct TestServer {
    process: Child,
    port: u16,
    _mock_server: Option<MockServer>,
}

impl TestServer {
    /// Start the test server with a mock DeFiLlama server for deterministic tests
    pub async fn start() -> Self {
        load_test_env();

        let db_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");

        // Start mock DeFiLlama server
        let mock_server = start_mock_defillama_server().await;
        let mock_uri = mock_server.uri();

        // Start the server in the background, pointing to the mock DeFiLlama API
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
            .env("DEFILLAMA_API_BASE_URL", &mock_uri) // Point to mock server
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
                    _mock_server: Some(mock_server),
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
