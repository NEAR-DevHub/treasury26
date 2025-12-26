//! NEAR Native Token Balance Queries
//!
//! Functions to query NEAR native token balances at specific block heights via RPC.

use near_api::{AccountId, Reference, Tokens, NetworkConfig};
use std::str::FromStr;

/// Query NEAR native token balance at a specific block height
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
    
    let balance = Tokens::account(account_id)
        .near_balance()
        .at(Reference::AtBlock(block_height))
        .fetch_from(network)
        .await?;
    
    Ok(balance.total.as_yoctonear().to_string())
}
