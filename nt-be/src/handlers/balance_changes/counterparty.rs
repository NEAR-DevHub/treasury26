//! Counterparty Management
//!
//! Handles storage and retrieval of counterparty metadata, including FT token information
//! for decimal conversion.

use near_api::{AccountId, Contract, NetworkConfig, Reference};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::str::FromStr;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FtMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}

/// Query FT metadata from a contract
pub async fn query_ft_metadata(
    network: &NetworkConfig,
    token_contract: &str,
) -> Result<FtMetadata, Box<dyn std::error::Error>> {
    let account_id = AccountId::from_str(token_contract)?;
    let contract = Contract(account_id);

    // Call ft_metadata view function and get raw string response
    let response: near_api::Data<String> = contract
        .call_function("ft_metadata", serde_json::json!({}))
        .read_only()
        .at(Reference::AtBlock(u64::MAX)) // Latest available block
        .fetch_from(network)
        .await?;

    // Parse the JSON response
    let metadata: FtMetadata = serde_json::from_str(&response.data)?;
    Ok(metadata)
}

/// Store or update FT token metadata in counterparties table
pub async fn upsert_ft_counterparty(
    pool: &PgPool,
    account_id: &str,
    metadata: &FtMetadata,
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

/// Ensure FT token metadata exists in counterparties table
/// If not found, queries the contract and stores it
pub async fn ensure_ft_metadata(
    pool: &PgPool,
    network: &NetworkConfig,
    token_contract: &str,
) -> Result<u8, Box<dyn std::error::Error>> {
    // Check if we already have the metadata
    if let Some(decimals) = get_ft_decimals(pool, token_contract).await? {
        return Ok(decimals);
    }

    // Query from contract and store
    let metadata = query_ft_metadata(network, token_contract).await?;
    let decimals = metadata.decimals;
    upsert_ft_counterparty(pool, token_contract, &metadata).await?;

    log::info!(
        "Discovered FT token: {} ({}) with {} decimals",
        metadata.name,
        metadata.symbol,
        decimals
    );

    Ok(decimals)
}

/// Convert raw FT amount to human-readable decimal string
/// 
/// # Arguments
/// * `raw_amount` - The raw amount from ft_balance_of (smallest units)
/// * `decimals` - Number of decimal places for this token
/// 
/// # Returns
/// A decimal string like "2.5" instead of "2500000"
pub fn convert_raw_to_decimal(raw_amount: &str, decimals: u8) -> Result<String, Box<dyn std::error::Error>> {
    use bigdecimal::BigDecimal;
    use std::str::FromStr;

    let raw = BigDecimal::from_str(raw_amount)?;
    let divisor = BigDecimal::from(10_u64.pow(decimals as u32));
    let decimal = raw / divisor;

    Ok(decimal.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_convert_raw_to_decimal() {
        // arizcredits.near has 6 decimals
        assert_eq!(
            convert_raw_to_decimal("2500000", 6).unwrap(),
            "2.5"
        );
        assert_eq!(
            convert_raw_to_decimal("3000000", 6).unwrap(),
            "3"
        );

        // NEAR has 24 decimals
        assert_eq!(
            convert_raw_to_decimal("1000000000000000000000000", 24).unwrap(),
            "1"
        );
        assert_eq!(
            convert_raw_to_decimal("2500000000000000000000000", 24).unwrap(),
            "2.5"
        );

        // Zero decimals
        assert_eq!(
            convert_raw_to_decimal("100", 0).unwrap(),
            "100"
        );
    }
}
