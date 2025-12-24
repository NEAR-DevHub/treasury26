use serde_json::Value;
use std::fs;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load environment variables
    dotenvy::dotenv().ok();

    // Read the JSON file
    let json_str = fs::read_to_string("../test-data/test-webassemblymusic-treasury.json")?;
    let data: Value = serde_json::from_str(&json_str)?;

    let account_id = data["accountId"].as_str().unwrap();
    let transactions = data["transactions"].as_array().unwrap();

    println!(
        "-- Converting {} transactions for account {}",
        transactions.len(),
        account_id
    );
    println!("BEGIN;");
    println!();

    for tx in transactions {
        let block_height = tx["block"].as_i64().unwrap();
        let timestamp = tx["timestamp"].as_i64().unwrap();
        let balance_before = &tx["balanceBefore"];
        let balance_after = &tx["balanceAfter"];
        let empty_vec = vec![];
        let transfers = tx["transfers"].as_array().unwrap_or(&empty_vec);

        // Process NEAR balance changes
        if tx["changes"]["nearChanged"].as_bool().unwrap_or(false) {
            let near_before = balance_before["near"].as_str().unwrap_or("0");
            let near_after = balance_after["near"].as_str().unwrap_or("0");
            let near_diff = tx["changes"]["nearDiff"].as_str().unwrap_or("0");

            // Get counterparty from transfers if available
            let counterparty = transfers
                .iter()
                .find(|t| t["type"].as_str() != Some("action_receipt_gas_reward"))
                .and_then(|t| t["counterparty"].as_str())
                .unwrap_or("unknown");

            let actions = serde_json::to_string(&tx["transactions"]).unwrap();

            println!(
                "INSERT INTO balance_changes (account_id, block_height, block_timestamp, token_id, counterparty, amount, balance_before, balance_after, actions)"
            );
            println!(
                "VALUES ('{}', {}, {}, 'near', '{}', '{}', '{}', '{}', '{}');",
                account_id,
                block_height,
                timestamp,
                counterparty,
                near_diff,
                near_before,
                near_after,
                actions.replace("'", "''")
            );
            println!();
        }

        // Process fungible token changes
        if let Some(tokens_changed) = tx["changes"]["tokensChanged"].as_object() {
            for (token_id, token_data) in tokens_changed {
                if token_data["changed"].as_bool().unwrap_or(false) {
                    let token_before = balance_before["fungibleTokens"][token_id]
                        .as_str()
                        .unwrap_or("0");
                    let token_after = balance_after["fungibleTokens"][token_id]
                        .as_str()
                        .unwrap_or("0");
                    let token_diff = token_data["diff"].as_str().unwrap_or("0");

                    let counterparty = transfers
                        .iter()
                        .find(|t| t["tokenId"].as_str() == Some(token_id))
                        .and_then(|t| t["counterparty"].as_str())
                        .unwrap_or("unknown");

                    let actions = serde_json::to_string(&tx["transactions"]).unwrap();

                    println!(
                        "INSERT INTO balance_changes (account_id, block_height, block_timestamp, token_id, counterparty, amount, balance_before, balance_after, actions)"
                    );
                    println!(
                        "VALUES ('{}', {}, {}, '{}', '{}', '{}', '{}', '{}', '{}');",
                        account_id,
                        block_height,
                        timestamp,
                        token_id,
                        counterparty,
                        token_diff,
                        token_before,
                        token_after,
                        actions.replace("'", "''")
                    );
                    println!();
                }
            }
        }

        // Process intents token changes
        if let Some(intents_changed) = tx["changes"]["intentsChanged"].as_object() {
            for (token_id, token_data) in intents_changed {
                if token_data["changed"].as_bool().unwrap_or(false) {
                    let token_before = balance_before["intentsTokens"][token_id]
                        .as_str()
                        .unwrap_or("0");
                    let token_after = balance_after["intentsTokens"][token_id]
                        .as_str()
                        .unwrap_or("0");
                    let token_diff = token_data["diff"].as_str().unwrap_or("0");

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

                    let actions = serde_json::to_string(&tx["transactions"]).unwrap();

                    println!(
                        "INSERT INTO balance_changes (account_id, block_height, block_timestamp, token_id, counterparty, amount, balance_before, balance_after, actions)"
                    );
                    println!(
                        "VALUES ('{}', {}, {}, '{}', '{}', '{}', '{}', '{}', '{}');",
                        account_id,
                        block_height,
                        timestamp,
                        token_id,
                        counterparty,
                        token_diff,
                        token_before,
                        token_after,
                        actions.replace("'", "''")
                    );
                    println!();
                }
            }
        }
    }

    println!("COMMIT;");
    println!();
    println!("-- Conversion complete");

    Ok(())
}
