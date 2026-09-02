//! NEAR Intents Multi-Token Balance Queries
//!
//! Functions to query NEAR Intents multi-token balances at specific block heights via RPC.

use near_api::{Contract, NetworkConfig, Reference};
use sqlx::PgPool;
use std::str::FromStr;

use crate::handlers::balance_changes::counterparty::{
    convert_raw_to_decimal, ensure_ft_metadata, ensure_nep245_token_decimals,
};
use crate::handlers::balance_changes::utils::with_transport_retry;

fn parse_nep245_asset_id(token_id: &str) -> Result<(&str, &str), String> {
    let contract_and_token = token_id.strip_prefix("nep245:").unwrap_or(token_id);
    let Some((contract, token)) = contract_and_token.split_once(':') else {
        return Err(format!("Invalid NEP-245 token format: {token_id}"));
    };
    if contract.is_empty() || token.is_empty() {
        return Err(format!("Invalid NEP-245 token format: {token_id}"));
    }
    Ok((contract, token))
}

/// Resolve decimals for a NEAR Intents multi-token.
/// - intents.near tokens: use the token registry via ensure_ft_metadata (full token_id as key)
/// - Other NEP-245 contracts (e.g. v2_1.omni.hot.tg): query mt_metadata_base_by_token_id
pub async fn resolve_decimals(
    pool: &PgPool,
    network: &NetworkConfig,
    token_id: &str,
) -> Result<u8, Box<dyn std::error::Error>> {
    let (contract_str, token) = parse_nep245_asset_id(token_id)
        .map_err(|message| -> Box<dyn std::error::Error> { message.into() })?;

    if contract_str == "intents.near" {
        let registry_result = ensure_ft_metadata(pool, network, token_id)
            .await
            .map_err(|error| error.to_string());
        match registry_result {
            Ok(decimals) => Ok(decimals),
            Err(registry_error_message) => {
                // Owner discovery is authoritative and may surface a valid
                // Intents asset before the bundled registry is updated. Fall
                // back to the contract's NEP-245 metadata instead of making
                // that one new asset block the DAO snapshot generation.
                tracing::warn!(
                    token_id,
                    error = %registry_error_message,
                    "intents token missing from static registry; using on-chain MT metadata"
                );
                Ok(
                    ensure_nep245_token_decimals(pool, network, token_id, contract_str, token)
                        .await?,
                )
            }
        }
    } else {
        Ok(ensure_nep245_token_decimals(pool, network, token_id, contract_str, token).await?)
    }
}

/// Query NEAR Intents multi-token balance at a specific block height
///
/// Returns an error if the block doesn't exist (UnknownBlock). The caller (binary search)
/// is responsible for skipping non-existing blocks.
///
/// Also ensures FT metadata for the underlying token is cached in the counterparties table.
///
/// # Arguments
/// * `pool` - Database connection pool for storing/retrieving token metadata
/// * `network` - The NEAR network configuration (use archival network for historical queries)
/// * `account_id` - The NEAR account to query
/// * `token_id` - Full token identifier in either `contract:token_id` or
///   canonical `nep245:contract:token_id` format
/// * `block_height` - The block height to query at
///
/// # Returns
/// The balance as a BigDecimal (for arbitrary precision with proper decimal places)
pub async fn get_balance_at_block(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    block_height: u64,
) -> Result<bigdecimal::BigDecimal, Box<dyn std::error::Error>> {
    // Strip the canonical namespace before separating the contract from the
    // contract-specific token id. Token ids may themselves contain colons.
    let (contract_str, token) = parse_nep245_asset_id(token_id)
        .map_err(|message| -> Box<dyn std::error::Error> { message.into() })?;
    let decimals = resolve_decimals(pool, network, token_id).await?;

    let contract_id = near_api::types::AccountId::from_str(contract_str)?;
    let contract = Contract(contract_id);

    let balance = with_transport_retry("intents_balance", || {
        contract
            .call_function(
                "mt_balance_of",
                serde_json::json!({
                    "account_id": account_id,
                    "token_id": token
                }),
            )
            .read_only()
            .at(Reference::AtBlock(block_height))
            .fetch_from(network)
    })
    .await?;

    let raw_balance: String = balance.data;
    let decimal_balance = convert_raw_to_decimal(&raw_balance, decimals)?;

    Ok(decimal_balance)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_utils::init_test_state;

    #[test]
    fn parses_intents_and_canonical_nep245_asset_ids() {
        assert_eq!(
            parse_nep245_asset_id("intents.near:nep141:btc.omft.near").unwrap(),
            ("intents.near", "nep141:btc.omft.near")
        );
        assert_eq!(
            parse_nep245_asset_id("nep245:v2_1.omni.hot.tg:4444119_wyixUKCL").unwrap(),
            ("v2_1.omni.hot.tg", "4444119_wyixUKCL")
        );
        assert_eq!(
            parse_nep245_asset_id("nep245:collectibles.near:collection:token:7").unwrap(),
            ("collectibles.near", "collection:token:7")
        );
    }

    #[test]
    fn rejects_nep245_asset_ids_without_contract_or_token() {
        assert!(parse_nep245_asset_id("nep245:contract.near").is_err());
        assert!(parse_nep245_asset_id("nep245::token").is_err());
        assert!(parse_nep245_asset_id("nep245:contract.near:").is_err());
    }

    /// Verifies that balance queries for non-intents.near NEP-245 contracts work end-to-end:
    /// - decimals are fetched via mt_metadata_base_by_token_id (not ft_metadata)
    /// - balance is fetched via mt_balance_of with account_id + token_id parameters
    ///
    /// Token: GNK (GONKA), 9 decimals. Raw balance 4305864173000 / 10^9 = 4305.864173
    #[tokio::test]
    async fn test_query_v2_omni_hot_tg_balance() {
        use bigdecimal::BigDecimal;
        use std::str::FromStr;

        let state = init_test_state().await;

        let balance = get_balance_at_block(
            &state.db_pool,
            &state.archival_network,
            "hot-dao.sputnik-dao.near",
            "v2_1.omni.hot.tg:4444119_wyixUKCL",
            188090254,
        )
        .await
        .unwrap();

        assert_eq!(balance, BigDecimal::from_str("4305.864173").unwrap());
    }
}
