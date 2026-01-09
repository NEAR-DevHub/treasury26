pub mod constants;
pub mod handlers;
pub mod routes;
pub mod services;
pub mod utils;

use near_api::{AccountId, NetworkConfig, RPCEndpoint, Signer};
use sqlx::PgPool;
use std::{sync::Arc, time::Duration};

use services::{CoinGeckoClient, PriceLookupService};

pub struct AppState {
    pub http_client: reqwest::Client,
    pub cache: utils::cache::Cache,
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

    let http_client = reqwest::Client::new();

    // Initialize price service if CoinGecko API key is available
    let price_service = env_vars.coingecko_api_key.as_ref().map(|api_key| {
        // Use custom base URL if provided (for testing with mock server)
        let coingecko_client = if let Some(base_url) = &env_vars.coingecko_api_base_url {
            log::info!(
                "CoinGecko API key found, using custom base URL: {}",
                base_url
            );
            CoinGeckoClient::with_base_url(http_client.clone(), api_key.clone(), base_url.clone())
        } else {
            log::info!("CoinGecko API key found, initializing price service");
            CoinGeckoClient::new(http_client.clone(), api_key.clone())
        };
        PriceLookupService::new(db_pool.clone(), coingecko_client)
    });

    if price_service.is_none() {
        log::info!("No CoinGecko API key found, price enrichment will be disabled");
    }

    Ok(AppState {
        http_client,
        cache: utils::cache::Cache::new(),
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
