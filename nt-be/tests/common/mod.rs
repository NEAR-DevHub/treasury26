#![allow(dead_code)]

use near_api::{NetworkConfig, RPCEndpoint, Signer};
use nt_be::AppState;
use std::net::TcpListener;
use std::process::{Child, Command};
use std::sync::{Arc, Once};
use std::time::Duration;
use tokio::time::sleep;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path_regex},
};

/// Create a JWT for integration tests using the test JWT secret.
pub fn create_test_jwt(account_id: &str) -> String {
    use base64::Engine;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let jwt_secret = std::env::var("JWT_SECRET").unwrap_or_else(|_| "test-jwt-secret".to_string());
    let now = chrono::Utc::now();
    let exp = now + chrono::Duration::hours(24);

    let header =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
        serde_json::json!({
            "sub": account_id,
            "exp": exp.timestamp(),
            "iat": now.timestamp(),
        })
        .to_string(),
    );

    type HmacSha256 = Hmac<Sha256>;
    let mut mac = HmacSha256::new_from_slice(jwt_secret.as_bytes()).unwrap();
    mac.update(format!("{}.{}", header, payload).as_bytes());
    let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

    format!("{}.{}.{}", header, payload, sig)
}

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

/// Create archival network config for tests with fastnear API key.
/// Respects NEAR_ARCHIVAL_RPC_URL env var for proxy/cache override.
pub fn create_archival_network() -> NetworkConfig {
    load_test_env();

    let fastnear_api_key =
        std::env::var("FASTNEAR_API_KEY").expect("FASTNEAR_API_KEY must be set in .env");

    let rpc_url = std::env::var("NEAR_ARCHIVAL_RPC_URL")
        .unwrap_or_else(|_| "https://archival-rpc.mainnet.fastnear.com/".to_string());

    NetworkConfig {
        rpc_endpoints: vec![
            RPCEndpoint::new(rpc_url.parse().unwrap()).with_api_key(fastnear_api_key),
        ],
        ..NetworkConfig::mainnet()
    }
}

/// Get the FastNear API key for authenticated requests
pub fn get_fastnear_api_key() -> String {
    load_test_env();
    std::env::var("FASTNEAR_API_KEY").expect("FASTNEAR_API_KEY must be set in .env")
}

/// Build a test AppState whose primary `network` is the archival endpoint.
///
/// Most integration tests replay historical blocks that the current-head RPC
/// has pruned, so `run_maintenance_cycle` (which uses `state.network`) needs
/// to hit the archival RPC. Prefer this over [`build_test_state`] for any
/// test that calls the maintenance cycle against old blocks.
pub fn build_test_state_archival(db_pool: sqlx::PgPool) -> AppState {
    let mut state = build_test_state(db_pool);
    state.network = state.archival_network.clone();
    state
}

