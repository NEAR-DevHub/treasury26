mod constants;
mod handlers;
mod routes;
mod utils;

use axum::Router;
use moka::future::Cache;
use near_api::{NetworkConfig, RPCEndpoint};
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};

use crate::utils::env::EnvVars;

pub struct AppState {
    pub http_client: reqwest::Client,
    pub cache: Cache<String, serde_json::Value>,
    pub network: NetworkConfig,
    pub archival_network: NetworkConfig,
    pub env_vars: EnvVars,
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    let cache = Cache::builder()
        .max_capacity(10_000)
        .time_to_live(Duration::from_secs(600))
        .build();

    let env_vars = EnvVars::default();
    let state = Arc::new(AppState {
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
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .merge(routes::create_routes(state))
        .layer(cors);

    let port = std::env::var("PORT").unwrap_or_else(|_| "3002".to_string());
    let addr = format!("0.0.0.0:{}", port);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap();

    println!("Server running on {}", addr);

    axum::serve(listener, app).await.unwrap();
}
