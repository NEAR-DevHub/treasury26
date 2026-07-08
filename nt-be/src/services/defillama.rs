//! DeFiLlama API client for fetching historical price data
//!
//! This module provides a client for the DeFiLlama Coins API to fetch historical
//! USD prices for various cryptocurrencies. DeFiLlama is free and requires no API key.
//!
//! DeFiLlama supports two ID formats:
//! - `coingecko:{id}` - For major coins using CoinGecko IDs
//! - `near:{contract}` - For NEAR native tokens using contract addresses

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use super::price_provider::PriceProvider;

/// Default DeFiLlama Coins API base URL
const DEFAULT_DEFILLAMA_API_BASE: &str = "https://coins.llama.fi";

/// How far back to fetch historical prices (in days)
/// DeFiLlama's /chart endpoint has timeout issues with large spans.
/// Testing showed span=1500 works reliably, span=2000 fails.
/// Using 365 days (1 year) for faster sync times while maintaining sufficient history.
const HISTORICAL_DAYS: i64 = 365;

/// Static mapping from symbols to DeFiLlama asset IDs
/// For major coins, we use coingecko:{id} format
static SYMBOL_TO_DEFILLAMA_ID: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();

/// Get the mapping from token symbols to DeFiLlama IDs
///
/// This mapping translates from token symbols (uppercase) to DeFiLlama's
/// asset ID format. For major coins, we use `coingecko:{id}` format.
fn get_symbol_map() -> &'static HashMap<&'static str, &'static str> {
    SYMBOL_TO_DEFILLAMA_ID.get_or_init(|| {
        let mut map = HashMap::new();

        // Major cryptocurrencies
        map.insert("BTC", "coingecko:bitcoin");
        map.insert("WBTC", "coingecko:bitcoin");
        map.insert("XBTC", "coingecko:bitcoin");
        map.insert("CBBTC", "coingecko:bitcoin");
        map.insert("ETH", "coingecko:ethereum");
        map.insert("WETH", "coingecko:ethereum");
        map.insert("SOL", "coingecko:solana");
        map.insert("XRP", "coingecko:ripple");
        map.insert("NEAR", "coingecko:near");
        map.insert("WNEAR", "coingecko:near");

        // Stablecoins
        map.insert("USDC", "coingecko:usd-coin");
        map.insert("SUSDC", "coingecko:usd-coin");
        map.insert("USDT", "coingecko:tether");
        map.insert("DAI", "coingecko:dai");
        map.insert("FRAX", "coingecko:frax");

        // Major altcoins
        map.insert("DOGE", "coingecko:dogecoin");
        map.insert("ADA", "coingecko:cardano");
        map.insert("AVAX", "coingecko:avalanche-2");
        map.insert("DOT", "coingecko:polkadot");
        map.insert("LINK", "coingecko:chainlink");
        map.insert("UNI", "coingecko:uniswap");
        map.insert("LTC", "coingecko:litecoin");
        map.insert("BCH", "coingecko:bitcoin-cash");
        map.insert("SHIB", "coingecko:shiba-inu");
        map.insert("TRX", "coingecko:tron");
        map.insert("TON", "coingecko:the-open-network");
        map.insert("SUI", "coingecko:sui");
        map.insert("APT", "coingecko:aptos");
        map.insert("ARB", "coingecko:arbitrum");
        map.insert("OP", "coingecko:optimism");
        map.insert("PEPE", "coingecko:pepe");
        map.insert("XLM", "coingecko:stellar");
        map.insert("BNB", "coingecko:binancecoin");
        map.insert("POL", "coingecko:polygon-ecosystem-token");
        map.insert("STRK", "coingecko:starknet");
        map.insert("ZEC", "coingecko:zcash");

        // DeFi tokens
        map.insert("AAVE", "coingecko:aave");
        map.insert("GMX", "coingecko:gmx");
        map.insert("GNO", "coingecko:gnosis");
        map.insert("KNC", "coingecko:kyber-network-crystal");
        map.insert("COW", "coingecko:cow-protocol");

        // NEAR ecosystem tokens
        map.insert("AURORA", "coingecko:aurora-near");
        map.insert("SWEAT", "coingecko:sweatcoin");
        map.insert("HAPI", "coingecko:hapi");
        map.insert("TURBO", "coingecko:turbo");

        // Meme coins
        map.insert("WIF", "coingecko:dogwifhat");
        map.insert("BOME", "coingecko:book-of-meme");
        map.insert("MOG", "coingecko:mog-coin");
        map.insert("TRUMP", "coingecko:official-trump");
        map.insert("MELANIA", "coingecko:melania-meme");
        map.insert("BRETT", "coingecko:brett");

        // Other tokens
        map.insert("SAFE", "coingecko:safe");
        map.insert("OKB", "coingecko:okb");

        map
    })
}

