//! NEAR Intents Multi-Token Balance Queries
//!
//! Functions to query NEAR Intents multi-token balances at specific block heights via RPC.

use near_api::{Contract, NetworkConfig, Reference, types::Data};
use std::str::FromStr;

/// Query NEAR Intents multi-token balance at a specific block height
///
/// # Arguments
/// * `network` - The NEAR network configuration (use archival network for historical queries)
/// * `account_id` - The NEAR account to query
/// * `token_id` - Full token identifier in format "contract:token_id"
/// * `block_height` - The block height to query at
///
/// # Returns
/// The balance as a string (to handle arbitrary precision)
pub async fn get_balance_at_block(
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    block_height: u64,
) -> Result<String, Box<dyn std::error::Error>> {
    // Parse token_id format: "contract:token_id" (split on first colon only)
    // Example: "intents.near:nep141:btc.omft.near" -> contract="intents.near", token="nep141:btc.omft.near"
    let parts: Vec<&str> = token_id.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid Intents token format: {}", token_id).into());
    }
    let (contract_str, token) = (parts[0], parts[1]);
    
    let contract_id = near_api::types::AccountId::from_str(contract_str)?;
    let contract = Contract(contract_id);
    
    let args = serde_json::json!({
        "account_id": account_id,
        "token_id": token
    });
    
    let balance: Data<String> = contract
        .call_function("mt_balance_of", args)
        .read_only()
        .at(Reference::AtBlock(block_height))
        .fetch_from(network)
        .await?;
    
    Ok(balance.data)
}
