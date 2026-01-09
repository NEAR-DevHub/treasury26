#![allow(clippy::collapsible_if)]
#![allow(clippy::io_other_error)]

mod common;

use chrono::{DateTime, Utc};
use nt_be::AppState;
use sqlx::PgPool;
use std::str::FromStr;

/// Test finding block height from database when data exists
#[sqlx::test]
async fn test_find_block_height_from_database(pool: PgPool) -> sqlx::Result<()> {
    // Insert a test balance change record
    let account_id = "test.near";
    let block_height: i64 = 151386339;
    let block_timestamp: i64 = 1750097144159145697; // nanoseconds since Unix epoch

    sqlx::query!(
        r#"
        INSERT INTO balance_changes
        (account_id, block_height, block_timestamp, transaction_hashes, counterparty, amount, balance_before, balance_after)
        VALUES ($1, $2, $3, '{}', 'test_counterparty', 1000, 0, 1000)
        "#,
        account_id,
        block_height,
        block_timestamp,
    )
    .execute(&pool)
    .await?;

    // Create AppState with test database
    let app_state = create_test_app_state(pool).await;

    // Convert the block timestamp to DateTime
    let target_date = DateTime::<Utc>::from_timestamp_nanos(block_timestamp);

    // Try to find the block height
    let result = app_state
        .find_block_height(target_date)
        .await
        .expect("Should find block in database");

    assert_eq!(
        result, block_height as u64,
        "Should return the correct block height from database"
    );

    Ok(())
}

/// Test finding block height using binary search when not in database
#[tokio::test]
#[ignore] // This test makes real RPC calls, run with --ignored
async fn test_find_block_height_with_binary_search() {
    // Create a minimal test app state (no DB needed for this test)
    let pool = create_test_pool().await;
    let app_state = create_test_app_state(pool).await;

    // Use a known block timestamp - Block 151386339 from the binary_search tests
    // Timestamp: 1750097144159145697 nanoseconds = ~2025-12-16
    let target_timestamp_ns = 1750097144159145697i64;
    let target_date = DateTime::<Utc>::from_timestamp_nanos(target_timestamp_ns);

    // Try to find the block height using binary search
    let result = app_state
        .find_block_height(target_date)
        .await
        .expect("Should find block via binary search");

    println!("Found block {} for timestamp {}", result, target_date);

    // The result should be close to the expected block (151386339)
    // Allow some margin since we're searching by timestamp
    assert!(
        result >= 151386330 && result <= 151386350,
        "Block should be near 151386339, got {}",
        result
    );
}

/// Test error handling for future timestamps
#[tokio::test]
#[ignore] // This test makes real RPC calls, run with --ignored
async fn test_find_block_height_future_timestamp() {
    let pool = create_test_pool().await;
    let app_state = create_test_app_state(pool).await;

    // Use a timestamp far in the future
    let future_date = DateTime::<Utc>::from_timestamp(9999999999, 0)
        .expect("Should create future timestamp");

    // Try to find block height - should fail with error about future timestamp
    let result = app_state.find_block_height(future_date).await;

    assert!(
        result.is_err(),
        "Should return error for future timestamp"
    );

    let error_msg = result.unwrap_err().to_string();
    assert!(
        error_msg.contains("future") || error_msg.contains("Future"),
        "Error should mention timestamp is in the future, got: {}",
        error_msg
    );
}

/// Test finding block at the beginning of the chain
#[tokio::test]
#[ignore] // This test makes real RPC calls, run with --ignored
async fn test_find_block_height_genesis() {
    let pool = create_test_pool().await;
    let app_state = create_test_app_state(pool).await;

    // Use a very early timestamp (shortly after genesis)
    // NEAR mainnet genesis was around July 2020
    let early_date = DateTime::<Utc>::from_str("2020-07-22T00:00:00Z")
        .expect("Should parse date");

    let result = app_state
        .find_block_height(early_date)
        .await
        .expect("Should find early block");

    println!("Found block {} for early date {}", result, early_date);

    // Should return a very low block number
    assert!(
        result < 1_000_000,
        "Early block should be less than 1M, got {}",
        result
    );
}

/// Helper: Create a test database pool
async fn create_test_pool() -> PgPool {
    dotenvy::from_filename(".env").ok();
    dotenvy::from_filename(".env.test").ok();

    let db_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://treasury_test:test_password@localhost:5433/treasury_test_db".to_string());

    sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await
        .expect("Failed to create test pool")
}

/// Helper: Create AppState for testing
async fn create_test_app_state(pool: PgPool) -> AppState {
    use near_api::{AccountId, NetworkConfig, RPCEndpoint, Signer};
    use std::sync::Arc;

    dotenvy::from_filename(".env").ok();
    dotenvy::from_filename(".env.test").ok();

    let fastnear_api_key = std::env::var("FASTNEAR_API_KEY")
        .expect("FASTNEAR_API_KEY must be set in .env");

    let test_signer_key = "ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB";

    AppState {
        http_client: reqwest::Client::new(),
        cache: moka::future::Cache::builder()
            .max_capacity(100)
            .time_to_live(std::time::Duration::from_secs(60))
            .build(),
        short_term_cache: moka::future::Cache::builder()
            .max_capacity(100)
            .time_to_live(std::time::Duration::from_secs(10))
            .build(),
        signer: Arc::new(
            Signer::from_secret_key(test_signer_key.parse().unwrap())
                .expect("Failed to create test signer"),
        ),
        signer_id: AccountId::from_str("test.near").unwrap(),
        network: NetworkConfig {
            rpc_endpoints: vec![
                RPCEndpoint::new("https://rpc.mainnet.fastnear.com/".parse().unwrap())
                    .with_api_key(fastnear_api_key.clone()),
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
                .with_api_key(fastnear_api_key),
            ],
            ..NetworkConfig::mainnet()
        },
        env_vars: nt_be::utils::env::EnvVars::default(),
        db_pool: pool,
        price_service: None,
    }
}