/// Response from DeFiLlama /prices/current or /prices/historical endpoint
#[derive(Debug, Deserialize)]
struct PricesResponse {
    coins: HashMap<String, CoinPrice>,
}

#[derive(Debug, Deserialize)]
struct CoinPrice {
    price: f64,
    #[allow(dead_code)]
    symbol: Option<String>,
    #[allow(dead_code)]
    timestamp: i64,
    #[allow(dead_code)]
    confidence: Option<f64>,
}

/// One coin from /prices/current with the metadata fields DeFiLlama returns
/// alongside the price — enough to register an unknown token locally.
#[derive(Debug, Clone, Deserialize)]
pub struct CurrentCoin {
    pub price: f64,
    pub symbol: Option<String>,
    pub decimals: Option<i16>,
    pub timestamp: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CurrentCoinsResponse {
    coins: HashMap<String, CurrentCoin>,
}

/// Response from DeFiLlama /batchHistorical endpoint
#[derive(Debug, Deserialize)]
struct BatchHistoricalResponse {
    coins: HashMap<String, BatchHistoricalCoin>,
}

#[derive(Debug, Deserialize)]
struct BatchHistoricalCoin {
    prices: Vec<BatchHistoricalPoint>,
}

/// One nearest-sample price point returned by /batchHistorical. `timestamp`
/// is the actual sample time DeFiLlama found, not the requested one.
#[derive(Debug, Clone, Deserialize)]
pub struct BatchHistoricalPoint {
    pub timestamp: i64,
    pub price: f64,
    #[allow(dead_code)]
    pub confidence: Option<f64>,
}

/// Error from [`DeFiLlamaClient::get_batch_historical`]. Single-attempt by
/// design: the caller owns the retry policy and the rate limiter.
#[derive(Debug)]
pub enum BatchHistoricalError {
    /// 429; delay parsed from the `Retry-After` header when present.
    RateLimited {
        retry_after: Option<Duration>,
    },
    Transport(reqwest::Error),
    Status(reqwest::StatusCode),
    Decode(String),
}

impl std::fmt::Display for BatchHistoricalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RateLimited { retry_after } => {
                write!(f, "DeFiLlama rate limited (retry_after: {retry_after:?})")
            }
            Self::Transport(e) => write!(f, "DeFiLlama transport error: {e}"),
            Self::Status(status) => write!(f, "DeFiLlama API error: {status}"),
            Self::Decode(e) => write!(f, "DeFiLlama response decode error: {e}"),
        }
    }
}

impl std::error::Error for BatchHistoricalError {}

/// Response from DeFiLlama /chart endpoint for historical data
#[derive(Debug, Deserialize)]
struct ChartResponse {
    coins: HashMap<String, ChartData>,
}

