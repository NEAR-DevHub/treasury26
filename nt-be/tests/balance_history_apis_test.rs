//! Integration tests for balance history APIs
//!
//! Tests both the Chart API and CSV Export API endpoints using real webassemblymusic-treasury data

mod common;

use common::TestServer;
use serial_test::serial;

/// Load webassemblymusic-treasury test data from SQL dump files
async fn load_test_data() {
    // Load environment variables - .env.test overrides DATABASE_URL to test database
    dotenvy::from_filename(".env").ok();
    dotenvy::from_filename(".env.test").ok();

    let db_url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");

    // Connect to database
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await
        .expect("Failed to connect to test database");

    // Check if data is already loaded
    let existing_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM balance_changes 
         WHERE account_id = 'webassemblymusic-treasury.sputnik-dao.near'",
    )
    .fetch_one(&pool)
    .await
    .expect("Failed to check existing data");

    if existing_count > 0 {
        println!(
            "✓ Test data already loaded ({} records), skipping load",
            existing_count
        );
        pool.close().await;
        return;
    }

    println!("Loading webassemblymusic-treasury test data...");

    // Clear any partial data from failed previous runs
    sqlx::query("DELETE FROM balance_changes WHERE account_id = 'webassemblymusic-treasury.sputnik-dao.near'")
        .execute(&pool)
        .await
        .expect("Failed to clear existing test data");

    // Read and execute counterparties SQL
    let counterparties_sql =
        std::fs::read_to_string("tests/test_data/webassemblymusic_counterparties.sql")
            .expect("Failed to read counterparties SQL file");

    // Execute SQL line by line (skipping comments, SET commands, and pg_dump v18 commands)
    for line in counterparties_sql.lines() {
        let trimmed = line.trim();
        // Skip comments, empty lines, SET commands, SELECT commands, and pg_dump v18 security commands
        if trimmed.is_empty()
            || trimmed.starts_with("--")
            || trimmed.to_uppercase().starts_with("SET ")
            || trimmed.to_uppercase().starts_with("SELECT ")
            || trimmed.starts_with("\\restrict")
            || trimmed.starts_with("\\unrestrict")
        {
            continue;
        }

        // Execute the statement, adding ON CONFLICT to handle concurrent test runs
        let sql = if line.to_uppercase().starts_with("INSERT INTO") {
            // Add ON CONFLICT clause to INSERT statements for counterparties
            // Replace the final ); with ON CONFLICT clause
            let trimmed = line.trim_end();
            if trimmed.ends_with(");") {
                format!(
                    "{} ON CONFLICT (account_id) DO NOTHING;",
                    &trimmed[..trimmed.len() - 2]
                )
            } else {
                line.to_string()
            }
        } else {
            line.to_string()
        };

        if let Err(e) = sqlx::query(&sql).execute(&pool).await {
            panic!(
                "Failed to execute SQL: {}\nError: {}",
                &sql[..100.min(sql.len())],
                e
            );
        }
    }

    // Read and execute balance changes SQL (line by line)
    let balance_changes_sql =
        std::fs::read_to_string("tests/test_data/webassemblymusic_balance_changes.sql")
            .expect("Failed to read balance changes SQL file");

    for statement in balance_changes_sql.lines() {
        let trimmed = statement.trim();
        // Skip comments, empty lines, SET commands, SELECT commands, and pg_dump v18 security commands
        if trimmed.is_empty()
            || trimmed.starts_with("--")
            || trimmed.to_uppercase().starts_with("SET ")
            || trimmed.to_uppercase().starts_with("SELECT ")
            || trimmed.starts_with("\\restrict")
            || trimmed.starts_with("\\unrestrict")
        {
            continue;
        }

        sqlx::query(statement)
            .execute(&pool)
            .await
            .expect("Failed to load balance change");
    }

    // Add monitored account
    sqlx::query(
        "INSERT INTO monitored_accounts (account_id, created_at)
         VALUES ('webassemblymusic-treasury.sputnik-dao.near', NOW())
         ON CONFLICT (account_id) DO NOTHING",
    )
    .execute(&pool)
    .await
    .expect("Failed to add monitored account");

    // Show summary
    let balance_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM balance_changes 
         WHERE account_id = 'webassemblymusic-treasury.sputnik-dao.near'",
    )
    .fetch_one(&pool)
    .await
    .expect("Failed to count balance changes");

    println!("✓ Loaded {} balance change records", balance_count);

    pool.close().await;
}

/// Test the chart API with webassemblymusic-treasury data
#[tokio::test]
#[serial]
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
        status, 200,
        "Chart API should return 200. Status: {}, Body: {}",
        status, body_text
    );

    let chart_data: serde_json::Value =
        serde_json::from_str(&body_text).expect("Failed to parse JSON response");

    println!(
        "Chart data: {}",
        serde_json::to_string_pretty(&chart_data).unwrap()
    );

    // Verify response structure - should be grouped by token
    assert!(chart_data.is_object(), "Response should be an object");

    let token_map = chart_data.as_object().unwrap();

    // Expected tokens and their balances on Dec 5 (last day of the test range)
    // Values are decimal-formatted strings from the API
    let expected_tokens = vec![
        ("near", "26.470207505625583899999977"),
        (
            "intents.near:nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
            "9.99998",
        ),
        ("intents.near:nep141:btc.omft.near", "0.00544253"),
        ("intents.near:nep141:xrp.omft.near", "16.692367"),
        ("intents.near:nep141:eth.omft.near", "0.035015088429776132"),
        (
            "intents.near:nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
            "22.543646",
        ),
        (
            "intents.near:nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
            "124.83302",
        ),
        (
            "intents.near:nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
            "119",
        ),
        ("intents.near:nep141:sol.omft.near", "0.08342401"),
        ("intents.near:nep141:wrap.near", "0.8"),
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
        let token_data = token_map
            .get(*token_id)
            .expect(&format!("Token {} not found", token_id));
        assert!(
            token_data.is_array(),
            "Token data should be an array for {}",
            token_id
        );

        let snapshots = token_data.as_array().unwrap();
        assert_eq!(
            snapshots.len(),
            5,
            "Should have 5 daily snapshots for {}",
            token_id
        );

        // Check the last day (Dec 5) has the expected balance
        let last_snapshot = &snapshots[4]; // Index 4 = Dec 5
        let balance = last_snapshot
            .get("balance")
            .and_then(|b| b.as_str())
            .expect(&format!("Balance should be a string for {}", token_id));

        assert_eq!(
            balance, *expected_balance,
            "Balance mismatch for token {} on Dec 5: expected {}, got {}",
            token_id, expected_balance, balance
        );
    }

    println!("✓ Chart API works with webassemblymusic-treasury data");
    println!(
        "✓ All {} expected tokens present with correct balances",
        expected_tokens.len()
    );
}

