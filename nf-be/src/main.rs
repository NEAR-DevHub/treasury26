mod handlers;
mod routes;
mod utils;

use axum::Router;
use moka::future::Cache;
use near_api::NetworkConfig;
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};

use crate::utils::env::EnvVars;

pub struct AppState {
    pub http_client: reqwest::Client,
    pub cache: Cache<String, serde_json::Value>,
    pub network: NetworkConfig,
    pub env_vars: EnvVars,
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    let cache = Cache::builder()
        .max_capacity(10_000)
        .time_to_live(Duration::from_secs(600))
        .build();

    let state = Arc::new(AppState {
        http_client: reqwest::Client::new(),
        cache,
        network: NetworkConfig::mainnet(),
        env_vars: EnvVars::default(),
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .merge(routes::create_routes(state))
        .layer(cors);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3002")
        .await
        .unwrap();

    println!("Server running on http://127.0.0.1:3002");

    axum::serve(listener, app).await.unwrap();
}
