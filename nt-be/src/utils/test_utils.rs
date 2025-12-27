//! Test utilities for balance change tests
//!
//! Provides common setup functions used across multiple test modules.

#[cfg(test)]
use crate::AppState;

#[cfg(test)]
use moka::future::Cache;

#[cfg(test)]
use near_api::{NetworkConfig, RPCEndpoint, Signer};

#[cfg(test)]
use std::time::Duration;

/// Load environment files in the correct order for tests
///
/// Loads .env files from multiple locations to ensure all required
/// environment variables are available for integration tests.
#[cfg(test)]
pub fn load_test_env() {
    dotenvy::from_filename(".env").ok();
    dotenvy::from_filename(".env.test").ok();
    dotenvy::from_filename("../.env").ok();
}

/// Initialize app state with loaded environment variables
///
/// This creates a minimal AppState for unit tests that only need
/// network configuration (no database connection or migrations).
/// Use this for tests that query the blockchain but don't need DB.
#[cfg(test)]
pub async fn init_test_state() -> AppState {
    load_test_env();

    let env_vars = crate::utils::env::EnvVars::default();

    let cache = Cache::builder()
        .max_capacity(10_000)
        .time_to_live(Duration::from_secs(600))
        .build();

    // Create a dummy pool that won't be used in unit tests
    // Tests that need DB should use sqlx::test macro instead
    let db_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(1))
        .connect_lazy(&env_vars.database_url)
        .expect("Failed to create lazy pool");

    AppState {
        http_client: reqwest::Client::new(),
        cache,
        signer: Signer::from_secret_key(env_vars.signer_key.clone())
            .expect("Failed to create signer."),
        signer_id: env_vars.signer_id.clone(),
        network: NetworkConfig {
            rpc_endpoints: vec![
                RPCEndpoint::new("https://rpc.mainnet.fastnear.com/".parse().unwrap())
                    .with_api_key(env_vars.fastnear_api_key.clone()),
            ],
            ..NetworkConfig::mainnet()
        },
        archival_network: NetworkConfig {
            rpc_endpoints: vec![
                RPCEndpoint::new(
                    "https://archival-rpc.mainnet.fastnear.com/"
                        .parse()
                        .unwrap(),
                )
                .with_api_key(env_vars.fastnear_api_key.clone()),
            ],
            ..NetworkConfig::mainnet()
        },
        env_vars,
        db_pool,
    }
}