/// Test CSV export with webassemblymusic-treasury data
#[tokio::test]
#[serial]
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

    let snapshot_path = "tests/test_data/snapshots/csv_export_snapshot.csv";

    // Generate new snapshots if environment variable is set
    if std::env::var("GENERATE_NEW_TEST_SNAPSHOTS").is_ok() {
        std::fs::create_dir_all("tests/test_data/snapshots")
            .expect("Failed to create snapshots directory");
        std::fs::write(snapshot_path, &csv_content).expect("Failed to write CSV snapshot");
        println!("✓ CSV snapshot saved to {}", snapshot_path);
    }

    println!(
        "CSV preview:\n{}",
        csv_content.lines().take(5).collect::<Vec<_>>().join("\n")
    );

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

    // Exact row count (1 header + 172 data rows = 173 total)
    let row_count = csv_content.lines().count();
    assert_eq!(
        row_count, 173,
        "CSV should have exactly 173 rows (1 header + 172 data rows)"
    );

    // Compare with snapshot (hard assertion for regression testing)
    let snapshot_content = std::fs::read_to_string(snapshot_path).expect(&format!(
        "Failed to read snapshot file: {}\n\
         To generate new snapshots, run: GENERATE_NEW_TEST_SNAPSHOTS=1 cargo test",
        snapshot_path
    ));

    assert_eq!(
        csv_content, snapshot_content,
        "CSV output does not match snapshot!\n\
         If this change is expected, regenerate snapshots with:\n\
         GENERATE_NEW_TEST_SNAPSHOTS=1 cargo test --test balance_history_apis_test"
    );

    println!("✓ CSV export works correctly (found {} rows)", row_count);
}

/// Test Chart API with different intervals
#[tokio::test]
#[serial]
async fn test_chart_api_intervals() {
    // Load environment variables
    dotenvy::dotenv().ok();

    // Load test data
    load_test_data().await;

    // Start the server
    let server = TestServer::start().await;
    let client = reqwest::Client::new();

    let generate_snapshots = std::env::var("GENERATE_NEW_TEST_SNAPSHOTS").is_ok();

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

        assert_eq!(response.status(), 200, "{} interval should work", interval);

        let chart_data: serde_json::Value = response
            .json()
            .await
            .expect("Failed to parse JSON response");

        // Verify we got data
        assert!(
            chart_data.is_object() && !chart_data.as_object().unwrap().is_empty(),
            "{} interval should return data",
            interval
        );

        let snapshot_path = format!("tests/test_data/snapshots/chart_{}_snapshot.json", interval);

        // Generate new snapshots if environment variable is set
        if generate_snapshots {
            std::fs::create_dir_all("tests/test_data/snapshots")
                .expect("Failed to create snapshots directory");
            let snapshot_content =
                serde_json::to_string_pretty(&chart_data).expect("Failed to serialize JSON");
            std::fs::write(&snapshot_path, &snapshot_content)
                .expect("Failed to write snapshot file");
            println!("✓ Snapshot saved to {}", snapshot_path);
        }

        // Compare with snapshot (hard assertion for regression testing)
        let existing_snapshot = std::fs::read_to_string(&snapshot_path).expect(&format!(
            "Failed to read snapshot file: {}\n\
             To generate new snapshots, run: GENERATE_NEW_TEST_SNAPSHOTS=1 cargo test",
            snapshot_path
        ));

        let expected_data: serde_json::Value =
            serde_json::from_str(&existing_snapshot).expect("Failed to parse snapshot");

        // Compare token counts
        let current_tokens = chart_data.as_object().unwrap().len();
        let expected_tokens = expected_data.as_object().unwrap().len();
        assert_eq!(
            current_tokens, expected_tokens,
            "{} interval: token count mismatch (expected {}, got {})\n\
             To regenerate snapshots: GENERATE_NEW_TEST_SNAPSHOTS=1 cargo test --test balance_history_apis_test",
            interval, expected_tokens, current_tokens
        );

        // Compare data point counts for each token
        for (token_id, snapshots) in chart_data.as_object().unwrap() {
            let current_snapshots = snapshots.as_array().unwrap().len();
            let expected_snapshots = expected_data
                .get(token_id)
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);

            assert_eq!(
                current_snapshots, expected_snapshots,
                "{} interval, token {}: snapshot count mismatch (expected {}, got {})\n\
                 To regenerate snapshots: GENERATE_NEW_TEST_SNAPSHOTS=1 cargo test --test balance_history_apis_test",
                interval, token_id, expected_snapshots, current_snapshots
            );
        }

        println!("✓ Chart API works with {} interval", interval);
    }
}
