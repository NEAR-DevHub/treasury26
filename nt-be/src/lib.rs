pub mod constants;
pub mod handlers;
pub mod routes;
pub mod utils;

use moka::future::Cache;
use near_api::NetworkConfig;
use sqlx::PgPool;

pub struct AppState {
    pub http_client: reqwest::Client,
    pub cache: Cache<String, serde_json::Value>,
    pub network: NetworkConfig,
    pub archival_network: NetworkConfig,
    pub env_vars: utils::env::EnvVars,
    pub db_pool: PgPool,
}
