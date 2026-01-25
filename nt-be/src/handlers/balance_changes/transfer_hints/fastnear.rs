//! FastNear Transfers API Provider
//!
//! Implements the TransferHintProvider trait using FastNear's transfers-api.
//! API Documentation: https://github.com/fastnear/transfers-api
//!
//! # Supported Token Types
//! - `"near"` - Native NEAR transfers
//! - Standard FT tokens (e.g., `"wrap.near"`, `"usdt.tether-token.near"`)
//!
//! # API Endpoint
//! `POST https://transfers.main.fastnear.com/v0/transfers`

use super::{TransferHint, TransferHintProvider};
use async_trait::async_trait;
use bigdecimal::BigDecimal;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::str::FromStr;

/// FastNear transfers-api provider
pub struct FastNearProvider {
    client: Client,
    base_url: String,
}

impl Default for FastNearProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl FastNearProvider {
    /// Create a new FastNearProvider with default settings
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            base_url: "https://transfers.main.fastnear.com".to_string(),
        }
    }

    /// Create a new FastNearProvider with a custom base URL
    pub fn with_base_url(base_url: impl Into<String>) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.into(),
        }
    }

    /// Create a new FastNearProvider with a custom HTTP client
    pub fn with_client(client: Client, base_url: impl Into<String>) -> Self {
        Self {
            client,
            base_url: base_url.into(),
        }
    }

    /// Convert block height to approximate timestamp (ms)
    ///
    /// NEAR mainnet produces ~1 block per second. This is a rough approximation
    /// used to convert block ranges to timestamp ranges for the FastNear API.
    ///
    /// Based on actual data from FastNear API:
    /// - Block 178148636 at timestamp 1766561525616 ms
    /// - Block 182682617 at timestamp 1769354830050 ms
    /// - This gives approximately 1 block per 616ms average
    fn block_to_timestamp_ms(block_height: u64) -> u64 {
        // Use verified reference points from FastNear API
        // Block 178148636 at timestamp 1766561525616 ms (from actual API response)
        const REFERENCE_BLOCK: u64 = 178_148_636;
        const REFERENCE_TIMESTAMP_MS: u64 = 1_766_561_525_616;

        // Calculate ms per block from two known points:
        // Block 182682617 at 1769354830050 ms
        // Difference: 4533981 blocks, 2793304434 ms = ~616ms per block
        const MS_PER_BLOCK: u64 = 616;

        if block_height >= REFERENCE_BLOCK {
            REFERENCE_TIMESTAMP_MS + ((block_height - REFERENCE_BLOCK) * MS_PER_BLOCK)
        } else {
            REFERENCE_TIMESTAMP_MS.saturating_sub((REFERENCE_BLOCK - block_height) * MS_PER_BLOCK)
        }
    }

    /// Query the transfers API with pagination
    async fn query_transfers(
        &self,
        request: &TransfersRequest,
    ) -> Result<TransfersResponse, Box<dyn Error + Send + Sync>> {
        let url = format!("{}/v0/transfers", self.base_url);

        let response = self.client.post(&url).json(request).send().await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("FastNear API error: {} - {}", status, body).into());
        }

        let transfers_response: TransfersResponse = response.json().await?;
        Ok(transfers_response)
    }
}

#[async_trait]
impl TransferHintProvider for FastNearProvider {
    fn name(&self) -> &'static str {
        "FastNear"
    }

    async fn get_hints(
        &self,
        account_id: &str,
        token_id: &str,
        from_block: u64,
        to_block: u64,
    ) -> Result<Vec<TransferHint>, Box<dyn Error + Send + Sync>> {
        // Convert block range to timestamp range
        let from_timestamp_ms = Self::block_to_timestamp_ms(from_block);
        let to_timestamp_ms = Self::block_to_timestamp_ms(to_block);

        let mut all_hints = Vec::new();
        let mut resume_token: Option<String> = None;

        // Paginate through all results
        loop {
            let request = TransfersRequest {
                account_id: account_id.to_string(),
                from_timestamp_ms: Some(from_timestamp_ms),
                to_timestamp_ms: Some(to_timestamp_ms),
                limit: Some(1000),
                desc: Some(false), // Ascending order
                resume_token: resume_token.clone(),
            };

            let response = self.query_transfers(&request).await?;

            // Filter and convert transfers to hints
            for transfer in &response.transfers {
                if transfer.matches_token(token_id) {
                    let hint = TransferHint {
                        block_height: transfer.block_height,
                        timestamp_ms: transfer.timestamp_ms(),
                        amount: transfer
                            .amount
                            .as_ref()
                            .and_then(|a| BigDecimal::from_str(a).ok()),
                        counterparty: transfer.counterparty().map(|s| s.to_string()),
                        receipt_id: transfer.receipt_id.clone(),
                        transaction_hash: transfer.transaction_id.clone(),
                        start_of_block_balance: transfer
                            .start_of_block_balance
                            .as_ref()
                            .and_then(|b| BigDecimal::from_str(b).ok()),
                        end_of_block_balance: transfer
                            .end_of_block_balance
                            .as_ref()
                            .and_then(|b| BigDecimal::from_str(b).ok()),
                    };
                    all_hints.push(hint);
                }
            }

            // Check for more pages
            match response.resume_token {
                Some(token) if !response.transfers.is_empty() => {
                    resume_token = Some(token);
                }
                _ => break,
            }
        }

        // Sort by block height (should already be sorted, but ensure)
        all_hints.sort_by_key(|h| h.block_height);

        log::debug!(
            "FastNear returned {} hints for {}/{} in blocks {}-{}",
            all_hints.len(),
            account_id,
            token_id,
            from_block,
            to_block
        );

        Ok(all_hints)
    }

    fn supports_token(&self, token_id: &str) -> bool {
        // FastNear supports NEAR native and FT tokens
        // It does not support intents tokens (yet)
        !token_id.contains("intents.near:")
    }
}