#[derive(Debug, Deserialize)]
struct ChartData {
    prices: Vec<PricePoint>,
    #[allow(dead_code)]
    symbol: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PricePoint {
    timestamp: i64,
    price: f64,
}

/// DeFiLlama API client
pub struct DeFiLlamaClient {
    http_client: Client,
    base_url: String,
}

impl DeFiLlamaClient {
    /// Creates a new DeFiLlama client with the default API base URL
    pub fn new(http_client: Client) -> Self {
        Self {
            http_client,
            base_url: DEFAULT_DEFILLAMA_API_BASE.to_string(),
        }
    }

    /// Creates a new DeFiLlama client with a custom API base URL
    ///
    /// This is useful for testing with a mock server.
    pub fn with_base_url(http_client: Client, base_url: String) -> Self {
        Self {
            http_client,
            base_url,
        }
    }

    /// Fetch USD prices for multiple assets at an exact Unix timestamp
    ///
    /// Uses the DeFiLlama `/prices/historical/{timestamp}/{coins}` endpoint
    /// with comma-separated asset IDs for batch efficiency.
    ///
    /// # Arguments
    /// * `asset_ids` - DeFiLlama asset IDs (e.g., "coingecko:bitcoin", "coingecko:near")
    /// * `timestamp` - Unix timestamp (seconds since epoch)
    ///
    /// # Returns
    /// A map from asset_id to USD price for each asset that had data
    pub async fn get_prices_at_timestamp(
        &self,
        asset_ids: &[String],
        timestamp: i64,
    ) -> Result<HashMap<String, f64>, Box<dyn std::error::Error + Send + Sync>> {
        if asset_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let coins_param = asset_ids.join(",");
        let url = format!(
            "{}/prices/historical/{}/{}",
            self.base_url, timestamp, coins_param
        );

        tracing::debug!(
            "Fetching prices from DeFiLlama at timestamp {} for {} assets",
            timestamp,
            asset_ids.len()
        );

        let response = self
            .http_client
            .get(&url)
            .header("accept", "application/json")
            .send()
            .await?;

        let status = response.status();

        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(HashMap::new());
        }

        if !status.is_success() {
            // Only log the status line — response body can be huge (e.g. CloudFlare 429 HTML with base64 images)
            tracing::warn!(
                "DeFiLlama API error for batch price at {}: {}",
                timestamp,
                status,
            );
            return Err(format!("DeFiLlama API error: {}", status).into());
        }

        let data: PricesResponse = response.json().await?;

        let prices: HashMap<String, f64> = data
            .coins
            .into_iter()
            .map(|(id, coin)| (id, coin.price))
            .collect();

        tracing::debug!(
            "DeFiLlama: Got {} prices at timestamp {}",
            prices.len(),
            timestamp
        );

        Ok(prices)
    }

    /// Fetch current USD prices for multiple assets.
    ///
    /// Uses the DeFiLlama `/prices/current/{coins}` endpoint with comma-separated
    /// asset IDs so the cache warmer can update many tokens with one request.
    pub async fn get_current_prices_batch(
        &self,
        asset_ids: &[String],
    ) -> Result<HashMap<String, f64>, Box<dyn std::error::Error + Send + Sync>> {
        if asset_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let coins_param = asset_ids.join(",");
        let url = format!("{}/prices/current/{}", self.base_url, coins_param);

        tracing::debug!(
            "Fetching current prices from DeFiLlama for {} assets",
            asset_ids.len()
        );

        let response = self
            .http_client
            .get(&url)
            .header("accept", "application/json")
            .send()
            .await?;

        let status = response.status();

        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(HashMap::new());
        }

        if !status.is_success() {
            tracing::warn!(
                "DeFiLlama API error for current price batch ({} assets): {}",
                asset_ids.len(),
                status,
            );
            return Err(format!("DeFiLlama API error: {}", status).into());
        }

        let data: PricesResponse = response.json().await?;

        let prices: HashMap<String, f64> = data
            .coins
            .into_iter()
            .map(|(id, coin)| (id, coin.price))
            .collect();