/// Build a full AppState for integration tests that need dirty monitor, etc.
///
/// Mirrors `src/utils/test_utils.rs::build_test_state()` but accessible from
/// integration tests (which can't use #[cfg(test)] items from the library).
pub fn build_test_state(db_pool: sqlx::PgPool) -> AppState {
    load_test_env();

    let env_vars = nt_be::utils::env::EnvVars::default();
    let http_client = reqwest::Client::new();

    let base_url = &env_vars.defillama_api_base_url;
    let defillama_client =
        nt_be::services::DeFiLlamaClient::with_base_url(http_client.clone(), base_url.clone());
    let price_service = nt_be::services::PriceLookupService::new(db_pool.clone(), defillama_client);

    let rpc_url = env_vars
        .near_rpc_url
        .clone()
        .unwrap_or_else(|| "https://rpc.mainnet.fastnear.com/".to_string());
    let archival_rpc_url = env_vars
        .near_archival_rpc_url
        .clone()
        .unwrap_or_else(|| "https://archival-rpc.mainnet.fastnear.com/".to_string());

    let network = NetworkConfig {
        rpc_endpoints: vec![
            RPCEndpoint::new(rpc_url.parse().unwrap())
                .with_api_key(env_vars.fastnear_api_key.clone()),
        ],
        ..NetworkConfig::mainnet()
    };

    let archival_network = NetworkConfig {
        rpc_endpoints: vec![
            RPCEndpoint::new(archival_rpc_url.parse().unwrap())
                .with_api_key(env_vars.fastnear_api_key.clone()),
        ],
        ..NetworkConfig::mainnet()
    };

    let transfer_hint_service = if env_vars.transfer_hints_enabled {
        use nt_be::handlers::balance_changes::transfer_hints::{
            TransferHintService, fastnear::FastNearProvider,
        };
        let provider = if let Some(base_url) = &env_vars.transfer_hints_base_url {
            FastNearProvider::with_base_url(archival_network.clone(), base_url.clone())
        } else {
            FastNearProvider::new(archival_network.clone())
        }
        .with_api_key(&env_vars.fastnear_api_key);
        Some(TransferHintService::new().with_provider(provider))
    } else {
        None
    };

    // Drop the driver so the gate fails open (no rate limiting in tests, matching
    // the old effectively-unlimited test limiter) without spawning a background task.
    let (nearblocks_gate, _) = nt_be::utils::priority_rate_gate::PriorityRateGate::<
        nt_be::handlers::public_history::bronze::NearblocksPriority,
    >::new(nt_be::utils::rate_limiter::RateLimiter::per_minute(
        "nearblocks-test",
        10_000,
        10_000,
    ));

    let (event_tx, _) = tokio::sync::broadcast::channel(nt_be::events::EVENT_BUS_CAPACITY);

    AppState {
        cache: nt_be::utils::cache::Cache::new(),
        telegram_client: nt_be::utils::telegram::TelegramClient::default(),
        http_client,
        nearblocks_gate,
        signer: Signer::from_secret_key(env_vars.signer_key.clone())
            .expect("Failed to create signer."),
        bulk_payment_signer: Signer::from_secret_key(env_vars.bulk_payment_signer.clone())
            .expect("Failed to create bulk payment signer"),
        signer_id: env_vars.signer_id.clone(),
        network,
        archival_network,
        bulk_payment_contract_id: env_vars.bulk_payment_contract_id.clone(),
        env_vars,
        token_price_service: Arc::new(nt_be::services::TokenPriceService::new(db_pool.clone())),
        db_pool,
        price_service,
        transfer_hint_service: transfer_hint_service.map(Arc::new),
        neardata_client: None,
        goldsky_pool: None,
        event_tx,
        creation_sweep_notify: Arc::new(tokio::sync::Notify::new()),
    }
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

fn available_local_port() -> u16 {
    let listener =
        TcpListener::bind("127.0.0.1:0").expect("Failed to bind ephemeral local test port");
    listener
        .local_addr()
        .expect("Failed to read local test port")
        .port()
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
        let port = available_local_port();

        // Start the pre-built server binary directly (not `cargo run`) to avoid
        // blocking on the cargo build lock when called from within `cargo test`.
        // Clear proxy env vars so the server uses real RPC endpoints (not the test proxy).
        let mut process = Command::new(env!("CARGO_BIN_EXE_nt-be"))
            .env("PORT", port.to_string())
            .env("RUST_LOG", "info")
            .env("MONITOR_INTERVAL_SECONDS", "0") // Disable background monitoring
            .env("DATABASE_URL", &db_url) // Override with test database
            .env(
                "SIGNER_KEY",
                "ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB",
            )
            .env("SIGNER_ID", "sandbox")
            .env("DEFILLAMA_API_BASE_URL", &mock_uri) // Point to mock server
            .env("GOLDSKY_DATABASE_URL", "")
            .env("NEARBLOCKS_API_KEY", "")
            .env_remove("NEAR_RPC_URL")
            .env_remove("NEAR_ARCHIVAL_RPC_URL")
            .env_remove("TRANSFER_HINTS_BASE_URL")
            .env_remove("NEARDATA_BASE_URL")
            .env_remove("INTENTS_EXPLORER_API_URL")
            .spawn()
            .expect("Failed to start server");

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

    /// Start the test server with Goldsky enrichment enabled (GOLDSKY_DATABASE_URL set).
    /// Workers use shortened delays for faster test execution:
    /// - Enrichment: 3s initial delay, 5s interval
    /// - Maintenance: 15s initial delay, 30s interval
    pub async fn start_with_goldsky(goldsky_database_url: &str) -> Self {
        load_test_env();

        let db_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");

        // Start mock DeFiLlama server
        let mock_server = start_mock_defillama_server().await;
        let mock_uri = mock_server.uri();
        let port = available_local_port();

        let mut process = Command::new(env!("CARGO_BIN_EXE_nt-be"))
            .env("PORT", port.to_string())
            .env("RUST_LOG", "info")
            .env("DATABASE_URL", &db_url)
            .env("GOLDSKY_DATABASE_URL", goldsky_database_url)
            // Tune worker timings for test: enrichment runs first, maintenance after
            .env("ENRICHMENT_INITIAL_DELAY_SECONDS", "3")
            .env("ENRICHMENT_INTERVAL_SECONDS", "10")
            .env("MAINTENANCE_INITIAL_DELAY_SECONDS", "45")
            .env("MAINTENANCE_INTERVAL_SECONDS", "60")
            .env(
                "SIGNER_KEY",
                "ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB",
            )
            .env("SIGNER_ID", "sandbox")
            .env("DEFILLAMA_API_BASE_URL", &mock_uri)
            .env_remove("NEAR_RPC_URL")
            .env_remove("NEAR_ARCHIVAL_RPC_URL")
            .env_remove("TRANSFER_HINTS_BASE_URL")
            .env_remove("NEARDATA_BASE_URL")
            .env_remove("INTENTS_EXPLORER_API_URL")
            .spawn()
            .expect("Failed to start server");

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