/// Request body for the FastNear transfers API
#[derive(Debug, Serialize)]
struct TransfersRequest {
    account_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    from_timestamp_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    to_timestamp_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    desc: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resume_token: Option<String>,
}

/// Response from the FastNear transfers API
#[derive(Debug, Deserialize)]
struct TransfersResponse {
    transfers: Vec<Transfer>,
    resume_token: Option<String>,
}

/// Helper to deserialize strings or numbers as u64
fn deserialize_string_or_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{self, Visitor};
    use std::fmt;

    struct StringOrU64Visitor;

    impl<'de> Visitor<'de> for StringOrU64Visitor {
        type Value = u64;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("a string or integer")
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(value)
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            value.parse().map_err(de::Error::custom)
        }
    }

    deserializer.deserialize_any(StringOrU64Visitor)
}

/// A single transfer record from FastNear
///
/// Based on actual API response structure:
/// ```json
/// {
///   "account_id": "petersalomonsen.near",
///   "asset_id": "nep141:token.near",
///   "asset_type": "Ft",
///   "block_height": "140091715",
///   "block_timestamp": "1739954687907236131",
///   "amount": "9300000000",
///   "other_account_id": "pay.reqnetwork.near",
///   "predecessor_id": "pay.reqnetwork.near",
///   "receipt_id": "5rnW3axTPEsVWexkTSrhzUpivomwLQx5hL9TGA5QX9sf",
///   "signer_id": "nf-payments2.near",
///   "transaction_id": "GUev6hLpM4SYKNsX6YV9KRsr7jVkj4aAj2ZsMyKGE1e"
/// }
/// ```
#[derive(Debug, Deserialize)]
struct Transfer {
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    block_height: u64,
    /// Timestamp in nanoseconds (not milliseconds!)
    #[serde(deserialize_with = "deserialize_string_or_u64")]
    block_timestamp: u64,
    receipt_id: Option<String>,
    transaction_id: Option<String>,
    /// The other party in the transfer
    other_account_id: Option<String>,
    predecessor_id: Option<String>,
    signer_id: Option<String>,
    /// Asset type: "Near" or "Ft"
    asset_type: String,
    /// Asset ID for FT tokens (format: "nep141:contract.near" or just "contract.near")
    asset_id: Option<String>,
    /// Transfer amount as string
    amount: Option<String>,
    /// Balance at start of block (raw amount as string)
    start_of_block_balance: Option<String>,
    /// Balance at end of block (raw amount as string)
    end_of_block_balance: Option<String>,
}

impl Transfer {
    /// Get the counterparty for this transfer
    fn counterparty(&self) -> Option<&str> {
        // Priority: other_account_id (most specific), then predecessor, then signer
        self.other_account_id
            .as_deref()
            .or(self.predecessor_id.as_deref())
            .or(self.signer_id.as_deref())
    }

    /// Get the timestamp in milliseconds
    fn timestamp_ms(&self) -> u64 {
        self.block_timestamp / 1_000_000
    }