        tracing::debug!(
            "DeFiLlama: Got {} current prices for {} requested assets",
            prices.len(),
            asset_ids.len()
        );

        Ok(prices)
    }

    /// Fetch current prices with symbol/decimals metadata for many assets in
    /// one `/prices/current` request. Coins DeFiLlama does not know are
    /// simply absent from the returned map.
    pub async fn get_current_coins(
        &self,
        asset_ids: &[String],
    ) -> Result<HashMap<String, CurrentCoin>, Box<dyn std::error::Error + Send + Sync>> {
        if asset_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let url = format!("{}/prices/current/{}", self.base_url, asset_ids.join(","));
        let response = self
            .http_client
            .get(&url)
            .header("accept", "application/json")
            .send()
            .await?;

        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(HashMap::new());
        }
        if !status.is_success() {
            return Err(format!("DeFiLlama API error: {}", status).into());
        }

        let data: CurrentCoinsResponse = response.json().await?;
        Ok(data.coins)
    }

    /// Fetch nearest historical USD samples for many (coin, timestamp) points
    /// in one request.
    ///
    /// Uses `GET /batchHistorical?coins={coin:[ts,...]}&searchWidth={secs}`.
    /// One HTTP request regardless of how many points are packed in; ~450
    /// points keep the encoded URL under CloudFront's 8 KB cap. Returns, per
    /// coin, the samples DeFiLlama found within the search width of each
    /// requested timestamp (fewer than requested when data is missing).
    pub async fn get_batch_historical(
        &self,
        requests: &HashMap<String, Vec<i64>>,
        search_width_secs: u32,
    ) -> Result<HashMap<String, Vec<BatchHistoricalPoint>>, BatchHistoricalError> {
        if requests.is_empty() {
            return Ok(HashMap::new());
        }

        let coins_param = serde_json::to_string(requests)
            .map_err(|e| BatchHistoricalError::Decode(e.to_string()))?;
        let url = format!("{}/batchHistorical", self.base_url);

        let response = self
            .http_client
            .get(&url)
            .query(&[
                ("coins", coins_param.as_str()),
                ("searchWidth", &search_width_secs.to_string()),
            ])
            .header("accept", "application/json")
            .send()
            .await
            .map_err(BatchHistoricalError::Transport)?;

        let status = response.status();

        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok())
                .map(Duration::from_secs);
            return Err(BatchHistoricalError::RateLimited { retry_after });
        }

        if !status.is_success() {
            // Never read the body — CloudFlare 429/5xx pages can be huge HTML
            return Err(BatchHistoricalError::Status(status));
        }

        let data: BatchHistoricalResponse = response
            .json()
            .await
            .map_err(|e| BatchHistoricalError::Decode(e.to_string()))?;

        Ok(data
            .coins
            .into_iter()
            .map(|(coin, body)| (coin, body.prices))
            .collect())
    }

    /// Convert a symbol to DeFiLlama asset ID
    ///
    /// For known symbols, returns the coingecko:{id} format.
    /// For unknown symbols with a NEAR contract, returns near:{contract} format.
    pub fn symbol_to_asset_id(symbol: &str, near_contract: Option<&str>) -> Option<String> {
        let upper_symbol = symbol.to_uppercase();

        // Check if we have a known mapping
        if let Some(defillama_id) = get_symbol_map().get(upper_symbol.as_str()) {
            return Some(defillama_id.to_string());
        }

        // For unknown symbols, try to use NEAR contract address if provided
        if let Some(contract) = near_contract {
            return Some(format!("near:{}", contract));
        }

        None
    }
}

