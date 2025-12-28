//! Fungible Token (NEP-141) Balance Queries
//!
//! Functions to query FT token balances at specific block heights via RPC.
//! Returns the raw U128 balance value directly from ft_balance_of contract method.

use near_api::{AccountId, Contract, NetworkConfig, Reference};
use sqlx::PgPool;
use std::str::FromStr;

use crate::handlers::balance_changes::counterparty::ensure_ft_metadata;

/// Query fungible token balance at a specific block height
///
/// If the RPC returns a 422 error (unprocessable entity), assumes the block doesn't exist
/// and retries with previous blocks (up to 10 attempts).
///
/// Calls ft_balance_of directly on the contract to get the raw U128 value without any
/// conversion or rounding. Also ensures metadata is cached in counterparties table.
///
/// # Arguments
/// * `pool` - Database connection pool for storing/retrieving token metadata
/// * `network` - The NEAR network configuration (use archival network for historical queries)
/// * `account_id` - The NEAR account to query
/// * `token_contract` - The FT contract address
/// * `block_height` - The block height to query at
///
/// # Returns
/// The raw balance as a U128 string (e.g., "2500000" for 2.5 tokens with 6 decimals)
pub async fn get_balance_at_block(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_contract: &str,
    block_height: u64,
) -> Result<String, Box<dyn std::error::Error>> {
    // Ensure metadata is cached (for future UI display needs)
    let _decimals = ensure_ft_metadata(pool, network, token_contract).await?;
    
    let token_contract_obj = AccountId::from_str(token_contract)?;
    let max_retries = 10;

    for offset in 0..=max_retries {
        let current_block = block_height.saturating_sub(offset);

        // Call ft_balance_of directly to get raw U128 value without conversion
        let contract = Contract(token_contract_obj.clone());
        let result: Result<near_api::Data<serde_json::Value>, _> = contract
            .call_function(
                "ft_balance_of",
                serde_json::json!({
                    "account_id": account_id
                }),
            )
            .read_only()
            .at(Reference::AtBlock(current_block))
            .fetch_from(network)
            .await;

        match result {
            Ok(data) => {
                if offset > 0 {
                    log::warn!(
                        "Block {} not available for FT {}, used block {} instead (offset: {})",
                        block_height,
                        token_contract,
                        current_block,
                        offset
                    );
                }

                // Parse the raw U128 value from the contract response
                // NEP-141 ft_balance_of returns a U128 which can be either a string or number in JSON
                // Example: 2500000 for 2.5 ARIZ with 6 decimals
                let raw_balance = match &data.data {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Number(n) => n.to_string(),
                    _ => return Err(format!("Unexpected ft_balance_of response type: {:?}", data.data).into()),
                };
                
                // Assert: The value should be a valid U128 (digits only, no decimals)
                assert!(
                    raw_balance.chars().all(|c| c.is_ascii_digit()),
                    "ft_balance_of must return a U128 value, got: {}",
                    raw_balance
                );

                return Ok(raw_balance);
            }
            Err(e) => {
                let err_str = e.to_string();
                // Check if this is a 422 error (unprocessable entity) or block not found error
                if err_str.contains("422") || err_str.contains("UnknownBlock") {
                    if offset < max_retries {
                        log::debug!(
                            "Block {} not available for FT {} ({}), trying previous block",
                            current_block,
                            token_contract,
                            err_str
                        );
                        continue;
                    } else {
                        return Err(format!(
                            "Failed to query FT balance after {} retries: {}",
                            max_retries, err_str
                        )
                        .into());
                    }
                } else {
                    // For other errors, fail immediately
                    return Err(e.into());
                }
            }
        }
    }

    Err(format!(
        "Failed to query FT balance for block {} after {} attempts",
        block_height,
        max_retries + 1
    )
    .into())
}
