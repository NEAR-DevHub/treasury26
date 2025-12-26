pub mod constants;
pub mod handlers;
pub mod routes;
pub mod utils;

use moka::future::Cache;
use near_api::{NetworkConfig, RPCEndpoint};
use sqlx::PgPool;
use std::time::Duration;

pub struct AppState {
    pub http_client: reqwest::Client,
    pub cache: Cache<String, serde_json::Value>,
    pub network: NetworkConfig,
    pub archival_network: NetworkConfig,
    pub env_vars: utils::env::EnvVars,
    pub db_pool: PgPool,
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

    let cache = Cache::builder()
        .max_capacity(10_000)
        .time_to_live(Duration::from_secs(600))
        .build();


    Ok(AppState {
        http_client: reqwest::Client::new(),
        cache,
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
    })
}