    /// Check if this transfer matches the given token ID
    fn matches_token(&self, token_id: &str) -> bool {
        match self.asset_type.as_str() {
            "Near" => token_id.eq_ignore_ascii_case("near"),
            "Ft" => {
                // asset_id can be "nep141:contract.near" or just "contract.near"
                if let Some(asset_id) = &self.asset_id {
                    // Strip "nep141:" prefix if present
                    let contract_id = asset_id.strip_prefix("nep141:").unwrap_or(asset_id);
                    contract_id.eq_ignore_ascii_case(token_id)
                } else {
                    false
                }
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_near_transfer() -> Transfer {
        Transfer {
            block_height: 1000,
            block_timestamp: 1739954687907236131, // nanoseconds
            receipt_id: Some("receipt1".to_string()),
            transaction_id: Some("tx1".to_string()),
            other_account_id: Some("other.near".to_string()),
            predecessor_id: Some("sender.near".to_string()),
            signer_id: Some("signer.near".to_string()),
            asset_type: "Near".to_string(),
            asset_id: None,
            amount: Some("1000000000000000000000000".to_string()),
            start_of_block_balance: Some("5000000000000000000000000".to_string()),
            end_of_block_balance: Some("6000000000000000000000000".to_string()),
        }
    }

    fn make_ft_transfer(contract: &str) -> Transfer {
        Transfer {
            block_height: 1000,
            block_timestamp: 1739954687907236131,
            receipt_id: Some("receipt1".to_string()),
            transaction_id: Some("tx1".to_string()),
            other_account_id: Some("other.near".to_string()),
            predecessor_id: Some("sender.near".to_string()),
            signer_id: Some("signer.near".to_string()),
            asset_type: "Ft".to_string(),
            asset_id: Some(format!("nep141:{}", contract)),
            amount: Some("1000000".to_string()),
            start_of_block_balance: Some("5000000".to_string()),
            end_of_block_balance: Some("6000000".to_string()),
        }
    }

    #[test]
    fn test_fastnear_provider_new() {
        let provider = FastNearProvider::new();
        assert_eq!(provider.name(), "FastNear");
        assert_eq!(provider.base_url, "https://transfers.main.fastnear.com");
    }

    #[test]
    fn test_fastnear_provider_with_base_url() {
        let provider = FastNearProvider::with_base_url("https://custom.api.com");
        assert_eq!(provider.base_url, "https://custom.api.com");
    }

    #[test]
    fn test_supports_token_near() {
        let provider = FastNearProvider::new();
        assert!(provider.supports_token("near"));
        assert!(provider.supports_token("NEAR"));
    }

    #[test]
    fn test_supports_token_ft() {
        let provider = FastNearProvider::new();
        assert!(provider.supports_token("wrap.near"));
        assert!(provider.supports_token("usdt.tether-token.near"));
    }

    #[test]
    fn test_supports_token_intents_not_supported() {
        let provider = FastNearProvider::new();
        assert!(!provider.supports_token("intents.near:nep141:wrap.near"));
        assert!(!provider.supports_token("intents.near:nep245:token"));
    }

    #[test]
    fn test_block_to_timestamp_conversion() {
        // Use constants from the implementation
        const REFERENCE_BLOCK: u64 = 178_148_636;
        const REFERENCE_TIMESTAMP_MS: u64 = 1_766_561_525_616;
        const MS_PER_BLOCK: u64 = 616;

        // Reference block should give reference timestamp
        let reference_ts = FastNearProvider::block_to_timestamp_ms(REFERENCE_BLOCK);
        assert_eq!(reference_ts, REFERENCE_TIMESTAMP_MS);

        // Block 1M after reference should be ~1M * 616ms later
        let block_later = REFERENCE_BLOCK + 1_000_000;
        let later_ts = FastNearProvider::block_to_timestamp_ms(block_later);
        assert_eq!(later_ts, REFERENCE_TIMESTAMP_MS + 1_000_000 * MS_PER_BLOCK);

        // Earlier blocks should work too
        let block_earlier = REFERENCE_BLOCK - 1_000_000;
        let earlier_ts = FastNearProvider::block_to_timestamp_ms(block_earlier);
        assert_eq!(
            earlier_ts,
            REFERENCE_TIMESTAMP_MS - 1_000_000 * MS_PER_BLOCK
        );
    }

    #[test]
    fn test_transfer_matches_token_near() {
        let near_transfer = make_near_transfer();

        assert!(near_transfer.matches_token("near"));
        assert!(near_transfer.matches_token("NEAR"));
        assert!(!near_transfer.matches_token("wrap.near"));
    }

    #[test]
    fn test_transfer_matches_token_ft() {
        let ft_transfer = make_ft_transfer("wrap.near");

        assert!(ft_transfer.matches_token("wrap.near"));
        assert!(ft_transfer.matches_token("WRAP.NEAR"));
        assert!(!ft_transfer.matches_token("near"));
        assert!(!ft_transfer.matches_token("usdt.tether-token.near"));
    }

    #[test]
    fn test_transfer_matches_token_ft_without_prefix() {
        // Test FT with asset_id without nep141: prefix
        let mut ft_transfer = make_ft_transfer("wrap.near");
        ft_transfer.asset_id = Some("wrap.near".to_string()); // No prefix

        assert!(ft_transfer.matches_token("wrap.near"));
    }

    #[test]
    fn test_transfer_counterparty() {
        let mut transfer = make_near_transfer();

        // other_account_id takes priority
        assert_eq!(transfer.counterparty(), Some("other.near"));

        // Falls back to predecessor_id
        transfer.other_account_id = None;
        assert_eq!(transfer.counterparty(), Some("sender.near"));

        // Falls back to signer_id
        transfer.predecessor_id = None;
        assert_eq!(transfer.counterparty(), Some("signer.near"));

        // Returns None if all are None
        transfer.signer_id = None;
        assert_eq!(transfer.counterparty(), None);
    }

    #[test]
    fn test_transfer_timestamp_ms() {
        let transfer = make_near_transfer();
        // block_timestamp is in nanoseconds, timestamp_ms should be in milliseconds
        assert_eq!(transfer.timestamp_ms(), 1739954687907);
    }
}
