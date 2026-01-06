//! CoinGecko API client for fetching historical price data
//!
//! This module provides a client for the CoinGecko Pro API to fetch historical
//! USD prices for various cryptocurrencies.

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashMap;

use super::price_provider::PriceProvider;

/// Default CoinGecko Pro API base URL
const DEFAULT_COINGECKO_API_BASE: &str = "https://pro-api.coingecko.com/api/v3";

/// How far back to fetch historical prices (in days)
/// CoinGecko Pro allows up to 365 days for market_chart/range with daily granularity
const HISTORICAL_DAYS: i64 = 365;

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
}
