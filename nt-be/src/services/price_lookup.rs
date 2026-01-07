//! Price lookup service with caching
//!
//! This module provides the main interface for looking up historical prices.
//! It handles:
//! - Mapping NEAR token IDs to unified asset IDs
//! - Caching prices in the database
//! - Fetching from price providers when cache misses occur

use bigdecimal::BigDecimal;
use chrono::NaiveDate;
use sqlx::PgPool;
use std::collections::HashMap;

use super::price_provider::PriceProvider;
use crate::constants::intents_tokens::{get_defuse_tokens_map, get_tokens_map};

/// Price lookup service that combines caching with price providers
pub struct PriceLookupService<P: PriceProvider> {
    pool: PgPool,
    provider: P,
}

impl<P: PriceProvider> PriceLookupService<P> {
    /// Creates a new price lookup service
    pub fn new(pool: PgPool, provider: P) -> Self {
        Self { pool, provider }
    }

    /// Get the price for a token at a specific date
    ///
    /// # Arguments
    /// * `token_id` - The NEAR token ID (e.g., "near", "intents.near:nep141:btc.omft.near")
    /// * `date` - The date to get the price for
    ///
    /// # Returns
    /// * `Ok(Some(price))` - The USD price if available
    /// * `Ok(None)` - If no price is available for this token
    /// * `Err(_)` - If there was an error
    pub async fn get_price(
        &self,
        token_id: &str,
        date: NaiveDate,
    ) -> Result<Option<f64>, Box<dyn std::error::Error + Send + Sync>> {
        // Map token_id to unified asset ID first
        let unified_id = match token_id_to_unified_asset_id(token_id) {
            Some(id) => id,
            None => {
                log::debug!("No unified asset ID mapping for token: {}", token_id);
                return Ok(None);
            }
        };

        // Ask the provider to translate to its specific asset ID
        let provider_asset_id = match self.provider.translate_asset_id(&unified_id) {
            Some(id) => id,
            None => {
                log::debug!(
                    "Provider {} does not support asset: {}",
                    self.provider.source_name(),
                    unified_id
                );
                return Ok(None);
            }
        };

        // Check cache first
        if let Some(cached_price) = self.get_cached_price(&provider_asset_id, date).await? {
            log::debug!(
                "Cache hit for {} on {}: ${}",
                provider_asset_id,
                date,
                cached_price
            );
            return Ok(Some(cached_price));
        }

        // Fetch from provider
        log::debug!(
            "Cache miss for {} on {}, fetching from provider",
            provider_asset_id,
            date
        );
        let price = self
            .provider
            .get_price_at_date(&provider_asset_id, date)
            .await?;

        // Cache the result if we got a price
        if let Some(p) = price {
            self.cache_price(&provider_asset_id, date, p).await?;
        }

        Ok(price)
    }

    /// Get prices for multiple dates (batch operation)
    ///
    /// When cache misses occur, this method fetches ALL historical prices for the asset
    /// in a single API call, then caches them all. This is more efficient than fetching
    /// each date individually.
    pub async fn get_prices_batch(
        &self,
        token_id: &str,
        dates: &[NaiveDate],
    ) -> Result<HashMap<NaiveDate, f64>, Box<dyn std::error::Error + Send + Sync>> {
        let mut result = HashMap::new();

        // Map token_id to unified asset ID first
        let unified_id = match token_id_to_unified_asset_id(token_id) {
            Some(id) => id,
            None => return Ok(result),
        };

        // Ask the provider to translate to its specific asset ID
        let provider_asset_id = match self.provider.translate_asset_id(&unified_id) {
            Some(id) => id,
            None => return Ok(result),
        };

        // Get all cached prices first
        let cached = self
            .get_batch_cached_prices(&provider_asset_id, dates)
            .await?;
        result.extend(cached);

        // Find dates that need fetching
        let missing_dates: Vec<_> = dates
            .iter()
            .filter(|d| !result.contains_key(*d))
            .cloned()
            .collect();

        if missing_dates.is_empty() {
            return Ok(result);
        }

        // Fetch ALL historical prices for this asset in one API call
        // This is more efficient than fetching each date individually
        log::debug!(
            "Cache miss for {} ({} dates), fetching all historical prices",
            provider_asset_id,
            missing_dates.len()
        );

        match self
            .provider
            .get_all_historical_prices(&provider_asset_id)
            .await
        {
            Ok(all_prices) => {
                // Cache all fetched prices
                for (&date, &price) in &all_prices {
                    if let Err(e) = self.cache_price(&provider_asset_id, date, price).await {
                        log::warn!(
                            "Failed to cache price for {} on {}: {}",
                            provider_asset_id,
                            date,
                            e
                        );
                    }
                }

                // Add the prices we need to our result
                for date in missing_dates {
                    if let Some(&price) = all_prices.get(&date) {
                        result.insert(date, price);
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    "Failed to fetch historical prices for {}: {}",
                    provider_asset_id,
                    e
                );
            }
        }

        Ok(result)
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

    /// Cache a price in the database
    async fn cache_price(
        &self,
        asset_id: &str,
        date: NaiveDate,
        price: f64,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let price_decimal = BigDecimal::try_from(price)?;

        sqlx::query!(
            r#"
            INSERT INTO historical_prices (asset_id, price_date, price_usd, source)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (asset_id, price_date, source) DO NOTHING
            "#,
            asset_id,
            date,
            price_decimal,
            self.provider.source_name()
        )
        .execute(&self.pool)
        .await?;

        Ok(())
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
/// 2. Convert token_id to defuseAssetId format
/// 3. Look up in tokens.json to find the unifiedAssetId
pub fn token_id_to_unified_asset_id(token_id: &str) -> Option<String> {
    // Special case: native NEAR
    if token_id == "near" {
        return Some("near".to_string());
    }

    // Try to find via tokens.json lookup
    let defuse_asset_id = token_id_to_defuse_asset_id(token_id);

    // Look up in defuse tokens map
    if get_defuse_tokens_map().contains_key(&defuse_asset_id) {
        // Found the base token, now find its unified asset ID
        if let Some(unified_id) = find_unified_asset_id_for_defuse_id(&defuse_asset_id) {
            return Some(unified_id);
        }
    }

    None
}

/// Convert token_id format to defuseAssetId format
fn token_id_to_defuse_asset_id(token_id: &str) -> String {
    // Handle intents.near: prefix
    // "intents.near:nep141:btc.omft.near" -> "nep141:btc.omft.near"
    if let Some(stripped) = token_id.strip_prefix("intents.near:") {
        return stripped.to_string();
    }

    // Handle direct NEAR token contracts
    // "wrap.near" -> "nep141:wrap.near"
    if !token_id.contains(':') && token_id.ends_with(".near") {
        return format!("nep141:{}", token_id);
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
    fn test_token_id_to_defuse_asset_id() {
        assert_eq!(
            token_id_to_defuse_asset_id("intents.near:nep141:btc.omft.near"),
            "nep141:btc.omft.near"
        );
        assert_eq!(token_id_to_defuse_asset_id("wrap.near"), "nep141:wrap.near");
        assert_eq!(
            token_id_to_defuse_asset_id("nep141:btc.omft.near"),
            "nep141:btc.omft.near"
        );
    }
}
