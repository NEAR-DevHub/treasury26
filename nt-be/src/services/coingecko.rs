//! CoinGecko API client for fetching historical price data
//!
//! This module provides a client for the CoinGecko Pro API to fetch historical
//! USD prices for various cryptocurrencies.

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

use super::price_provider::PriceProvider;

/// Default CoinGecko Pro API base URL
const DEFAULT_COINGECKO_API_BASE: &str = "https://pro-api.coingecko.com/api/v3";

/// How far back to fetch historical prices (in days)
/// CoinGecko Pro allows up to 365 days for market_chart/range with daily granularity
const HISTORICAL_DAYS: i64 = 365;

/// Static mapping from unified asset IDs to CoinGecko-specific asset IDs
static UNIFIED_TO_COINGECKO_ID: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();

/// Get the mapping from unified asset IDs to CoinGecko IDs
///
/// This mapping translates from tokens.json `unifiedAssetId` values to CoinGecko's
/// coin IDs. CoinGecko IDs are unique identifiers used in their API endpoints.
///
/// Note: CoinGecko has many coins with the same symbol (e.g., multiple "BTC" coins),
/// so we must map to the specific CoinGecko ID for the correct asset.
fn get_coingecko_id_map() -> &'static HashMap<&'static str, &'static str> {
    UNIFIED_TO_COINGECKO_ID.get_or_init(|| {
        let mut map = HashMap::new();

        // Major cryptocurrencies
        map.insert("btc", "bitcoin");
        map.insert("eth", "ethereum");
        map.insert("sol", "solana");
        map.insert("xrp", "ripple");
        map.insert("near", "near");

        // Stablecoins
        map.insert("usdc", "usd-coin");
        map.insert("usdt", "tether");
        map.insert("dai", "dai");

        // Wrapped/bridged variants
        map.insert("cbbtc", "coinbase-wrapped-btc");

        // NEAR ecosystem tokens
        map.insert("aurora", "aurora-near");
        map.insert("sweat", "sweatcoin");
        map.insert("hapi", "hapi");

        // Other tokens
        map.insert("zcash", "zcash");
        map.insert("turbo", "turbo");
        map.insert("rhea", "rhea");
        map.insert("safe", "safe");
        map.insert("spx", "spx6900");
        map.insert("adi", "adi-token");
        map.insert("cfi", "consumerfi-protocol"); // ConsumerFi Protocol (not CyberFi or Coinbet)
        map.insert("public", "publicai");

        map
    })
}

/// Response from /coins/{id}/history endpoint
#[derive(Debug, Deserialize)]
struct HistoryResponse {
    #[allow(dead_code)]
    id: String,
    #[allow(dead_code)]
    symbol: String,
    #[allow(dead_code)]
    name: String,
    market_data: Option<MarketData>,
}

#[derive(Debug, Deserialize)]
struct MarketData {
    current_price: Option<CurrentPrice>,
}

#[derive(Debug, Deserialize)]
struct CurrentPrice {
    usd: Option<f64>,
}

/// Response from /coins/{id}/market_chart/range endpoint
#[derive(Debug, Deserialize)]
struct MarketChartRangeResponse {
    /// Array of [timestamp_ms, price] tuples
    prices: Vec<(i64, f64)>,
}

/// CoinGecko API client
pub struct CoinGeckoClient {
    http_client: Client,
    api_key: String,
    base_url: String,
}

impl CoinGeckoClient {
    /// Creates a new CoinGecko client with the default API base URL
    ///
    /// # Arguments
    /// * `http_client` - Shared HTTP client for making requests
    /// * `api_key` - CoinGecko Pro API key
    pub fn new(http_client: Client, api_key: String) -> Self {
        Self {
            http_client,
            api_key,
            base_url: DEFAULT_COINGECKO_API_BASE.to_string(),
        }
    }

    /// Creates a new CoinGecko client with a custom API base URL
    ///
    /// This is useful for testing with a mock server.
    pub fn with_base_url(http_client: Client, api_key: String, base_url: String) -> Self {
        Self {
            http_client,
            api_key,
            base_url,
        }
    }
}

