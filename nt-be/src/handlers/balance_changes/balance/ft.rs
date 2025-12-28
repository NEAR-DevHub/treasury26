//! Fungible Token (NEP-141) Balance Queries
//!
//! Functions to query FT token balances at specific block heights via RPC.
//! Balances are returned as human-readable decimal strings (e.g., "2.5" not "2500000")
//! using token metadata from the counterparties table.

use near_api::{AccountId, NetworkConfig, Reference, Tokens};
use sqlx::PgPool;
use std::str::FromStr;

use crate::handlers::balance_changes::counterparty::{ensure_ft_metadata, convert_raw_to_decimal};

/// Query fungible token balance at a specific block height, converted to human-readable format
///
/// If the RPC returns a 422 error (unprocessable entity), assumes the block doesn't exist
/// and retries with previous blocks (up to 10 attempts).
///
/// The raw balance from the contract is converted to human-readable format using
/// the token's decimals field from the counterparties table.
///
/// # Arguments
/// * `pool` - Database connection pool for querying token metadata
/// * `network` - The NEAR network configuration (use archival network for historical queries)
/// * `account_id` - The NEAR account to query
/// * `token_contract` - The FT contract address
/// * `block_height` - The block height to query at
///
/// # Returns
/// The balance as a human-readable decimal string (e.g., "2.5" for 2.5 tokens)
pub async fn get_balance_at_block(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_contract: &str,
    block_height: u64,
) -> Result<String, Box<dyn std::error::Error>> {
    // Ensure we have token metadata (queries contract if not cached)
    let decimals = ensure_ft_metadata(pool, network, token_contract).await?;
    
    let account_id = AccountId::from_str(account_id)?;
    let token_id = AccountId::from_str(token_contract)?;
    let max_retries = 10;

    for offset in 0..=max_retries {
        let current_block = block_height.saturating_sub(offset);

        match Tokens::account(account_id.clone())
            .ft_balance(token_id.clone())
            .at(Reference::AtBlock(current_block))
            .fetch_from(network)
            .await
        {
            Ok(balance) => {
                if offset > 0 {
                    log::warn!(
                        "Block {} not available for FT {}, used block {} instead (offset: {})",
                        block_height,
                        token_contract,
                        current_block,
                        offset
                    );
                }

                // near-api returns a NearToken type which formats as "X FT"
                // Extract just the numeric part (raw amount in smallest units)
                let balance_str = balance.to_string();
                let raw_balance = balance_str.trim_end_matches(" FT");

                // Convert raw amount to human-readable decimal
                let decimal_balance = convert_raw_to_decimal(raw_balance, decimals)?;

                return Ok(decimal_balance);
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
