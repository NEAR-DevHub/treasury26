//! NEAR Native Token Balance Queries
//!
//! Functions to query NEAR native token balances at specific block heights via RPC.

use near_api::{AccountId, NetworkConfig, Reference, Tokens};
use std::str::FromStr;

/// Query NEAR native token balance at a specific block height
///
/// If the RPC returns a 422 error (unprocessable entity), assumes the block doesn't exist
/// and retries with previous blocks (up to 10 attempts).
///
/// # Arguments
/// * `network` - The NEAR network configuration (use archival network for historical queries)
/// * `account_id` - The NEAR account to query
/// * `block_height` - The block height to query at
///
/// # Returns
/// The balance as a string (to handle arbitrary precision)
pub async fn get_balance_at_block(
    network: &NetworkConfig,
    account_id: &str,
    block_height: u64,
) -> Result<String, Box<dyn std::error::Error>> {
    let account_id = AccountId::from_str(account_id)?;
    let max_retries = 10;

    for offset in 0..=max_retries {
        let current_block = block_height.saturating_sub(offset);

        match Tokens::account(account_id.clone())
            .near_balance()
            .at(Reference::AtBlock(current_block))
            .fetch_from(network)
            .await
        {
            Ok(balance) => {
                if offset > 0 {
                    log::warn!(
                        "Block {} not available, used block {} instead (offset: {})",
                        block_height,
                        current_block,
                        offset
                    );
                }
                return Ok(balance.total.as_yoctonear().to_string());
            }
            Err(e) => {
                let err_str = e.to_string();
                // Check if this is a 422 error (unprocessable entity) or block not found error
                if err_str.contains("422") || err_str.contains("UnknownBlock") {
                    if offset < max_retries {
                        log::debug!(
                            "Block {} not available ({}), trying previous block",
                            current_block,
                            err_str
                        );
                        continue;
                    } else {
                        return Err(format!(
                            "Failed to query balance after {} retries: {}",
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
        "Failed to query balance for block {} after {} attempts",
        block_height,
        max_retries + 1
    )
    .into())
}
