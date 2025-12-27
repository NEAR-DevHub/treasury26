//! Fungible Token (NEP-141) Balance Queries
//!
//! Functions to query FT token balances at specific block heights via RPC.

use near_api::{AccountId, NetworkConfig, Reference, Tokens};
use std::str::FromStr;

/// Query fungible token balance at a specific block height
///
/// If the RPC returns a 422 error (unprocessable entity), assumes the block doesn't exist
/// and retries with previous blocks (up to 10 attempts).
///
/// # Arguments
/// * `network` - The NEAR network configuration (use archival network for historical queries)
/// * `account_id` - The NEAR account to query
/// * `token_contract` - The FT contract address
/// * `block_height` - The block height to query at
///
/// # Returns
/// The balance as a string (to handle arbitrary precision)
pub async fn get_balance_at_block(
    network: &NetworkConfig,
    account_id: &str,
    token_contract: &str,
    block_height: u64,
) -> Result<String, Box<dyn std::error::Error>> {
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
                // Extract just the numeric part for consistency with other balance types
                let balance_str = balance.to_string();
                let numeric_balance = balance_str.trim_end_matches(" FT").to_string();

                return Ok(numeric_balance);
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
