//! Price provider trait for fetching historical price data
//!
//! This module defines the interface for price data sources.
//! Implementations can fetch prices from various sources like CoinGecko, Pyth, etc.

use async_trait::async_trait;
use chrono::NaiveDate;
use std::collections::HashMap;

/// Trait for price data providers
#[async_trait]
pub trait PriceProvider: Send + Sync {
    /// Returns the name of the price source (e.g., "coingecko", "pyth")
    fn source_name(&self) -> &'static str;

    /// Translates a unified asset ID to this provider's specific asset ID
    ///
    /// Each provider has its own asset identifier format. This method maps from
    /// a unified/canonical asset ID (e.g., "btc", "eth", "usdc") to the provider's
    /// specific ID (e.g., CoinGecko uses "bitcoin", "ethereum", "usd-coin").
    ///
    /// # Arguments
    /// * `unified_asset_id` - The unified asset identifier (e.g., from tokens.json)
    ///
    /// # Returns
    /// * `Some(provider_id)` - The provider-specific asset ID if supported
    /// * `None` - If this provider doesn't support the asset
    fn translate_asset_id(&self, unified_asset_id: &str) -> Option<String>;

    /// Fetches the USD price for an asset at a specific date
    ///
    /// # Arguments
    /// * `asset_id` - The provider-specific asset identifier (e.g., "bitcoin" for CoinGecko)
    /// * `date` - The date to fetch the price for
    ///
    /// # Returns
    /// * `Ok(Some(price))` - The USD price if available
    /// * `Ok(None)` - If the asset is not supported or no price data exists for that date
    /// * `Err(_)` - If there was an error fetching the price
    async fn get_price_at_date(
        &self,
        asset_id: &str,
        date: NaiveDate,
    ) -> Result<Option<f64>, Box<dyn std::error::Error + Send + Sync>>;

    /// Fetches all available historical prices for an asset
    ///
    /// This method fetches the complete price history for an asset, which is more
    /// efficient than fetching individual dates. The implementation should return
    /// daily prices from as far back as available up to the current date.
    ///
    /// # Arguments
    /// * `asset_id` - The provider-specific asset identifier (e.g., "bitcoin" for CoinGecko)
    ///
    /// # Returns
    /// * `Ok(prices)` - A map of date -> USD price for all available dates
    /// * `Err(_)` - If there was an error fetching prices
    async fn get_all_historical_prices(
        &self,
        asset_id: &str,
    ) -> Result<HashMap<NaiveDate, f64>, Box<dyn std::error::Error + Send + Sync>>;
}
