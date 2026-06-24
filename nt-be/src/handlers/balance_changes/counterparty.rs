//! Counterparty Management
//!
//! Handles storage and retrieval of counterparty metadata, including FT token information
//! for decimal conversion.

use crate::constants::intents_tokens;
use crate::handlers::balance_changes::utils::with_transport_retry;
use near_api::types::ft::FungibleTokenMetadata;
use near_api::{AccountId, Contract, NetworkConfig, Tokens};
use sqlx::PgPool;
use std::str::FromStr;

/// Query FT metadata from a contract using near-api's Tokens API
///
/// Uses `Tokens::ft_metadata` which is the recommended approach from near-api-rs.
/// See: https://github.com/NEAR-DevHub/treasury26/pull/17#discussion_r1900494695
pub async fn query_ft_metadata(
    network: &NetworkConfig,
    token_contract: &str,
) -> Result<FungibleTokenMetadata, Box<dyn std::error::Error>> {
    let account_id = AccountId::from_str(token_contract)?;

    // Use Tokens::ft_metadata for cleaner API and built-in FungibleTokenMetadata type
    let response = Tokens::ft_metadata(account_id).fetch_from(network).await?;

    Ok(response.data)
}

/// Store or update FT token metadata in counterparties table
pub async fn upsert_ft_counterparty(
    pool: &PgPool,
    account_id: &str,
    metadata: &FungibleTokenMetadata,
) -> Result<(), Box<dyn std::error::Error>> {
    sqlx::query!(
        r#"
        INSERT INTO counterparties (
            account_id,
            account_type,
            token_symbol,
            token_name,
            token_decimals,
            token_icon,
            last_verified_at
        ) VALUES ($1, 'ft_token', $2, $3, $4, $5, NOW())
        ON CONFLICT (account_id) 
        DO UPDATE SET
            token_symbol = EXCLUDED.token_symbol,
            token_name = EXCLUDED.token_name,
            token_decimals = EXCLUDED.token_decimals,
            token_icon = EXCLUDED.token_icon,
            last_verified_at = NOW()
        "#,
        account_id,
        metadata.symbol,
        metadata.name,
        metadata.decimals as i16,
        metadata.icon,
    )
    .execute(pool)
    .await?;

    Ok(())
}

/// Get FT token decimals from counterparties table
/// Returns None if not found or not an FT token
pub async fn get_ft_decimals(
    pool: &PgPool,
    token_contract: &str,
) -> Result<Option<u8>, Box<dyn std::error::Error>> {
    let result = sqlx::query!(
        r#"
        SELECT token_decimals
        FROM counterparties
        WHERE account_id = $1 AND account_type = 'ft_token'
        "#,
        token_contract
    )
    .fetch_optional(pool)
    .await?;

    Ok(result.and_then(|r| r.token_decimals.map(|d| d as u8)))
}

/// Extract the actual FT contract ID from a token identifier
///
/// For intents tokens (e.g., "intents.near:nep141:wrap.near"), extracts the contract after the prefix.
/// For regular tokens, returns the token_id as-is.
fn extract_ft_contract(token_id: &str) -> &str {
    // Check for intents.near prefixes (NEP-141 and NEP-245)
    if let Some(rest) = token_id.strip_prefix("intents.near:nep141:") {
        rest
    } else if let Some(rest) = token_id.strip_prefix("intents.near:nep245:") {
        rest
    } else {
        token_id
    }
}

/// Ensure FT token metadata exists in counterparties table
/// If not found, queries the contract and stores it
///
/// Handles both regular FT tokens and intents tokens (e.g., "intents.near:nep141:wrap.near").
/// For intents tokens, uses the token registry from data/tokens.json instead of RPC queries.
/// For regular FT tokens, extracts the actual contract ID and queries it.
pub async fn ensure_ft_metadata(
    pool: &PgPool,
    network: &NetworkConfig,
    token_contract: &str,
) -> Result<u8, Box<dyn std::error::Error>> {
    // Check if we already have the metadata
    if let Some(decimals) = get_ft_decimals(pool, token_contract).await? {
        return Ok(decimals);
    }

    // For ALL intents tokens (NEP-141 and NEP-245), use token registry
    if token_contract.starts_with("intents.near:") {
        // Strip "intents.near:" prefix to get defuseAssetId format
        let asset_id = token_contract.strip_prefix("intents.near:").unwrap();

        // Look up in token registry (loaded from data/tokens.json)
        if let Some(token_data) = intents_tokens::find_token_by_defuse_asset_id(asset_id) {
            // Cache it in database
            let metadata = FungibleTokenMetadata {
                spec: "ft-1.0.0".to_string(),
                name: token_data.name.clone(),
                symbol: token_data.symbol.clone(),
                decimals: token_data.decimals,
                icon: Some(token_data.icon.clone()),
                reference: None,
                reference_hash: None,
            };
            upsert_ft_counterparty(pool, token_contract, &metadata).await?;

            tracing::info!(
                "Discovered intents token from registry: {} ({}) with {} decimals",
                metadata.name,
                metadata.symbol,
                token_data.decimals
            );

            return Ok(token_data.decimals);
        }

        // Token not in registry - log warning and return error
        tracing::warn!("Intents token not found in registry: {}", token_contract);
        return Err(format!("Intents token not found in registry: {}", token_contract).into());
    }

    // Regular FT token (not intents) - use existing RPC query logic
    let actual_contract = extract_ft_contract(token_contract);
    let metadata = query_ft_metadata(network, actual_contract).await?;
    let decimals = metadata.decimals;
    upsert_ft_counterparty(pool, token_contract, &metadata).await?;

    tracing::info!(
        "Discovered FT token: {} ({}) with {} decimals (contract: {})",
        metadata.name,
        metadata.symbol,
        decimals,
        actual_contract
    );

    Ok(decimals)
}

