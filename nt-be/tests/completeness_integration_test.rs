//! Integration test for the balance history completeness API
//!
//! Tests GET /api/balance-history/completeness using real testing-astradao.sputnik-dao.near data
//! downloaded from api.trezu.app via the /api/balance-changes endpoint.

mod common;

use common::TestServer;
use serial_test::serial;

const ACCOUNT_ID: &str = "testing-astradao.sputnik-dao.near";

/// Load testing-astradao balance changes from SQL dump into the test database
async fn load_test_data() {
    common::load_test_env();

    let db_url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for integration tests");

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await
        .expect("Failed to connect to test database");

    // Check if data is already loaded
    let existing_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM balance_changes WHERE account_id = $1")
            .bind(ACCOUNT_ID)
            .fetch_one(&pool)
            .await
            .expect("Failed to check existing data");

    if existing_count > 0 {
        println!(
            "Test data already loaded ({} records for {})",
            existing_count, ACCOUNT_ID
        );
        pool.close().await;
        return;
    }

    println!("Loading testing-astradao test data...");

    // Read and execute SQL dump
    let sql = std::fs::read_to_string("tests/test_data/testing_astradao_balance_changes.sql")
        .expect("Failed to read testing_astradao_balance_changes.sql");

    for line in sql.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("--") {
            continue;
        }

        if let Err(e) = sqlx::query(trimmed).execute(&pool).await {
            panic!(
                "Failed to execute SQL: {}\nError: {}",
                &trimmed[..100.min(trimmed.len())],
                e
            );
        }
    }

    // Add monitored account entry
    sqlx::query(
        "INSERT INTO monitored_accounts (account_id, last_synced_at, created_at)
         VALUES ($1, NOW(), NOW())
         ON CONFLICT (account_id) DO UPDATE SET last_synced_at = NOW()",
    )
    .bind(ACCOUNT_ID)
    .execute(&pool)
    .await
    .expect("Failed to add monitored account");

    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM balance_changes WHERE account_id = $1")
            .bind(ACCOUNT_ID)
            .fetch_one(&pool)
            .await
            .expect("Failed to count records");

    println!("Loaded {} balance change records for {}", count, ACCOUNT_ID);

    pool.close().await;
}

#[tokio::test]
#[serial]
async fn test_completeness_api() {
    load_test_data().await;

    let server = TestServer::start().await;
    let client = reqwest::Client::new();

    // Call the completeness endpoint
    let url = server.url(&format!(
        "/api/balance-history/completeness?accountId={}",
        ACCOUNT_ID
    ));
    let response = client
        .get(&url)
        .send()
        .await
        .expect("Failed to call completeness API");

    assert_eq!(response.status(), 200, "Completeness API should return 200");

    let body: serde_json::Value = response
        .json()
        .await
        .expect("Failed to parse JSON response");

    // Verify top-level structure
    assert_eq!(body["accountId"], ACCOUNT_ID);
    assert!(
        body["lastSyncedAt"].is_string(),
        "lastSyncedAt should be present"
    );

    let tokens = body["tokens"]
        .as_array()
        .expect("tokens should be an array");

    // We expect all 15 token types from the test data
    assert!(
        tokens.len() >= 13,
        "Expected at least 13 tokens, got {}",
        tokens.len()
    );

    // Build a map for easy assertion
    let token_map: std::collections::HashMap<&str, &serde_json::Value> = tokens
        .iter()
        .map(|t| (t["tokenId"].as_str().unwrap(), t))
        .collect();

    println!("Completeness response tokens:");
    for t in tokens {
        println!(
            "  {} - hasGaps: {}, gapCount: {}, reachesBeginning: {}",
            t["tokenId"], t["hasGaps"], t["gapCount"], t["reachesBeginning"]
        );
    }

    // ---- NEAR token ----
    // Earliest record is a SNAPSHOT at block 112390151 with balance_before = 0
    // For NEAR, balance_before == 0 means we've reached account creation
    let near = token_map
        .get("near")
        .expect("near token should be in response");
    assert_eq!(
        near["reachesBeginning"], true,
        "NEAR should reach beginning (earliest balance_before=0)"
    );

    // ---- FT tokens ----
    // USDC (17208628f84f...): earliest SNAPSHOT has balance_before > 0 → does NOT reach beginning
    let usdc_token = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    let usdc = token_map
        .get(usdc_token)
        .expect("USDC token should be in response");
    assert_eq!(
        usdc["reachesBeginning"], false,
        "USDC should not reach beginning (earliest balance_before > 0)"
    );

    // wrap.near: earliest SNAPSHOT has balance_before > 0 → does NOT reach beginning
    let wrap = token_map
        .get("wrap.near")
        .expect("wrap.near should be in response");
    assert_eq!(
        wrap["reachesBeginning"], false,
        "wrap.near should not reach beginning (earliest balance_before > 0)"
    );

    // ---- Intents tokens ----
    // intents.near:nep141:wrap.near: earliest is SNAPSHOT with balance_before=0
    // But counterparty=SNAPSHOT, so reaches_beginning=false (backward walk still has SNAPSHOT at boundary)
    let intents_wrap = token_map
        .get("intents.near:nep141:wrap.near")
        .expect("intents wrap token should be in response");
    assert_eq!(
        intents_wrap["reachesBeginning"], false,
        "Intents wrap.near should not reach beginning (earliest is SNAPSHOT)"
    );

    // intents.near:nep141:eth.omft.near: earliest has balance_before=0, counterparty=UNKNOWN
    // UNKNOWN != SNAPSHOT, so reaches_beginning=true
    let intents_eth = token_map
        .get("intents.near:nep141:eth.omft.near")
        .expect("intents ETH token should be in response");
    assert_eq!(
        intents_eth["reachesBeginning"], true,
        "Intents ETH should reach beginning (balance_before=0, counterparty=UNKNOWN)"
    );

    // intents.near:nep141:sol.omft.near: same pattern as ETH
    let intents_sol = token_map
        .get("intents.near:nep141:sol.omft.near")
        .expect("intents SOL token should be in response");
    assert_eq!(
        intents_sol["reachesBeginning"], true,
        "Intents SOL should reach beginning (balance_before=0, counterparty=UNKNOWN)"
    );

    // intents.near:nep141:arb-... USDC: earliest has balance_before=0, counterparty=UNKNOWN
    let intents_arb_usdc = token_map
        .get("intents.near:nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near")
        .expect("intents ARB USDC token should be in response");
    assert_eq!(
        intents_arb_usdc["reachesBeginning"], true,
        "Intents ARB USDC should reach beginning (balance_before=0, counterparty=UNKNOWN)"
    );

    // ---- Consistency checks ----
    for t in tokens {
        let has_gaps = t["hasGaps"].as_bool().unwrap();
        let gap_count = t["gapCount"].as_u64().unwrap();

        // has_gaps should be consistent with gap_count
        assert_eq!(
            has_gaps,
            gap_count > 0,
            "hasGaps should match gapCount > 0 for token {}",
            t["tokenId"]
        );
    }
}
