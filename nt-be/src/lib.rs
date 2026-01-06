pub mod constants;
pub mod handlers;
pub mod routes;
pub mod services;
pub mod utils;

use moka::future::Cache;
use near_api::{AccountId, NetworkConfig, RPCEndpoint, Signer};
use sqlx::PgPool;
use std::{sync::Arc, time::Duration};

use services::{CoinGeckoClient, PriceLookupService};

pub struct AppState {
    pub http_client: reqwest::Client,
    pub cache: Cache<String, serde_json::Value>,
    pub short_term_cache: Cache<String, serde_json::Value>, // Shorter TTL cache for frequently changing data (policy, config, balances)
    pub signer: Arc<Signer>,
    pub signer_id: AccountId,
    pub network: NetworkConfig,
    pub archival_network: NetworkConfig,
    pub env_vars: utils::env::EnvVars,
    pub db_pool: PgPool,
    pub price_service: Option<PriceLookupService<CoinGeckoClient>>,
}

/// Initialize the application state with database connection and migrations
pub async fn init_app_state() -> Result<AppState, Box<dyn std::error::Error>> {
    let env_vars = utils::env::EnvVars::default();

    // Database connection
    log::info!("Connecting to database...");
    let db_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .acquire_timeout(Duration::from_secs(3))
        .connect(&env_vars.database_url)
        .await?;

    log::info!("Running database migrations...");
    sqlx::migrate!("./migrations").run(&db_pool).await?;

    log::info!("Database connection established successfully");

    // General cache for assets, profiles, metadata, etc. (longer TTL)
    let cache = Cache::builder()
        .max_capacity(10_000)
        .time_to_live(Duration::from_secs(300)) // 5 minutes
        .build();

    // Short-term cache for frequently changing data (policy, config, balances, etc.)
    let short_term_cache = Cache::builder()
        .max_capacity(1_000)
        .time_to_live(Duration::from_secs(30)) // 30 seconds
        .build();

    let http_client = reqwest::Client::new();

    // Initialize price service if CoinGecko API key is available
    let price_service = env_vars.coingecko_api_key.as_ref().map(|api_key| {
        log::info!("CoinGecko API key found, initializing price service");
        let coingecko_client = CoinGeckoClient::new(http_client.clone(), api_key.clone());
        PriceLookupService::new(db_pool.clone(), coingecko_client)
    });

    if price_service.is_none() {
        log::info!("No CoinGecko API key found, price enrichment will be disabled");
    }

    Ok(AppState {
        http_client,
        cache,
        short_term_cache,
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
        price_service,
    })
}
