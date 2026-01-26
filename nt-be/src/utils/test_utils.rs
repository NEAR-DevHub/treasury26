//! Test utilities for balance change tests
//!
//! Provides common setup functions used across multiple test modules.

#[cfg(test)]
use crate::AppState;

#[cfg(test)]
use crate::utils::cache::Cache;

#[cfg(test)]
use near_api::{NetworkConfig, RPCEndpoint, Signer};

#[cfg(test)]
use std::sync::Once;

#[cfg(test)]
use std::time::Duration;

#[cfg(test)]
static INIT: Once = Once::new();

/// Load environment files in the correct order for tests
///
/// Loads .env files to ensure required environment variables are available.
/// Uses plain `from_filename` (not `override`) to avoid changing DATABASE_URL
/// when sqlx::test macro has already read it at compile time.
///
/// NOTE: Integration tests in `tests/` use `tests/common/mod.rs::load_test_env()`
/// which does override DATABASE_URL for the test database.
#[cfg(test)]
pub fn load_test_env() {
    INIT.call_once(|| {
        dotenvy::from_filename(".env").ok();
        dotenvy::from_filename(".env.test").ok();
    });
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
    // Create a dummy pool that won't be used in unit tests
    // Tests that need DB should use sqlx::test macro instead
    let db_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(1))
        .connect_lazy(&env_vars.database_url)
        .expect("Failed to create lazy pool");

    let http_client = reqwest::Client::new();

    // Initialize price service - with CoinGecko provider if API key is available
    let price_service = if let Some(api_key) = env_vars.coingecko_api_key.as_ref() {
        let base_url = &env_vars.coingecko_api_base_url;
        let coingecko_client = crate::services::CoinGeckoClient::with_base_url(
            http_client.clone(),
            api_key.clone(),
            base_url.clone(),
        );
        crate::services::PriceLookupService::new(db_pool.clone(), coingecko_client)
    } else {
        crate::services::PriceLookupService::without_provider(db_pool.clone())
    };

    // Create network configs first (needed for transfer hint service)
    let network = NetworkConfig {
        rpc_endpoints: vec![
            RPCEndpoint::new("https://rpc.mainnet.fastnear.com/".parse().unwrap())
                .with_api_key(env_vars.fastnear_api_key.clone()),
        ],
        ..NetworkConfig::mainnet()
    };

    let archival_network = NetworkConfig {
        rpc_endpoints: vec![
            RPCEndpoint::new(
                "https://archival-rpc.mainnet.fastnear.com/"
                    .parse()
                    .unwrap(),
            )
            .with_api_key(env_vars.fastnear_api_key.clone()),
        ],
        ..NetworkConfig::mainnet()
    };

    // Create transfer hint service if enabled
    let transfer_hint_service = if env_vars.transfer_hints_enabled {
        use crate::handlers::balance_changes::transfer_hints::{
            TransferHintService, fastnear::FastNearProvider,
        };
        let provider = if let Some(base_url) = &env_vars.transfer_hints_base_url {
            FastNearProvider::with_base_url(archival_network.clone(), base_url.clone())
        } else {
            FastNearProvider::new(archival_network.clone())
        };
        Some(TransferHintService::new().with_provider(provider))
    } else {
        None
    };

    AppState {
        cache: Cache::new(),
        telegram_client: crate::utils::telegram::TelegramClient::default(),
        http_client,
        signer: Signer::from_secret_key(env_vars.signer_key.clone())
            .expect("Failed to create signer."),
        signer_id: env_vars.signer_id.clone(),
        network,
        archival_network,
        bulk_payment_contract_id: env_vars.bulk_payment_contract_id.clone(),
        env_vars,
        db_pool,
        price_service,
        transfer_hint_service,
    }
}
