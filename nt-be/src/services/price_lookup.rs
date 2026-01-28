//! Price lookup service (cache-only)
//!
//! This module provides the main interface for looking up historical prices.
//! It only reads from the database cache - prices are populated by the
//! background price sync service.
//!
//! It handles:
//! - Mapping NEAR token IDs to unified asset IDs
//! - Reading cached prices from the database

use bigdecimal::BigDecimal;
use chrono::NaiveDate;
use sqlx::PgPool;
use std::collections::HashMap;

use super::price_provider::PriceProvider;
use crate::constants::intents_tokens::{get_defuse_tokens_map, get_tokens_map};

/// Price lookup service that combines caching with price providers
///
/// The provider is optional - when None, the service will only return cached prices
/// from the database and won't fetch new prices. This allows the application to
/// run without a configured price provider (e.g., no CoinGecko API key).
pub struct PriceLookupService<P: PriceProvider> {
    pool: PgPool,
    provider: Option<P>,
}

impl<P: PriceProvider> PriceLookupService<P> {
    /// Creates a new price lookup service with a provider
    pub fn new(pool: PgPool, provider: P) -> Self {
        Self {
            pool,
            provider: Some(provider),
        }
    }

    /// Creates a new price lookup service without a provider (cache-only mode)
    pub fn without_provider(pool: PgPool) -> Self {
        Self {
            pool,
            provider: None,
        }
    }

    /// Returns true if this service has a configured price provider
    pub fn has_provider(&self) -> bool {
        self.provider.is_some()
    }

    /// Get the price for a token at a specific date
    ///
    /// This method only reads from the cache. Prices are populated by the
    /// background price sync service.
    ///
    /// # Arguments
    /// * `token_id` - The NEAR token ID (e.g., "near", "intents.near:nep141:btc.omft.near")
    /// * `date` - The date to get the price for
    ///
    /// # Returns
    /// * `Ok(Some(price))` - The USD price if available in cache
    /// * `Ok(None)` - If no price is cached for this token/date
    /// * `Err(_)` - If there was an error
    pub async fn get_price(
        &self,
        token_id: &str,
        date: NaiveDate,
    ) -> Result<Option<f64>, Box<dyn std::error::Error + Send + Sync>> {
        // If no provider, we can't translate asset IDs
        let provider = match &self.provider {
            Some(p) => p,
            None => return Ok(None),
        };

        // Map token_id to unified asset ID first
        let unified_id = match token_id_to_unified_asset_id(token_id) {
            Some(id) => id,
            None => {
                log::debug!("No unified asset ID mapping for token: {}", token_id);
                return Ok(None);
            }
        };

        // Ask the provider to translate to its specific asset ID
        let provider_asset_id = match provider.translate_asset_id(&unified_id) {
            Some(id) => id,
            None => {
                log::debug!(
                    "Provider {} does not support asset: {}",
                    provider.source_name(),
                    unified_id
                );
                return Ok(None);
            }
        };

        // Check cache only (no fetching - background service populates cache)
        let cached_price = self.get_cached_price(&provider_asset_id, date).await?;

        if cached_price.is_none() {
            log::debug!(
                "Cache miss for {} on {} (background sync should populate)",
                provider_asset_id,
                date
            );
        }

        Ok(cached_price)
    }

    /// Get prices for multiple dates (batch operation)
    ///
    /// This method only reads from the cache. Prices are populated by the
    /// background price sync service. Missing prices are logged but not fetched
    /// to avoid blocking API calls.
    pub async fn get_prices_batch(
        &self,
        token_id: &str,
        dates: &[NaiveDate],
    ) -> Result<HashMap<NaiveDate, f64>, Box<dyn std::error::Error + Send + Sync>> {
        let result = HashMap::new();

        // If no provider, we can't translate asset IDs
        let provider = match &self.provider {
            Some(p) => p,
            None => return Ok(result),
        };

        // Map token_id to unified asset ID first
        let unified_id = match token_id_to_unified_asset_id(token_id) {
            Some(id) => id,
            None => return Ok(result),
        };

        // Ask the provider to translate to its specific asset ID
        let provider_asset_id = match provider.translate_asset_id(&unified_id) {
            Some(id) => id,
            None => return Ok(result),
        };

        // Get all cached prices (cache-only, no fetching)
        let cached = self
            .get_batch_cached_prices(&provider_asset_id, dates)
            .await?;

        // Log if there are missing prices (background service should fill them)
        let missing_count = dates.len() - cached.len();
        if missing_count > 0 {
            log::debug!(
                "Cache miss for {} ({} of {} dates not cached)",
                provider_asset_id,
                missing_count,
                dates.len()
            );
        }

        Ok(cached)
    }

