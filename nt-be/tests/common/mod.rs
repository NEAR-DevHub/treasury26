use near_api::{NetworkConfig, RPCEndpoint};
use std::process::{Child, Command};
use std::time::Duration;
use tokio::time::sleep;

/// Create archival network config for tests with fastnear API key
pub fn create_archival_network() -> NetworkConfig {
    // Load .env files to get FASTNEAR_API_KEY
    dotenvy::from_filename(".env").ok();
    dotenvy::from_filename(".env.test").ok();

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

pub struct TestServer {
    process: Child,
    port: u16,
}

impl TestServer {
    pub async fn start() -> Self {
        // Load environment variables - .env.test overrides DATABASE_URL to test database
        dotenvy::from_filename(".env").ok();
        dotenvy::from_filename(".env.test").ok();

        let db_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");

        // Start the server in the background
        let mut process = Command::new("cargo")
            .args(["run", "--bin", "nt-be"])
            .env("PORT", "3001")
            .env("RUST_LOG", "info")
            .env("MONITOR_INTERVAL_MINUTES", "0") // Disable background monitoring
            .env("DATABASE_URL", &db_url) // Override with test database
            .env(
                "SIGNER_KEY",
                "ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB",
            )
            .env("SIGNER_ID", "sandbox")
            .env("COINGECKO_API_KEY", "") // Disable price service for consistent test results
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
                return TestServer { process, port };
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
