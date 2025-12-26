use axum::Router;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    // Initialize logging
    if std::env::var("RUST_LOG").is_err() {
        unsafe {
            std::env::set_var("RUST_LOG", "info");
        }
    }
    env_logger::init();

    // Initialize application state
    let state = Arc::new(
        nf_be::init_app_state()
            .await
            .expect("Failed to initialize application state"),
    );

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .merge(nf_be::routes::create_routes(state))
        .layer(cors);

    let port = std::env::var("PORT").unwrap_or_else(|_| "3002".to_string());
    let addr = format!("0.0.0.0:{}", port);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();

    println!("Server running on {}", addr);

    axum::serve(listener, app).await.unwrap();
}
