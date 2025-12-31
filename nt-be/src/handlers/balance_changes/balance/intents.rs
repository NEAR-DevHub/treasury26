//! NEAR Intents Multi-Token Balance Queries
//!
//! Functions to query NEAR Intents multi-token balances at specific block heights via RPC.

use near_api::{Contract, NetworkConfig, Reference};
use sqlx::PgPool;
use std::str::FromStr;

use crate::handlers::balance_changes::counterparty::ensure_ft_metadata;

/// Query NEAR Intents multi-token balance at a specific block height
///
/// If the RPC returns a 422 error (unprocessable entity), assumes the block doesn't exist
/// and retries with previous blocks (up to 10 attempts).
///
/// Also ensures FT metadata for the underlying token is cached in the counterparties table.
///
/// # Arguments
/// * `pool` - Database connection pool for storing/retrieving token metadata
/// * `network` - The NEAR network configuration (use archival network for historical queries)
/// * `account_id` - The NEAR account to query
/// * `token_id` - Full token identifier in format "contract:token_id"
/// * `block_height` - The block height to query at
///
/// # Returns
/// The balance as a string (to handle arbitrary precision)
pub async fn get_balance_at_block(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    block_height: u64,
) -> Result<String, Box<dyn std::error::Error>> {
    // Ensure FT metadata is cached for this intents token
    // This will extract the actual FT contract and query its metadata
    let _ = ensure_ft_metadata(pool, network, token_id).await?;
    // Parse token_id format: "contract:token_id" (split on first colon only)
    // Example: "intents.near:nep141:btc.omft.near" -> contract="intents.near", token="nep141:btc.omft.near"
    let parts: Vec<&str> = token_id.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid Intents token format: {}", token_id).into());
    }
    let (contract_str, token) = (parts[0], parts[1]);

    let contract_id = near_api::types::AccountId::from_str(contract_str)?;
    let contract = Contract(contract_id);
    let max_retries = 10;

    for offset in 0..=max_retries {
        let current_block = block_height.saturating_sub(offset);

        let args = serde_json::json!({
            "account_id": account_id,
            "token_id": token
        });

        match contract
            .call_function("mt_balance_of", args)
            .read_only()
            .at(Reference::AtBlock(current_block))
            .fetch_from(network)
            .await
        {
            Ok(balance) => {
                if offset > 0 {
                    log::warn!(
                        "Block {} not available for Intents token {}, used block {} instead (offset: {})",
                        block_height,
                        token_id,
                        current_block,
                        offset
                    );
                }
                return Ok(balance.data);
            }
            Err(e) => {
                let err_str = e.to_string();
                // Check if this is a 422 error (unprocessable entity) or block not found error
                if err_str.contains("422") || err_str.contains("UnknownBlock") {
                    if offset < max_retries {
                        log::debug!(
                            "Block {} not available for Intents token {} ({}), trying previous block",
                            current_block,
                            token_id,
                            err_str
                        );
                        continue;
                    } else {
                        return Err(format!(
                            "Failed to query Intents balance after {} retries: {}",
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
        "Failed to query Intents balance for block {} after {} attempts",
        block_height,
        max_retries + 1
    )
    .into())
}
