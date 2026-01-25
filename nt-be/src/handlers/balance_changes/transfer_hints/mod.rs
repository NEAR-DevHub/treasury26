//! Transfer Hint Providers
//!
//! This module provides external transfer API integration to accelerate balance change detection.
//! Instead of binary searching through potentially millions of blocks, external providers can
//! supply known block heights where transfers occurred.
//!
//! # Architecture
//!
//! The transfer hint system follows a "hints, not source of truth" philosophy:
//! 1. External APIs provide hints about where transfers occurred
//! 2. RPC verifies the hints' accuracy before use
//! 3. Binary search remains available as fallback if hints fail
//!
//! # Supported Token Types
//!
//! Each provider declares which token types it supports:
//! - `"near"` - Native NEAR transfers
//! - `"wrap.near"` - Standard FT tokens (NEP-141)
//! - `"intents.near:nep141:token"` - NEAR Intents tokens (future support)

pub mod fastnear;
pub mod tx_resolver;

use async_trait::async_trait;
use bigdecimal::BigDecimal;
use std::error::Error;

/// A hint about where a balance change might have occurred
#[derive(Debug, Clone)]
pub struct TransferHint {
    /// Block height where the transfer occurred
    pub block_height: u64,
    /// Timestamp in milliseconds
    pub timestamp_ms: u64,
    /// Transfer amount (optional, for validation)
    pub amount: Option<BigDecimal>,
    /// The other party in the transfer (optional)
    pub counterparty: Option<String>,
    /// Receipt ID for the transfer (optional)
    pub receipt_id: Option<String>,
    /// Transaction hash (optional) - used for tx_status lookup
    pub transaction_hash: Option<String>,
    /// Balance at start of block (from FastNear) - if different from end, change happened at this block
    pub start_of_block_balance: Option<BigDecimal>,
    /// Balance at end of block (from FastNear)
    pub end_of_block_balance: Option<BigDecimal>,
}

/// Provider that can suggest block heights where transfers occurred
#[async_trait]
pub trait TransferHintProvider: Send + Sync {
    /// Provider name for logging and debugging
    fn name(&self) -> &'static str;

    /// Get transfer hints for an account/token in a block range
    ///
    /// # Arguments
    /// * `account_id` - NEAR account to query transfers for
    /// * `token_id` - Token identifier ("near", "wrap.near", etc.)
    /// * `from_block` - Start of block range (inclusive)
    /// * `to_block` - End of block range (inclusive)
    ///
    /// # Returns
    /// Vector of transfer hints, sorted by block height ascending
    async fn get_hints(
        &self,
        account_id: &str,
        token_id: &str,
        from_block: u64,
        to_block: u64,
    ) -> Result<Vec<TransferHint>, Box<dyn Error + Send + Sync>>;

    /// Check if this provider supports the given token type
    fn supports_token(&self, token_id: &str) -> bool;
}

/// Orchestrates multiple hint providers with fallback
pub struct TransferHintService {
    providers: Vec<Box<dyn TransferHintProvider>>,
}

impl Default for TransferHintService {
    fn default() -> Self {
        Self::new()
    }
}

impl TransferHintService {
    /// Create a new empty TransferHintService
    pub fn new() -> Self {
        Self { providers: vec![] }
    }

    /// Add a provider to the service
    pub fn with_provider(mut self, provider: impl TransferHintProvider + 'static) -> Self {
        self.providers.push(Box::new(provider));
        self
    }

