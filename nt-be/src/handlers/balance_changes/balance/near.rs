//! NEAR Native Token Balance Queries
//!
//! Functions to query NEAR native token balances at specific block heights via RPC.
//! Balances are returned as human-readable NEAR strings (e.g., "11.1002" not "11100211126630537100000000")
//! using 24 decimals, consistent with FT token decimal conversion.

use near_api::{AccountId, NetworkConfig, Reference, Tokens};
use std::str::FromStr;

use crate::handlers::balance_changes::counterparty::convert_raw_to_decimal;
use crate::handlers::balance_changes::utils::with_transport_retry;

/// Query NEAR native token balance at a specific block height, converted to human-readable format
///
/// Returns an error if the block doesn't exist (UnknownBlock). The caller (binary search)
/// is responsible for skipping non-existing blocks.
///
/// # Arguments
/// * `network` - The NEAR network configuration (use archival network for historical queries)
/// * `account_id` - The NEAR account to query
/// * `block_height` - The block height to query at
///
/// # Returns
/// The balance as a BigDecimal (e.g., "11.1002" for 11.1002 NEAR)
pub async fn get_balance_at_block(
    network: &NetworkConfig,
    account_id: &str,
    block_height: u64,
) -> Result<bigdecimal::BigDecimal, Box<dyn std::error::Error>> {
    let account_id = AccountId::from_str(account_id)?;

    match with_transport_retry("near_balance", || {
        Tokens::account(account_id.clone())
            .near_balance()
            .at(Reference::AtBlock(block_height))
            .fetch_from(network)
    })
    .await
    {
        Ok(balance) => {
            // Convert yoctoNEAR to human-readable NEAR (24 decimals)
            let yocto_near = balance
                .total
                .saturating_sub(balance.storage_locked)
                .as_yoctonear()
                .to_string();
            let decimal_near = convert_raw_to_decimal(&yocto_near, 24)?;

            Ok(decimal_near)
        }
        Err(e) => {
            let err_str = e.to_string();
            // Account doesn't exist at this block - balance is 0
            if err_str.contains("UnknownAccount") {
                tracing::debug!(
                    "Account {} does not exist at block {} - returning balance 0",
                    account_id,
                    block_height
                );
                return Ok(bigdecimal::BigDecimal::from(0));
            }
            Err(e.into())
        }
    }
}