/// Ensure NEP-245 multi-token metadata exists in counterparties table.
///
/// Unlike FT tokens, NEP-245 contracts expose `mt_metadata_base_by_token_id(token_ids)`
/// to get per-token metadata including decimals. This is used for contracts like
/// `v2_1.omni.hot.tg` that implement the multi-token standard but not `ft_metadata`.
///
/// The full `contract:token` string is used as the cache key, matching how intents tokens
/// are stored (e.g. `intents.near:nep141:wrap.near`).
pub async fn ensure_nep245_token_decimals(
    pool: &PgPool,
    network: &NetworkConfig,
    token_id: &str,     // full "contract:token" string, used as cache key
    contract_str: &str, // part before ':', the NEP-245 contract
    token: &str,        // part after ':', the token ID within the contract
) -> Result<u8, Box<dyn std::error::Error>> {
    if let Some(decimals) = get_ft_decimals(pool, token_id).await? {
        return Ok(decimals);
    }

    #[derive(serde::Deserialize)]
    struct MtBaseTokenMetadata {
        name: String,
        symbol: Option<String>,
        decimals: Option<u8>,
        icon: Option<String>,
    }

    let contract_id = AccountId::from_str(contract_str)?;
    let contract = Contract(contract_id);

    let response = with_transport_retry("mt_metadata_base_by_token_id", || {
        contract
            .call_function(
                "mt_metadata_base_by_token_id",
                serde_json::json!({ "token_ids": [token] }),
            )
            .read_only()
            .fetch_from(network)
    })
    .await?;

    let metadata_list: Vec<Option<MtBaseTokenMetadata>> = response.data;
    let metadata = metadata_list
        .into_iter()
        .flatten()
        .next()
        .ok_or_else(|| format!("No NEP-245 metadata returned for token: {}", token_id))?;

    let decimals = metadata.decimals.unwrap_or(0);
    let ft_metadata = FungibleTokenMetadata {
        spec: "ft-1.0.0".to_string(),
        name: metadata.name.clone(),
        symbol: metadata.symbol.unwrap_or_else(|| contract_str.to_string()),
        decimals,
        icon: metadata.icon,
        reference: None,
        reference_hash: None,
    };
    upsert_ft_counterparty(pool, token_id, &ft_metadata).await?;

    tracing::info!(
        "Discovered NEP-245 token: {} with {} decimals (contract: {}, token: {})",
        metadata.name,
        decimals,
        contract_str,
        token,
    );

    Ok(decimals)
}

/// Convert raw FT amount to decimal-adjusted BigDecimal
///
/// # Arguments
/// * `raw_amount` - The raw amount from ft_balance_of (smallest units)
/// * `decimals` - Number of decimal places for this token
///
/// # Returns
/// A BigDecimal with decimal adjustment applied
pub fn convert_raw_to_decimal(
    raw_amount: &str,
    decimals: u8,
) -> Result<bigdecimal::BigDecimal, Box<dyn std::error::Error>> {
    use bigdecimal::BigDecimal;
    use std::str::FromStr;

    let raw = BigDecimal::from_str(raw_amount)?;

    // Create divisor as BigDecimal to avoid u64 overflow for large decimals (like NEAR's 24)
    // Calculate 10^decimals as a string and parse it
    let divisor_str = format!("1{}", "0".repeat(decimals as usize));
    let divisor = BigDecimal::from_str(&divisor_str)?;

    let decimal = raw / divisor;

    // Normalize to remove trailing zeros (e.g., "11.1000" -> "11.1")
    Ok(decimal.normalized())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_ft_contract() {
        // Regular FT tokens - should return as-is
        assert_eq!(extract_ft_contract("wrap.near"), "wrap.near");
        assert_eq!(extract_ft_contract("arizcredits.near"), "arizcredits.near");

        // NEP-141 intents tokens - should extract contract after prefix
        assert_eq!(
            extract_ft_contract("intents.near:nep141:wrap.near"),
            "wrap.near"
        );
        assert_eq!(
            extract_ft_contract("intents.near:nep141:eth.omft.near"),
            "eth.omft.near"
        );
        assert_eq!(
            extract_ft_contract(
                "intents.near:nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
            ),
            "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
        );

        // NEP-245 intents tokens
        assert_eq!(
            extract_ft_contract("intents.near:nep245:v2_1.omni.hot.tg:43114_11111111111111111111"),
            "v2_1.omni.hot.tg:43114_11111111111111111111"
        );
    }

    #[test]
    fn test_convert_raw_to_decimal() {
        use bigdecimal::BigDecimal;
        use std::str::FromStr;

        // arizcredits.near has 6 decimals
        assert_eq!(
            convert_raw_to_decimal("2500000", 6).unwrap(),
            BigDecimal::from_str("2.5").unwrap()
        );
        assert_eq!(
            convert_raw_to_decimal("3000000", 6).unwrap(),
            BigDecimal::from_str("3").unwrap()
        );

        // NEAR has 24 decimals
        assert_eq!(
            convert_raw_to_decimal("1000000000000000000000000", 24).unwrap(),
            BigDecimal::from_str("1").unwrap()
        );
        assert_eq!(
            convert_raw_to_decimal("2500000000000000000000000", 24).unwrap(),
            BigDecimal::from_str("2.5").unwrap()
        );

        // Zero decimals
        assert_eq!(
            convert_raw_to_decimal("100", 0).unwrap(),
            BigDecimal::from_str("100").unwrap()
        );
    }
}