#[async_trait]
impl PriceProvider for DeFiLlamaClient {
    fn source_name(&self) -> &'static str {
        "defillama"
    }

    fn translate_asset_id(&self, unified_asset_id: &str) -> Option<String> {
        // The unified_asset_id is lowercase (e.g., "btc", "eth", "usdc")
        // Convert to uppercase for symbol lookup
        let upper = unified_asset_id.to_uppercase();
        get_symbol_map().get(upper.as_str()).map(|s| s.to_string())
    }

    async fn get_price_at_date(
        &self,
        asset_id: &str,
        date: NaiveDate,
    ) -> Result<Option<f64>, Box<dyn std::error::Error + Send + Sync>> {
        // Convert date to Unix timestamp (midnight UTC)
        let datetime = date.and_hms_opt(0, 0, 0).ok_or("Invalid date")?;
        let timestamp = Utc.from_utc_datetime(&datetime).timestamp();

        let url = format!(
            "{}/prices/historical/{}/{}",
            self.base_url, timestamp, asset_id
        );

        tracing::debug!(
            "Fetching price from DeFiLlama: {} for {} (timestamp: {})",
            asset_id,
            date,
            timestamp
        );

        let response = self
            .http_client
            .get(&url)
            .header("accept", "application/json")
            .send()
            .await?;

        let status = response.status();

        if status == reqwest::StatusCode::NOT_FOUND {
            tracing::debug!("DeFiLlama: Asset {} not found", asset_id);
            return Ok(None);
        }

        if !status.is_success() {
            tracing::warn!("DeFiLlama API error for {}: {}", asset_id, status,);
            return Err(format!("DeFiLlama API error: {}", status).into());
        }

        let data: PricesResponse = response.json().await?;

        let price = data.coins.get(asset_id).map(|c| c.price);

        if let Some(p) = price {
            tracing::debug!("DeFiLlama: {} price on {} = ${}", asset_id, date, p);
        } else {
            tracing::debug!("DeFiLlama: No price data for {} on {}", asset_id, date);
        }

        Ok(price)
    }

    async fn get_current_prices(
        &self,
        asset_ids: &[String],
    ) -> Result<HashMap<String, f64>, Box<dyn std::error::Error + Send + Sync>> {
        self.get_current_prices_batch(asset_ids).await
    }

    async fn get_all_historical_prices(
        &self,
        asset_id: &str,
    ) -> Result<HashMap<NaiveDate, f64>, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now();
        let from = now - chrono::Duration::days(HISTORICAL_DAYS);

        // DeFiLlama chart endpoint: /chart/{coins}?start={timestamp}&span={days}&period=1d
        let url = format!(
            "{}/chart/{}?start={}&span={}&period=1d",
            self.base_url,
            asset_id,
            from.timestamp(),
            HISTORICAL_DAYS
        );

        tracing::info!(
            "Fetching all historical prices from DeFiLlama for {} ({} days)",
            asset_id,
            HISTORICAL_DAYS
        );

        let response = self
            .http_client
            .get(&url)
            .header("accept", "application/json")
            .send()
            .await?;

        let status = response.status();

        if status == reqwest::StatusCode::NOT_FOUND {
            tracing::debug!("DeFiLlama: Asset {} not found", asset_id);
            return Ok(HashMap::new());
        }

        if !status.is_success() {
            tracing::warn!(
                "DeFiLlama API error fetching history for {}: {}",
                asset_id,
                status,
            );
            return Err(format!("DeFiLlama API error: {}", status).into());
        }

        let data: ChartResponse = response.json().await?;

        // Convert to daily prices
        let mut daily_prices: HashMap<NaiveDate, f64> = HashMap::new();

        if let Some(chart_data) = data.coins.get(asset_id) {
            for point in &chart_data.prices {
                if let Some(dt) = DateTime::from_timestamp(point.timestamp, 0) {
                    let date = dt.date_naive();
                    // Only keep the first price for each day
                    daily_prices.entry(date).or_insert(point.price);
                }
            }
        }

        tracing::info!(
            "DeFiLlama: Fetched {} daily prices for {}",
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
        let client = DeFiLlamaClient::new(Client::new());
        assert_eq!(client.source_name(), "defillama");
    }

    #[test]
    fn test_translate_asset_id_major_coins() {
        let client = DeFiLlamaClient::new(Client::new());

        assert_eq!(
            client.translate_asset_id("btc"),
            Some("coingecko:bitcoin".to_string())
        );
        assert_eq!(
            client.translate_asset_id("eth"),
            Some("coingecko:ethereum".to_string())
        );
        assert_eq!(
            client.translate_asset_id("sol"),
            Some("coingecko:solana".to_string())
        );
        assert_eq!(
            client.translate_asset_id("near"),
            Some("coingecko:near".to_string())
        );
    }

    #[test]
    fn test_translate_asset_id_stablecoins() {
        let client = DeFiLlamaClient::new(Client::new());

        assert_eq!(
            client.translate_asset_id("usdc"),
            Some("coingecko:usd-coin".to_string())
        );
        assert_eq!(
            client.translate_asset_id("usdt"),
            Some("coingecko:tether".to_string())
        );
        assert_eq!(
            client.translate_asset_id("dai"),
            Some("coingecko:dai".to_string())
        );
    }

    #[test]
    fn test_translate_asset_id_case_insensitive() {
        let client = DeFiLlamaClient::new(Client::new());

        assert_eq!(
            client.translate_asset_id("BTC"),
            Some("coingecko:bitcoin".to_string())
        );
        assert_eq!(
            client.translate_asset_id("Btc"),
            Some("coingecko:bitcoin".to_string())
        );
        assert_eq!(
            client.translate_asset_id("btc"),
            Some("coingecko:bitcoin".to_string())
        );
    }

    #[test]
    fn test_translate_asset_id_unknown() {
        let client = DeFiLlamaClient::new(Client::new());

        assert_eq!(client.translate_asset_id("unknown-token"), None);
        assert_eq!(client.translate_asset_id("random"), None);
    }

    #[test]
    fn test_symbol_to_asset_id_with_near_contract() {
        // Known symbol - ignores contract
        assert_eq!(
            DeFiLlamaClient::symbol_to_asset_id("BTC", Some("btc.omft.near")),
            Some("coingecko:bitcoin".to_string())
        );

        // Unknown symbol - uses contract
        assert_eq!(
            DeFiLlamaClient::symbol_to_asset_id("BLACKDRAGON", Some("blackdragon.tkn.near")),
            Some("near:blackdragon.tkn.near".to_string())
        );

        // Unknown symbol - no contract
        assert_eq!(DeFiLlamaClient::symbol_to_asset_id("UNKNOWN", None), None);
    }

    /// Hits the real DeFiLlama API; run with `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore = "hits the real DeFiLlama API"]
    async fn batch_historical_live_smoke() {
        let client = DeFiLlamaClient::new(Client::new());
        let requests = HashMap::from([
            (
                "coingecko:ethereum".to_string(),
                vec![1719878400, 1719878700, 1719879000],
            ),
            ("coingecko:bitcoin".to_string(), vec![1719878400]),
        ]);

        let prices = client
            .get_batch_historical(&requests, 600)
            .await
            .expect("batchHistorical call failed");

        let eth = &prices["coingecko:ethereum"];
        assert_eq!(eth.len(), 3);
        for point in eth {
            assert!(point.price > 0.0);
            assert!((point.timestamp - 1719878700).unsigned_abs() <= 900);
        }
        assert_eq!(prices["coingecko:bitcoin"].len(), 1);
    }

    #[test]
    fn test_wrapped_variants_map_to_same() {
        let client = DeFiLlamaClient::new(Client::new());

        // BTC variants
        assert_eq!(
            client.translate_asset_id("btc"),
            client.translate_asset_id("wbtc")
        );

        // ETH variants
        assert_eq!(
            client.translate_asset_id("eth"),
            client.translate_asset_id("weth")
        );

        // NEAR variants
        assert_eq!(
            client.translate_asset_id("near"),
            client.translate_asset_id("wnear")
        );
    }
}