#[async_trait]
impl PriceProvider for CoinGeckoClient {
    fn source_name(&self) -> &'static str {
        "coingecko"
    }

    fn translate_asset_id(&self, unified_asset_id: &str) -> Option<String> {
        get_coingecko_id_map()
            .get(unified_asset_id)
            .map(|s| s.to_string())
    }

    async fn get_price_at_date(
        &self,
        asset_id: &str,
        date: NaiveDate,
    ) -> Result<Option<f64>, Box<dyn std::error::Error + Send + Sync>> {
        // CoinGecko expects date in dd-mm-yyyy format
        let date_str = date.format("%d-%m-%Y").to_string();

        let url = format!(
            "{}/coins/{}/history?date={}&localization=false",
            self.base_url, asset_id, date_str
        );

        log::debug!("Fetching price from CoinGecko: {} for {}", asset_id, date);

        let response = self
            .http_client
            .get(&url)
            .header("x-cg-pro-api-key", &self.api_key)
            .header("accept", "application/json")
            .send()
            .await?;

        let status = response.status();

        if status == reqwest::StatusCode::NOT_FOUND {
            log::debug!("CoinGecko: Asset {} not found", asset_id);
            return Ok(None);
        }

        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            log::warn!(
                "CoinGecko API error for {}: {} - {}",
                asset_id,
                status,
                error_text
            );
            return Err(format!("CoinGecko API error: {} - {}", status, error_text).into());
        }

        let data: HistoryResponse = response.json().await?;

        let price = data
            .market_data
            .and_then(|md| md.current_price)
            .and_then(|cp| cp.usd);

        if let Some(p) = price {
            log::debug!("CoinGecko: {} price on {} = ${}", asset_id, date, p);
        } else {
            log::debug!(
                "CoinGecko: No price data for {} on {} (market_data missing)",
                asset_id,
                date
            );
        }

        Ok(price)
    }

    async fn get_all_historical_prices(
        &self,
        asset_id: &str,
    ) -> Result<HashMap<NaiveDate, f64>, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now();
        let from = now - chrono::Duration::days(HISTORICAL_DAYS);

        let url = format!(
            "{}/coins/{}/market_chart/range?vs_currency=usd&from={}&to={}",
            self.base_url,
            asset_id,
            from.timestamp(),
            now.timestamp()
        );

        log::info!(
            "Fetching all historical prices from CoinGecko for {} ({} days)",
            asset_id,
            HISTORICAL_DAYS
        );

        let response = self
            .http_client
            .get(&url)
            .header("x-cg-pro-api-key", &self.api_key)
            .header("accept", "application/json")
            .send()
            .await?;

        let status = response.status();

        if status == reqwest::StatusCode::NOT_FOUND {
            log::debug!("CoinGecko: Asset {} not found", asset_id);
            return Ok(HashMap::new());
        }

        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            log::warn!(
                "CoinGecko API error fetching history for {}: {} - {}",
                asset_id,
                status,
                error_text
            );
            return Err(format!("CoinGecko API error: {} - {}", status, error_text).into());
        }

        let data: MarketChartRangeResponse = response.json().await?;

        // Convert to daily prices (taking the first price per day)
        // CoinGecko returns data at various intervals; we deduplicate by date
        let mut daily_prices: HashMap<NaiveDate, f64> = HashMap::new();

        for (timestamp_ms, price) in data.prices {
            if let Some(dt) = DateTime::from_timestamp_millis(timestamp_ms) {
                let date = dt.date_naive();
                // Only keep the first price for each day
                daily_prices.entry(date).or_insert(price);
            }
        }

        log::info!(
            "CoinGecko: Fetched {} daily prices for {}",
            daily_prices.len(),
            asset_id
        );

        Ok(daily_prices)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_source_name() {
        let client = CoinGeckoClient::new(Client::new(), "test-key".to_string());
        assert_eq!(client.source_name(), "coingecko");
    }

    #[test]
    fn test_translate_asset_id_major_coins() {
        let client = CoinGeckoClient::new(Client::new(), "test-key".to_string());

        // Major cryptocurrencies
        assert_eq!(client.translate_asset_id("btc"), Some("bitcoin".to_string()));
        assert_eq!(
            client.translate_asset_id("eth"),
            Some("ethereum".to_string())
        );
        assert_eq!(client.translate_asset_id("sol"), Some("solana".to_string()));
        assert_eq!(client.translate_asset_id("xrp"), Some("ripple".to_string()));
        assert_eq!(client.translate_asset_id("near"), Some("near".to_string()));
    }

    #[test]
    fn test_translate_asset_id_stablecoins() {
        let client = CoinGeckoClient::new(Client::new(), "test-key".to_string());

        assert_eq!(
            client.translate_asset_id("usdc"),
            Some("usd-coin".to_string())
        );
        assert_eq!(
            client.translate_asset_id("usdt"),
            Some("tether".to_string())
        );
        assert_eq!(client.translate_asset_id("dai"), Some("dai".to_string()));
    }

    #[test]
    fn test_translate_asset_id_near_ecosystem() {
        let client = CoinGeckoClient::new(Client::new(), "test-key".to_string());

        assert_eq!(
            client.translate_asset_id("aurora"),
            Some("aurora-near".to_string())
        );
        assert_eq!(
            client.translate_asset_id("sweat"),
            Some("sweatcoin".to_string())
        );
        assert_eq!(client.translate_asset_id("hapi"), Some("hapi".to_string()));
    }

    #[test]
    fn test_translate_asset_id_other_tokens() {
        let client = CoinGeckoClient::new(Client::new(), "test-key".to_string());

        assert_eq!(
            client.translate_asset_id("cbbtc"),
            Some("coinbase-wrapped-btc".to_string())
        );
        assert_eq!(
            client.translate_asset_id("zcash"),
            Some("zcash".to_string())
        );
        assert_eq!(client.translate_asset_id("turbo"), Some("turbo".to_string()));
        assert_eq!(client.translate_asset_id("spx"), Some("spx6900".to_string()));
        assert_eq!(
            client.translate_asset_id("cfi"),
            Some("consumerfi-protocol".to_string())
        );
        assert_eq!(
            client.translate_asset_id("public"),
            Some("publicai".to_string())
        );
    }

    #[test]
    fn test_translate_asset_id_unknown() {
        let client = CoinGeckoClient::new(Client::new(), "test-key".to_string());

        assert_eq!(client.translate_asset_id("unknown-token"), None);
        assert_eq!(client.translate_asset_id("random"), None);
    }
}
