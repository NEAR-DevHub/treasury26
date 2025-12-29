//! Integration tests for balance history APIs
//!
//! Tests both the Chart API and CSV Export API endpoints using real webassemblymusic-treasury data

mod common;

use common::TestServer;

/// Load webassemblymusic-treasury test data from SQL dump files
async fn load_test_data() {
    // Get test database URL
    let db_url = std::env::var("DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL_TEST"))
        .expect("DATABASE_URL or DATABASE_URL_TEST must be set");

    // Connect to database
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await
        .expect("Failed to connect to test database");

    // Check if data is already loaded
    let existing_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM balance_changes 
         WHERE account_id = 'webassemblymusic-treasury.sputnik-dao.near'"
    )
    .fetch_one(&pool)
    .await
    .expect("Failed to check existing data");

    if existing_count > 0 {
        println!("✓ Test data already loaded ({} records)", existing_count);
        pool.close().await;
        return;
    }

    println!("Loading webassemblymusic-treasury test data...");

    // Read and execute counterparties SQL
    let counterparties_sql = std::fs::read_to_string("tests/test_data/webassemblymusic_counterparties.sql")
        .expect("Failed to read counterparties SQL file");
    sqlx::query(&counterparties_sql)
        .execute(&pool)
        .await
        .expect("Failed to load counterparties");

    // Read and execute balance changes SQL (line by line)
    let balance_changes_sql = std::fs::read_to_string("tests/test_data/webassemblymusic_balance_changes.sql")
        .expect("Failed to read balance changes SQL file");

    for statement in balance_changes_sql.lines() {
        if !statement.trim().is_empty() {
            sqlx::query(statement)
                .execute(&pool)
                .await
                .expect("Failed to load balance change");
        }
    }

    // Add monitored account
    sqlx::query(
        "INSERT INTO monitored_accounts (account_id, created_at)
         VALUES ('webassemblymusic-treasury.sputnik-dao.near', NOW())
         ON CONFLICT (account_id) DO NOTHING"
    )
    .execute(&pool)
    .await
    .expect("Failed to add monitored account");

    // Show summary
    let balance_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM balance_changes 
         WHERE account_id = 'webassemblymusic-treasury.sputnik-dao.near'"
    )
    .fetch_one(&pool)
    .await
    .expect("Failed to count balance changes");

    println!("✓ Loaded {} balance change records", balance_count);

    pool.close().await;
}

