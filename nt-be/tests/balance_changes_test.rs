mod common;

use common::TestServer;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, types::BigDecimal};
use std::fs;
use std::str::FromStr;

#[derive(Debug, Serialize, Deserialize)]
struct BalanceChange {
    pub id: i64,
    pub account_id: String,
    pub block_height: i64,
    pub block_timestamp: i64,
    pub token_id: String,
    pub counterparty: Option<String>,
    pub amount: serde_json::Value, // Can be string or scientific notation
    pub balance_before: serde_json::Value,
    pub balance_after: serde_json::Value,
    pub actions: Value,
    pub created_at: String,
}

#[tokio::test]
async fn test_load_and_query_balance_changes() {
    // Load environment variables from .env.test
    dotenvy::from_filename(".env.test").ok();

    // Connect to test database
    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
        "postgresql://treasury_test:test_password@localhost:5433/treasury_test_db".to_string()
    });

    println!("Connecting to: {}", database_url);

    let pool = PgPool::connect(&database_url)
        .await
        .expect("Failed to connect to database");

    // Run migrations
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Failed to run migrations");

    // Clean up any existing test data
    sqlx::query("DELETE FROM balance_changes WHERE account_id = $1")
        .bind("webassemblymusic-treasury.sputnik-dao.near")
        .execute(&pool)
        .await
        .expect("Failed to clean up test data");

    // Read and parse the JSON file
    let json_str = fs::read_to_string("../test-data/test-webassemblymusic-treasury.json")
        .expect("Failed to read test JSON file");
    let data: Value = serde_json::from_str(&json_str).expect("Failed to parse JSON");

    let account_id = data["accountId"].as_str().unwrap();
    let transactions = data["transactions"].as_array().unwrap();

    println!(
        "Loading {} transactions for account {}",
        transactions.len(),
        account_id
    );

    let mut total_inserts = 0;

    for tx in transactions {
        let Some(block_height) = tx["block"].as_i64() else {
            eprintln!("Skipping transaction: missing block_height");
            continue;
        };
        let Some(timestamp) = tx["timestamp"].as_i64() else {
            eprintln!("Skipping transaction: missing timestamp");
            continue;
        };
        let balance_before = &tx["balanceBefore"];
        let balance_after = &tx["balanceAfter"];
        let empty_vec = vec![];
        let transfers = tx["transfers"].as_array().unwrap_or(&empty_vec);

        // Process NEAR balance changes
        if tx["changes"]["nearChanged"].as_bool().unwrap_or(false) {
            let near_before =
                BigDecimal::from_str(balance_before["near"].as_str().unwrap_or("0")).unwrap();
            let near_after =
                BigDecimal::from_str(balance_after["near"].as_str().unwrap_or("0")).unwrap();
            let near_diff =
                BigDecimal::from_str(tx["changes"]["nearDiff"].as_str().unwrap_or("0")).unwrap();

            let counterparty = transfers
                .iter()
                .find(|t| t["type"].as_str() != Some("action_receipt_gas_reward"))
                .and_then(|t| t["counterparty"].as_str())
                .unwrap_or("unknown");

            let actions = serde_json::to_value(&tx["transactions"]).unwrap();

            sqlx::query(
                r#"
                INSERT INTO balance_changes 
                (account_id, block_height, block_timestamp, token_id, counterparty, amount, balance_before, balance_after, actions)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                "#,
            )
            .bind(account_id)
            .bind(block_height)
            .bind(timestamp)
            .bind("near")
            .bind(counterparty)
            .bind(&near_diff)
            .bind(&near_before)
            .bind(&near_after)
            .bind(&actions)
            .execute(&pool)
            .await
            .expect("Failed to insert NEAR balance change");

            total_inserts += 1;
        }

        // Process fungible token changes
        if let Some(tokens_changed) = tx["changes"]["tokensChanged"].as_object() {
            for (token_id, token_data) in tokens_changed {
                if token_data["changed"].as_bool().unwrap_or(false) {
                    let token_before = BigDecimal::from_str(
                        balance_before["fungibleTokens"][token_id]
                            .as_str()
                            .unwrap_or("0"),
                    )
                    .unwrap();
                    let token_after = BigDecimal::from_str(
                        balance_after["fungibleTokens"][token_id]
                            .as_str()
                            .unwrap_or("0"),
                    )
                    .unwrap();
                    let token_diff =
                        BigDecimal::from_str(token_data["diff"].as_str().unwrap_or("0")).unwrap();

                    let counterparty = transfers
                        .iter()
                        .find(|t| t["tokenId"].as_str() == Some(token_id))
                        .and_then(|t| t["counterparty"].as_str())
                        .unwrap_or("unknown");

                    let actions = serde_json::to_value(&tx["transactions"]).unwrap();

                    sqlx::query(
                        r#"
                        INSERT INTO balance_changes 
                        (account_id, block_height, block_timestamp, token_id, counterparty, amount, balance_before, balance_after, actions)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        "#,
                    )
                    .bind(account_id)
                    .bind(block_height)
                    .bind(timestamp)
                    .bind(token_id)
                    .bind(counterparty)
                    .bind(&token_diff)
                    .bind(&token_before)
                    .bind(&token_after)
                    .bind(&actions)
                    .execute(&pool)
                    .await
                    .expect("Failed to insert fungible token balance change");

                    total_inserts += 1;
                }
            }
        }

        // Process intents token changes
        if let Some(intents_changed) = tx["changes"]["intentsChanged"].as_object() {
            for (token_id, token_data) in intents_changed {
                if token_data["changed"].as_bool().unwrap_or(false) {
                    let token_before = BigDecimal::from_str(
                        balance_before["intentsTokens"][token_id]
                            .as_str()
                            .unwrap_or("0"),
                    )
                    .unwrap();
                    let token_after = BigDecimal::from_str(
                        balance_after["intentsTokens"][token_id]
                            .as_str()
                            .unwrap_or("0"),
                    )
                    .unwrap();
                    let token_diff =
                        BigDecimal::from_str(token_data["diff"].as_str().unwrap_or("0")).unwrap();

                    let counterparty = transfers
                        .iter()
                        .find(|t| {
                            let intent_id =
                                format!("nep141:{}", t["tokenId"].as_str().unwrap_or(""));
                            intent_id == *token_id
                                || t["tokenId"].as_str() == Some(token_id.as_str())
                        })
                        .and_then(|t| t["counterparty"].as_str())
                        .unwrap_or("unknown");

                    let actions = serde_json::to_value(&tx["transactions"]).unwrap();

                    sqlx::query(
                        r#"
                        INSERT INTO balance_changes 
                        (account_id, block_height, block_timestamp, token_id, counterparty, amount, balance_before, balance_after, actions)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        "#,
                    )
                    .bind(account_id)
                    .bind(block_height)
                    .bind(timestamp)
                    .bind(token_id)
                    .bind(counterparty)
                    .bind(&token_diff)
                    .bind(&token_before)
                    .bind(&token_after)
                    .bind(&actions)
                    .execute(&pool)
                    .await
                    .expect("Failed to insert intents token balance change");

                    total_inserts += 1;
                }
            }
        }
    }

    println!("Inserted {} balance changes", total_inserts);

    // Start the server
    println!("\nStarting server...");
    let server = TestServer::start().await;

    // Test the API endpoint
    let client = reqwest::Client::new();

    // Test 1: Query all balance changes with limit
    println!("\nTest 1: Query all balance changes");
    let response = client
        .get(server.url(&format!(
            "/api/balance-changes?account_id={}&limit=10",
            account_id
        )))
        .send()
        .await
        .expect("Failed to query balance changes");

    assert_eq!(response.status(), 200);
    let changes: Vec<BalanceChange> = response.json().await.expect("Failed to parse response");
    println!("  Retrieved {} balance changes", changes.len());
    assert!(changes.len() > 0, "Should have balance changes");
    assert!(changes.len() <= 10, "Should respect limit");

    // Test 2: Query with token filter
    println!("\nTest 2: Query NEAR token only");
    let response = client
        .get(server.url(&format!(
            "/api/balance-changes?account_id={}&token_id=near&limit=5",
            account_id
        )))
        .send()
        .await
        .expect("Failed to query NEAR balance changes");

    assert_eq!(response.status(), 200);
    let near_changes: Vec<BalanceChange> = response.json().await.expect("Failed to parse response");
    println!("  Retrieved {} NEAR balance changes", near_changes.len());
    assert!(near_changes.len() > 0, "Should have NEAR balance changes");

    // Verify all results are NEAR token
    for change in &near_changes {
        assert_eq!(change.token_id, "near", "All results should be NEAR token");
    }

    // Test 3: Query with pagination
    println!("\nTest 3: Test pagination");
    let response1 = client
        .get(server.url(&format!(
            "/api/balance-changes?account_id={}&limit=2&offset=0",
            account_id
        )))
        .send()
        .await
        .expect("Failed to query first page");

    let response2 = client
        .get(server.url(&format!(
            "/api/balance-changes?account_id={}&limit=2&offset=2",
            account_id
        )))
        .send()
        .await
        .expect("Failed to query second page");

    let page1: Vec<BalanceChange> = response1.json().await.expect("Failed to parse page 1");
    let page2: Vec<BalanceChange> = response2.json().await.expect("Failed to parse page 2");

    println!("  Page 1: {} records", page1.len());
    println!("  Page 2: {} records", page2.len());

    // Pages should have different records
    if !page1.is_empty() && !page2.is_empty() {
        assert_ne!(
            page1[0].id, page2[0].id,
            "Different pages should have different records"
        );
    }

    // Test 4: Verify response structure
    println!("\nTest 4: Verify response structure");
    if let Some(change) = changes.first() {
        println!("  Sample record:");
        println!("    ID: {}", change.id);
        println!("    Account: {}", change.account_id);
        println!("    Block: {}", change.block_height);
        println!("    Token: {}", change.token_id);
        println!("    Amount: {}", change.amount);

        assert_eq!(change.account_id, account_id);
        assert!(change.block_height > 0);
        assert!(!change.token_id.is_empty());
    }

    // Clean up
    sqlx::query("DELETE FROM balance_changes WHERE account_id = $1")
        .bind(account_id)
        .execute(&pool)
        .await
        .expect("Failed to clean up test data");

    println!("\n✅ All API tests passed!");
}