    /// Get hints from all providers that support the token, merging results
    ///
    /// Queries all providers in parallel, merges results, and deduplicates by block height.
    /// Returns hints sorted by block height ascending.
    pub async fn get_hints(
        &self,
        account_id: &str,
        token_id: &str,
        from_block: u64,
        to_block: u64,
    ) -> Vec<TransferHint> {
        use futures::future::join_all;
        use std::collections::BTreeMap;

        // Filter to providers that support this token
        let supporting_providers: Vec<_> = self
            .providers
            .iter()
            .filter(|p| p.supports_token(token_id))
            .collect();

        if supporting_providers.is_empty() {
            log::debug!(
                "No providers support token {} for account {}",
                token_id,
                account_id
            );
            return vec![];
        }

        // Query all providers in parallel
        let futures = supporting_providers.iter().map(|provider| {
            let account_id = account_id.to_string();
            let token_id = token_id.to_string();
            async move {
                match provider
                    .get_hints(&account_id, &token_id, from_block, to_block)
                    .await
                {
                    Ok(hints) => {
                        log::debug!(
                            "Provider {} returned {} hints for {}/{}",
                            provider.name(),
                            hints.len(),
                            account_id,
                            token_id
                        );
                        hints
                    }
                    Err(e) => {
                        log::warn!(
                            "Provider {} failed for {}/{}: {}",
                            provider.name(),
                            account_id,
                            token_id,
                            e
                        );
                        vec![]
                    }
                }
            }
        });

        let results = join_all(futures).await;

        // Merge and deduplicate by block height (keep first occurrence)
        let mut hints_by_block: BTreeMap<u64, TransferHint> = BTreeMap::new();
        for hints in results {
            for hint in hints {
                hints_by_block.entry(hint.block_height).or_insert(hint);
            }
        }

        hints_by_block.into_values().collect()
    }

    /// Check if any provider supports the given token
    pub fn supports_token(&self, token_id: &str) -> bool {
        self.providers.iter().any(|p| p.supports_token(token_id))
    }

    /// Get the number of registered providers
    pub fn provider_count(&self) -> usize {
        self.providers.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mock provider for testing
    struct MockProvider {
        name: &'static str,
        supported_tokens: Vec<&'static str>,
        hints: Vec<TransferHint>,
    }

    #[async_trait]
    impl TransferHintProvider for MockProvider {
        fn name(&self) -> &'static str {
            self.name
        }

        async fn get_hints(
            &self,
            _account_id: &str,
            _token_id: &str,
            from_block: u64,
            to_block: u64,
        ) -> Result<Vec<TransferHint>, Box<dyn Error + Send + Sync>> {
            Ok(self
                .hints
                .iter()
                .filter(|h| h.block_height >= from_block && h.block_height <= to_block)
                .cloned()
                .collect())
        }

        fn supports_token(&self, token_id: &str) -> bool {
            self.supported_tokens
                .iter()
                .any(|t| t.eq_ignore_ascii_case(token_id))
        }
    }

    #[test]
    fn test_transfer_hint_service_new() {
        let service = TransferHintService::new();
        assert_eq!(service.provider_count(), 0);
    }

    #[test]
    fn test_transfer_hint_service_with_provider() {
        let provider = MockProvider {
            name: "test",
            supported_tokens: vec!["near"],
            hints: vec![],
        };
        let service = TransferHintService::new().with_provider(provider);
        assert_eq!(service.provider_count(), 1);
    }

    #[test]
    fn test_supports_token_empty_service() {
        let service = TransferHintService::new();
        assert!(!service.supports_token("near"));
    }

    #[test]
    fn test_supports_token_with_provider() {
        let provider = MockProvider {
            name: "test",
            supported_tokens: vec!["near", "wrap.near"],
            hints: vec![],
        };
        let service = TransferHintService::new().with_provider(provider);

        assert!(service.supports_token("near"));
        assert!(service.supports_token("wrap.near"));
        assert!(!service.supports_token("unknown.near"));
    }

    #[tokio::test]
    async fn test_get_hints_no_providers() {
        let service = TransferHintService::new();
        let hints = service
            .get_hints("test.near", "near", 1000, 2000)
            .await;
        assert!(hints.is_empty());
    }

    #[tokio::test]
    async fn test_get_hints_single_provider() {
        let provider = MockProvider {
            name: "test",
            supported_tokens: vec!["near"],
            hints: vec![
                TransferHint {
                    block_height: 1500,
                    timestamp_ms: 1500000,
                    amount: None,
                    counterparty: Some("alice.near".to_string()),
                    receipt_id: None,
                    transaction_hash: None,
                    start_of_block_balance: None,
                    end_of_block_balance: None,
                },
                TransferHint {
                    block_height: 1700,
                    timestamp_ms: 1700000,
                    amount: None,
                    counterparty: Some("bob.near".to_string()),
                    receipt_id: None,
                    transaction_hash: None,
                    start_of_block_balance: None,
                    end_of_block_balance: None,
                },
            ],
        };

        let service = TransferHintService::new().with_provider(provider);
        let hints = service
            .get_hints("test.near", "near", 1000, 2000)
            .await;

        assert_eq!(hints.len(), 2);
        assert_eq!(hints[0].block_height, 1500);
        assert_eq!(hints[1].block_height, 1700);
    }