    /// Get cached price from database
    async fn get_cached_price(
        &self,
        asset_id: &str,
        date: NaiveDate,
    ) -> Result<Option<f64>, Box<dyn std::error::Error + Send + Sync>> {
        let result = sqlx::query!(
            r#"
            SELECT price_usd
            FROM historical_prices
            WHERE asset_id = $1 AND price_date = $2
            ORDER BY fetched_at DESC
            LIMIT 1
            "#,
            asset_id,
            date
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(result.and_then(|r| bigdecimal_to_f64(&r.price_usd)))
    }

    /// Get multiple cached prices at once
    async fn get_batch_cached_prices(
        &self,
        asset_id: &str,
        dates: &[NaiveDate],
    ) -> Result<HashMap<NaiveDate, f64>, Box<dyn std::error::Error + Send + Sync>> {
        let rows = sqlx::query!(
            r#"
            SELECT DISTINCT ON (price_date) price_date, price_usd
            FROM historical_prices
            WHERE asset_id = $1 AND price_date = ANY($2)
            ORDER BY price_date, fetched_at DESC
            "#,
            asset_id,
            dates
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .filter_map(|r| bigdecimal_to_f64(&r.price_usd).map(|p| (r.price_date, p)))
            .collect())
    }

}

/// Convert BigDecimal to f64
fn bigdecimal_to_f64(bd: &BigDecimal) -> Option<f64> {
    use bigdecimal::ToPrimitive;
    bd.to_f64()
}

/// Map a NEAR token_id to its unified asset ID
///
/// The unified asset ID is a provider-agnostic identifier (e.g., "btc", "eth", "usdc")
/// that can then be translated by each provider to their specific asset ID.
///
/// # Strategy
/// 1. Handle special cases (native NEAR)
/// 2. Normalize token_id (strip intents.near: prefix if present)
/// 3. Look up in tokens.json - either exact match or search for containing match
pub fn token_id_to_unified_asset_id(token_id: &str) -> Option<String> {
    // Special case: native NEAR
    if token_id == "near" {
        return Some("near".to_string());
    }

    // Special case: staking pools (staked NEAR is still NEAR)
    // e.g., "staking:astro-stakers.poolv1.near" → "near"
    if token_id.starts_with("staking:") {
        return Some("near".to_string());
    }

    let normalized = normalize_token_id(token_id);
    let defuse_map = get_defuse_tokens_map();

    // Try exact match first (for intents tokens with full defuse_asset_id)
    if defuse_map.contains_key(&normalized) {
        return find_unified_asset_id_for_defuse_id(&normalized);
    }

    // Search for a defuse_asset_id that contains this token contract
    // e.g., "wrap.near" matches "nep141:wrap.near"
    for defuse_asset_id in defuse_map.keys() {
        if defuse_asset_id.ends_with(&format!(":{}", normalized)) {
            return find_unified_asset_id_for_defuse_id(defuse_asset_id);
        }
    }

    None
}

/// Normalize token_id to the lookup key format used in tokens.json
///
/// For intents tokens, strips the "intents.near:" prefix.
/// For direct token contracts, returns as-is (will be searched in the map).
fn normalize_token_id(token_id: &str) -> String {
    // Handle intents.near: prefix (works for both nep141 and nep245)
    // "intents.near:nep141:btc.omft.near" -> "nep141:btc.omft.near"
    // "intents.near:nep245:v2_1.omni.hot.tg:..." -> "nep245:v2_1.omni.hot.tg:..."
    if let Some(stripped) = token_id.strip_prefix("intents.near:") {
        return stripped.to_string();
    }

    token_id.to_string()
}

/// Find the unifiedAssetId for a given defuseAssetId by searching tokens.json
fn find_unified_asset_id_for_defuse_id(defuse_asset_id: &str) -> Option<String> {
    let tokens_map = get_tokens_map();

    for (unified_id, unified_token) in tokens_map.iter() {
        for base_token in &unified_token.grouped_tokens {
            if base_token.defuse_asset_id == defuse_asset_id {
                return Some(unified_id.clone());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_id_to_unified_asset_id_native_near() {
        assert_eq!(
            token_id_to_unified_asset_id("near"),
            Some("near".to_string())
        );
    }

    #[test]
    fn test_token_id_to_unified_asset_id_wrapped_near() {
        assert_eq!(
            token_id_to_unified_asset_id("intents.near:nep141:wrap.near"),
            Some("near".to_string())
        );
    }

    #[test]
    fn test_token_id_to_unified_asset_id_staking_pool() {
        // Staking pools should map to NEAR (staked NEAR is still NEAR)
        assert_eq!(
            token_id_to_unified_asset_id("staking:astro-stakers.poolv1.near"),
            Some("near".to_string())
        );
        assert_eq!(
            token_id_to_unified_asset_id("staking:any-pool.near"),
            Some("near".to_string())
        );
    }

    #[test]
    fn test_token_id_to_unified_asset_id_btc() {
        assert_eq!(
            token_id_to_unified_asset_id("intents.near:nep141:btc.omft.near"),
            Some("btc".to_string())
        );
    }

    #[test]
    fn test_token_id_to_unified_asset_id_eth() {
        assert_eq!(
            token_id_to_unified_asset_id("intents.near:nep141:eth.omft.near"),
            Some("eth".to_string())
        );
    }

    #[test]
    fn test_token_id_to_unified_asset_id_sol() {
        assert_eq!(
            token_id_to_unified_asset_id("intents.near:nep141:sol.omft.near"),
            Some("sol".to_string())
        );
    }

    #[test]
    fn test_token_id_to_unified_asset_id_xrp() {
        assert_eq!(
            token_id_to_unified_asset_id("intents.near:nep141:xrp.omft.near"),
            Some("xrp".to_string())
        );
    }

    #[test]
    fn test_token_id_to_unified_asset_id_usdc_native() {
        // Native NEAR USDC contract
        assert_eq!(
            token_id_to_unified_asset_id(
                "intents.near:nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
            ),
            Some("usdc".to_string())
        );
    }

    #[test]
    fn test_token_id_to_unified_asset_id_usdc_base() {
        // Base chain USDC bridged
        assert_eq!(
            token_id_to_unified_asset_id(
                "intents.near:nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
            ),
            Some("usdc".to_string())
        );
    }

    #[test]
    fn test_token_id_to_unified_asset_id_unknown_token() {
        // Unknown tokens should return None
        assert_eq!(token_id_to_unified_asset_id("arizcredits.near"), None);
        assert_eq!(token_id_to_unified_asset_id("some-random-token.near"), None);
    }

    #[test]
    fn test_normalize_token_id() {
        // NEP-141 tokens via intents - strips prefix
        assert_eq!(
            normalize_token_id("intents.near:nep141:btc.omft.near"),
            "nep141:btc.omft.near"
        );
        // NEP-245 tokens via intents (HOT omni bridge) - strips prefix
        assert_eq!(
            normalize_token_id(
                "intents.near:nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L"
            ),
            "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L"
        );
        // Direct NEAR token contracts - pass through unchanged
        assert_eq!(normalize_token_id("wrap.near"), "wrap.near");
        // Already normalized tokens pass through
        assert_eq!(
            normalize_token_id("nep141:btc.omft.near"),
            "nep141:btc.omft.near"
        );
    }

    /// Verify that all tokens from tokens.json can be mapped to a unified asset ID
    /// when using the intents.near: prefix format that balance changes use.
    ///
    /// Note: Some tokens appear in multiple unified groups (e.g., "turbo" and "turbo (omni)").
    /// This test verifies the mapping works, not that it matches the exact parent group.
    #[test]
    fn test_all_tokens_json_can_be_mapped() {
        let defuse_map = get_defuse_tokens_map();

        let mut success_count = 0;
        let mut failed_tokens = Vec::new();

        // Test all unique defuseAssetIds
        for (defuse_asset_id, _base_token) in defuse_map.iter() {
            // Construct token_id as it would appear in balance_changes
            // e.g., "intents.near:nep141:btc.omft.near"
            let token_id = format!("intents.near:{}", defuse_asset_id);

            match token_id_to_unified_asset_id(&token_id) {
                Some(_unified_id) => {
                    success_count += 1;
                }
                None => {
                    failed_tokens.push(format!("{} -> None", token_id));
                }
            }
        }

        println!(
            "Token mapping: {} succeeded, {} failed out of {} unique defuseAssetIds",
            success_count,
            failed_tokens.len(),
            defuse_map.len()
        );

        if !failed_tokens.is_empty() {
            println!("Failed mappings:");
            for failed in &failed_tokens {
                println!("  {}", failed);
            }
        }

        assert!(
            failed_tokens.is_empty(),
            "All tokens from tokens.json should map to a unified asset ID. {} failed.",
            failed_tokens.len()
        );

        // Also verify we have a reasonable number of tokens
        assert!(
            success_count > 100,
            "Expected at least 100 tokens, got {}",
            success_count
        );
    }

    /// Test that direct FT token contracts (without intents.near: prefix) can also be mapped.
    /// These come from `discover_ft_tokens_from_receipts` when FT contracts are discovered
    /// from NEAR transfer counterparties.
    #[test]
    fn test_direct_ft_tokens_can_be_mapped() {
        // These are stored as just the contract address, not prefixed with intents.near:
        // The function should add nep141: prefix and find them

        // wrap.near should map to "near" unified ID
        assert_eq!(
            token_id_to_unified_asset_id("wrap.near"),
            Some("near".to_string()),
            "wrap.near should map to 'near' unified asset ID"
        );

        // token.sweat should map to "sweat"
        assert_eq!(
            token_id_to_unified_asset_id("token.sweat"),
            Some("sweat".to_string()),
            "token.sweat should map to 'sweat' unified asset ID"
        );
    }
}
