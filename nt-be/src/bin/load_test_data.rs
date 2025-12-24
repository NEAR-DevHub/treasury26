use serde_json::Value;
use sqlx::{PgPool, types::BigDecimal};
use std::fs;
use std::str::FromStr;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load environment variables
    dotenvy::dotenv().ok();

    // Connect to database
    let database_url = std::env::var("DATABASE_URL")?;
    println!("Connecting to: {}", database_url);

    let pool = PgPool::connect(&database_url).await?;

    // Run migrations
    sqlx::migrate!("./migrations").run(&pool).await?;

    // Read and parse the JSON file
    let json_str = fs::read_to_string("../test-data/test-webassemblymusic-treasury.json")?;
    let data: Value = serde_json::from_str(&json_str)?;

    let account_id = data["accountId"].as_str().unwrap();
    let transactions = data["transactions"].as_array().unwrap();

    println!(
        "Loading {} transactions for account {}",
        transactions.len(),
        account_id
    );

    // Clean up any existing data for this account
    sqlx::query("DELETE FROM balance_changes WHERE account_id = $1")
        .bind(account_id)
        .execute(&pool)
        .await?;

    let mut total_inserts = 0;

    for tx in transactions {
        let Some(block_height) = tx["block"].as_i64() else {
            continue;
        };
        let Some(timestamp) = tx["timestamp"].as_i64() else {
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

            let actions = serde_json::to_value(&tx["transactions"])?;

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
            .await?;

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

                    let actions = serde_json::to_value(&tx["transactions"])?;

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
                    .await?;

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

                    let actions = serde_json::to_value(&tx["transactions"])?;

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
                    .await?;

                    total_inserts += 1;
                }
            }
        }
    }

    println!("Inserted {} balance changes", total_inserts);
    println!("Done!");

    Ok(())
}