    #[tokio::test]
    async fn test_get_hints_filters_by_block_range() {
        let provider = MockProvider {
            name: "test",
            supported_tokens: vec!["near"],
            hints: vec![
                TransferHint {
                    block_height: 500,
                    timestamp_ms: 500000,
                    amount: None,
                    counterparty: None,
                    receipt_id: None,
                    transaction_hash: None,
                    start_of_block_balance: None,
                    end_of_block_balance: None,
                },
                TransferHint {
                    block_height: 1500,
                    timestamp_ms: 1500000,
                    amount: None,
                    counterparty: None,
                    receipt_id: None,
                    transaction_hash: None,
                    start_of_block_balance: None,
                    end_of_block_balance: None,
                },
                TransferHint {
                    block_height: 2500,
                    timestamp_ms: 2500000,
                    amount: None,
                    counterparty: None,
                    receipt_id: None,
                    transaction_hash: None,
                    start_of_block_balance: None,
                    end_of_block_balance: None,
                },
            ],
        };

        let service = TransferHintService::new().with_provider(provider);
        let hints = service
            .get_hints("test.near", "near", 1000, 2000)
            .await;

        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].block_height, 1500);
    }

    #[tokio::test]
    async fn test_get_hints_unsupported_token() {
        let provider = MockProvider {
            name: "test",
            supported_tokens: vec!["near"],
            hints: vec![TransferHint {
                block_height: 1500,
                timestamp_ms: 1500000,
                amount: None,
                counterparty: None,
                receipt_id: None,
                transaction_hash: None,
                start_of_block_balance: None,
                end_of_block_balance: None,
            }],
        };

        let service = TransferHintService::new().with_provider(provider);
        let hints = service
            .get_hints("test.near", "wrap.near", 1000, 2000)
            .await;

        assert!(hints.is_empty());
    }

    #[tokio::test]
    async fn test_get_hints_multiple_providers_deduplicates() {
        let provider1 = MockProvider {
            name: "provider1",
            supported_tokens: vec!["near"],
            hints: vec![
                TransferHint {
                    block_height: 1500,
                    timestamp_ms: 1500000,
                    amount: None,
                    counterparty: Some("alice.near".to_string()),
                    receipt_id: None,
                    transaction_hash: None,
                    start_of_block_balance: None,
                    end_of_block_balance: None,
                },
                TransferHint {
                    block_height: 1600,
                    timestamp_ms: 1600000,
                    amount: None,
                    counterparty: None,
                    receipt_id: None,
                    transaction_hash: None,
                    start_of_block_balance: None,
                    end_of_block_balance: None,
                },
            ],
        };

        let provider2 = MockProvider {
            name: "provider2",
            supported_tokens: vec!["near"],
            hints: vec![
                TransferHint {
                    block_height: 1500, // Duplicate block
                    timestamp_ms: 1500001,
                    amount: None,
                    counterparty: Some("bob.near".to_string()),
                    receipt_id: None,
                    transaction_hash: None,
                    start_of_block_balance: None,
                    end_of_block_balance: None,
                },
                TransferHint {
                    block_height: 1700,
                    timestamp_ms: 1700000,
                    amount: None,
                    counterparty: None,
                    receipt_id: None,
                    transaction_hash: None,
                    start_of_block_balance: None,
                    end_of_block_balance: None,
                },
            ],
        };

        let service = TransferHintService::new()
            .with_provider(provider1)
            .with_provider(provider2);
        let hints = service
            .get_hints("test.near", "near", 1000, 2000)
            .await;

        // Should have 3 unique blocks (1500 deduplicated)
        assert_eq!(hints.len(), 3);
        let block_heights: Vec<_> = hints.iter().map(|h| h.block_height).collect();
        assert_eq!(block_heights, vec![1500, 1600, 1700]);
    }
}
