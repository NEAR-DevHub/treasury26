use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

#[tokio::test]
async fn test_health_endpoint_with_database() {
    // Load environment variables
    dotenvy::dotenv().ok();
    
    // Get database URL from environment
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set for tests");
    
    // Create database pool
    let db_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .expect("Failed to connect to test database");
    
    // Run migrations
    sqlx::migrate!("./migrations")
        .run(&db_pool)
        .await
        .expect("Failed to run migrations");
    
    // Create app state
    let cache = moka::future::Cache::builder()
        .max_capacity(100)
        .time_to_live(std::time::Duration::from_secs(60))
        .build();
    
    let env_vars = nf_be::utils::env::EnvVars::default();
    let state = std::sync::Arc::new(nf_be::AppState {
        http_client: reqwest::Client::new(),
        cache,
        network: near_api::NetworkConfig::mainnet(),
        archival_network: near_api::NetworkConfig::mainnet(),
        env_vars,
        db_pool,
    });
    
    // Create router
    let app = nf_be::routes::create_routes(state);
    
    // Make request to health endpoint
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap()
        )
        .await
        .unwrap();
    
    // Assert response
    assert_eq!(response.status(), StatusCode::OK);
    
    // Parse response body
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    
    // Check that database is connected
    assert_eq!(json["status"], "healthy");
    assert_eq!(json["database"]["connected"], true);
    assert!(json["database"]["pool_size"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn test_health_endpoint_structure() {
    dotenvy::dotenv().ok();
    
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set for tests");
    
    let db_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .expect("Failed to connect to test database");
    
    sqlx::migrate!("./migrations")
        .run(&db_pool)
        .await
        .expect("Failed to run migrations");
    
    let cache = moka::future::Cache::builder()
        .max_capacity(100)
        .time_to_live(std::time::Duration::from_secs(60))
        .build();
    
    let env_vars = nf_be::utils::env::EnvVars::default();
    let state = std::sync::Arc::new(nf_be::AppState {
        http_client: reqwest::Client::new(),
        cache,
        network: near_api::NetworkConfig::mainnet(),
        archival_network: near_api::NetworkConfig::mainnet(),
        env_vars,
        db_pool,
    });
    
    let app = nf_be::routes::create_routes(state);
    
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap()
        )
        .await
        .unwrap();
    
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    
    // Verify response structure
    assert!(json.get("status").is_some());
    assert!(json.get("timestamp").is_some());
    assert!(json.get("database").is_some());
    
    let database = &json["database"];
    assert!(database.get("connected").is_some());
    assert!(database.get("pool_size").is_some());
    assert!(database.get("idle_connections").is_some());
}