/// Test the chart API with webassemblymusic-treasury data
#[tokio::test]
async fn test_balance_chart_with_real_data() {
    // Load environment variables
    dotenvy::dotenv().ok();

    // Load test data
    load_test_data().await;

    // Start the server
    let server = TestServer::start().await;
    let client = reqwest::Client::new();

    // Test Chart API with specific date range
    let response = client
        .get(server.url("/api/balance-history/chart"))
        .query(&[
            ("account_id", "webassemblymusic-treasury.sputnik-dao.near"),
            ("start_time", "2025-12-01T00:00:00"),
            ("end_time", "2025-12-05T20:14:00"),
            ("interval", "daily"),
        ])
        .send()
        .await
        .expect("Failed to send request");

    let status = response.status();
    let body_text = response.text().await.expect("Failed to read response body");

    assert_eq!(
        status,
        200,
        "Chart API should return 200. Status: {}, Body: {}",
        status,
        body_text
    );

    let chart_data: serde_json::Value = serde_json::from_str(&body_text)
        .expect("Failed to parse JSON response");

    println!("Chart data: {}", serde_json::to_string_pretty(&chart_data).unwrap());

    // Verify response structure - should be grouped by token
    assert!(chart_data.is_object(), "Response should be an object");

    let token_map = chart_data.as_object().unwrap();

    // Expected tokens and their balances on Dec 5 (last day)
    let expected_tokens = vec![
        ("near", "26.470207505625583899999977"),
        ("intents.near:nep245:v2_1.omni.hot.tg:43114_11111111111111111111", "1514765442315238852"),
        ("intents.near:nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", "9999980"),
        ("intents.near:nep141:btc.omft.near", "544253"),
        ("intents.near:nep141:xrp.omft.near", "16692367"),
        ("intents.near:nep141:eth.omft.near", "35015088429776132"),
        ("intents.near:nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", "22543646"),
        ("intents.near:nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", "124833020"),
        ("intents.near:nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "119000000"),
        ("intents.near:nep141:sol.omft.near", "83424010"),
        ("intents.near:nep141:wrap.near", "800000000000000000000000"),
        ("arizcredits.near", "3"),
    ];

    // Check that all expected tokens are present
    for (token_id, _) in &expected_tokens {
        assert!(
            token_map.contains_key(*token_id),
            "Missing expected token: {}",
            token_id
        );
    }

    // Verify balance values on the last day (Dec 5)
    for (token_id, expected_balance) in &expected_tokens {
        let token_data = token_map.get(*token_id).expect(&format!("Token {} not found", token_id));
        assert!(token_data.is_array(), "Token data should be an array for {}", token_id);

        let snapshots = token_data.as_array().unwrap();
        assert_eq!(snapshots.len(), 5, "Should have 5 daily snapshots for {}", token_id);

        // Check the last day (Dec 5) has the expected balance
        let last_snapshot = &snapshots[4]; // Index 4 = Dec 5
        let balance = last_snapshot.get("balance")
            .and_then(|b| b.as_str())
            .expect(&format!("Balance should be a string for {}", token_id));

        assert_eq!(
            balance, *expected_balance,
            "Balance mismatch for token {} on Dec 5: expected {}, got {}",
            token_id, expected_balance, balance
        );
    }

    println!("✓ Chart API works with webassemblymusic-treasury data");
    println!("✓ All {} expected tokens present with correct balances", expected_tokens.len());
}

/// Test CSV export with webassemblymusic-treasury data
#[tokio::test]
async fn test_csv_export_with_real_data() {
    // Load environment variables
    dotenvy::dotenv().ok();

    // Load test data
    load_test_data().await;

    // Start the server
    let server = TestServer::start().await;
    let client = reqwest::Client::new();

    // Test CSV Export
    let response = client
        .get(server.url("/api/balance-history/csv"))
        .query(&[
            ("account_id", "webassemblymusic-treasury.sputnik-dao.near"),
            ("start_time", "2025-06-01"),
            ("end_time", "2025-12-31"),
        ])
        .send()
        .await
        .expect("Failed to send request");

    assert_eq!(response.status(), 200, "CSV export should return 200");

    // Verify content type
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(
        content_type.starts_with("text/csv"),
        "Content-Type should be text/csv (got: {})",
        content_type
    );

    // Get CSV content
    let csv_content = response.text().await.expect("Failed to read response");

    println!("CSV preview:\n{}", csv_content.lines().take(5).collect::<Vec<_>>().join("\n"));

    // Verify CSV structure
    assert!(
        csv_content.contains("block_height,block_time,token_id"),
        "CSV should have proper headers"
    );

    // Should NOT include SNAPSHOT or NOT_REGISTERED
    assert!(
        !csv_content.contains("SNAPSHOT"),
        "CSV should not include SNAPSHOT records"
    );
    assert!(
        !csv_content.contains("NOT_REGISTERED"),
        "CSV should not include NOT_REGISTERED records"
    );

    // Should have multiple rows
    let row_count = csv_content.lines().count();
    assert!(row_count > 1, "CSV should have header + data rows");

    println!("✓ CSV export works correctly (found {} rows)", row_count);
}

/// Test Chart API with different intervals
#[tokio::test]
async fn test_chart_api_intervals() {
    // Load environment variables
    dotenvy::dotenv().ok();

    // Load test data
    load_test_data().await;

    // Start the server
    let server = TestServer::start().await;
    let client = reqwest::Client::new();

    // Test with different intervals
    for interval in &["hourly", "daily", "weekly", "monthly"] {
        let response = client
            .get(server.url("/api/balance-history/chart"))
            .query(&[
                ("account_id", "webassemblymusic-treasury.sputnik-dao.near"),
                ("start_time", "2025-06-01T00:00:00"),
                ("end_time", "2025-12-31T23:59:59"),
                ("interval", interval),
            ])
            .send()
            .await
            .expect("Failed to send request");

        assert_eq!(
            response.status(),
            200,
            "{} interval should work",
            interval
        );

        let chart_data: serde_json::Value = response
            .json()
            .await
            .expect("Failed to parse JSON response");

        println!("✓ Chart API works with {} interval", interval);
        
        // Verify we got data
        assert!(
            chart_data.is_object() && !chart_data.as_object().unwrap().is_empty(),
            "{} interval should return data",
            interval
        );
    }
}

/// Test that CSV includes token_symbol from counterparties table
#[tokio::test]
async fn test_csv_includes_token_metadata() {
    // Load environment variables
    dotenvy::dotenv().ok();

    // Load test data
    load_test_data().await;

    // Start the server
    let server = TestServer::start().await;
    let client = reqwest::Client::new();

    // Export CSV
    let response = client
        .get(server.url("/api/balance-history/csv"))
        .query(&[
            ("account_id", "webassemblymusic-treasury.sputnik-dao.near"),
            ("start_time", "2025-06-01"),
            ("end_time", "2025-12-31"),
        ])
        .send()
        .await
        .expect("Failed to send request");

    let csv_content = response.text().await.expect("Failed to read response");

    // Verify CSV has token_symbol column
    let header_line = csv_content.lines().next().expect("CSV should have header");
    assert!(
        header_line.contains("token_symbol"),
        "CSV header should include token_symbol column"
    );

    // Check if we have token symbols in the data
    // The counterparties SQL file should have ARIZ token data
    if csv_content.contains("arizcredits.near") {
        assert!(
            csv_content.contains("ARIZ"),
            "CSV should include token symbol for arizcredits.near"
        );
        println!("✓ CSV includes token_symbol metadata");
    } else {
        println!("⚠ No arizcredits.near transactions in date range, skipping symbol check");
    }
}
