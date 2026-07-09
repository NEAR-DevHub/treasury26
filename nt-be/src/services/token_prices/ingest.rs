//! Minute-by-minute token price ingestion from the chaindefuser tokens API.
//!
//! One request per tick (~49 KB, ETag-aware so unchanged payloads cost a
//! 304 with an empty body), two batched statements: upsert the `tokens`
//! registry and append changed prices to the `token_prices` 5-minute series.
//! Prices that did not move since the last persisted row are skipped, so
//! quiet assets write far fewer than 288 rows/day. Monthly partitions are
//! created one month ahead and retained for historical valuation.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration as StdDuration;

use bigdecimal::BigDecimal;
use chrono::{DateTime, Datelike, Duration, DurationRound, NaiveDate, Timelike, Utc};
use serde::Deserialize;
use sqlx::PgPool;

use super::service::TokenPriceService;
use crate::AppState;

pub const TOKEN_PRICE_INGEST_TICK: StdDuration = StdDuration::from_secs(60);

const TOKENS_API_URL: &str = "https://api-mng-console.chaindefuser.com/api/tokens";
const TOKENS_API_TIMEOUT: StdDuration = StdDuration::from_secs(30);
const TOKEN_PRICE_PERSIST_INTERVAL_MINUTES: u32 = 5;

#[derive(Debug, Deserialize)]
struct TokensApiResponse {
    items: Vec<TokenApiItem>,
}

#[derive(Debug, Deserialize)]
struct TokenApiItem {
    defuse_asset_id: String,
    symbol: String,
    decimals: i16,
    blockchain: String,
    contract_address: Option<String>,
    coingecko_id: Option<String>,
    price: Option<f64>,
    price_updated_at: Option<DateTime<Utc>>,
}

impl TokenApiItem {
    /// Upstream reports missing prices as 0; treat non-positive and
    /// non-finite values as "no price" rather than valuing holdings at 0.
    fn usable_price(&self) -> Option<BigDecimal> {
        let price = self.price?;
        if !price.is_finite() || price <= 0.0 {
            return None;
        }
        // f64 Display gives the shortest round-trip decimal ("1.94", not
        // the exact binary expansion), which is what we want to store.
        BigDecimal::from_str(&price.to_string()).ok()
    }
}

pub struct TokenPriceIngestor {
    http: reqwest::Client,
    pool: PgPool,
    service: Arc<TokenPriceService>,
    etag: Option<String>,
    /// Last price written to `token_prices` per token, for change dedup.
    /// Empty after restart: the first tick writes one row per token.
    last_written: HashMap<String, BigDecimal>,
    partitions_ensured_for: Option<NaiveDate>,
}

#[derive(Debug, Clone)]
pub struct TokenPriceIngestSummary {
    pub tokens_seen: usize,
    pub price_rows_written: usize,
    pub snapshot_tokens: usize,
    pub sampled_prices: bool,
    pub upstream_unchanged: bool,
}

impl TokenPriceIngestor {
    pub fn new(http: reqwest::Client, pool: PgPool, service: Arc<TokenPriceService>) -> Self {
        Self {
            http,
            pool,
            service,
            etag: None,
            last_written: HashMap::new(),
            partitions_ensured_for: None,
        }
    }

    /// One ingest cycle. Failures are logged and swallowed — the next tick
    /// retries, and consumers keep serving the last known prices.
    #[tracing::instrument(level = "info", skip_all, fields(job = "token_price_ingest"))]
    pub async fn tick(&mut self) {
        match self.tick_result().await {
            Ok(summary) if summary.upstream_unchanged => {
                tracing::debug!("tokens API unchanged (304), skipping tick");
            }
            Ok(summary) => {
                if summary.price_rows_written > 0 {
                    tracing::info!(
                        "wrote {} price rows for {} tokens",
                        summary.price_rows_written,
                        summary.tokens_seen
                    );
                }
                tracing::debug!(
                    "refreshed token snapshot ({} tokens)",
                    summary.snapshot_tokens
                );
            }
            Err(e) => tracing::warn!("token price ingest tick failed: {}", e),
        }
    }

    /// One ingest cycle with a structured result for apalis task reporting.
    #[tracing::instrument(level = "info", skip_all, fields(job = "token_price_ingest"))]
    pub async fn tick_result(
        &mut self,
    ) -> Result<TokenPriceIngestSummary, Box<dyn std::error::Error + Send + Sync>> {
        let now = Utc::now();

        self.maintain_partitions(now.date_naive()).await?;

        let items = match self.fetch_tokens().await {
            Ok(Some(items)) => items,
            Ok(None) => {
                return Ok(TokenPriceIngestSummary {
                    tokens_seen: 0,
                    price_rows_written: 0,
                    snapshot_tokens: 0,
                    sampled_prices: false,
                    upstream_unchanged: true,
                });
            }
            Err(e) => return Err(e),
        };

        if items.is_empty() {
            return Err("tokens API returned an empty item list".into());
        }

        self.upsert_registry(&items).await?;

        let minute_at = now
            .duration_trunc(Duration::minutes(1))
            .expect("minute truncation cannot fail");
        let mut price_rows_written = 0usize;
        let mut sampled_prices = false;
        if should_persist_price_sample(minute_at) {
            sampled_prices = true;
            price_rows_written = self.insert_changed_prices(&items, minute_at).await?;
        }

        let snapshot_tokens = self.service.refresh_snapshot().await?;

        Ok(TokenPriceIngestSummary {
            tokens_seen: items.len(),
            price_rows_written,
            snapshot_tokens,
            sampled_prices,
            upstream_unchanged: false,
        })
    }

    /// Fetch the token list; `Ok(None)` means unchanged since last fetch (304).
    async fn fetch_tokens(
        &mut self,
    ) -> Result<Option<Vec<TokenApiItem>>, Box<dyn std::error::Error + Send + Sync>> {
        let mut request = self.http.get(TOKENS_API_URL).timeout(TOKENS_API_TIMEOUT);
        if let Some(etag) = &self.etag {
            request = request.header(reqwest::header::IF_NONE_MATCH, etag);
        }

        let response = request.send().await?;
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(None);
        }
        let response = response.error_for_status()?;

        self.etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);

        let body: TokensApiResponse = response.json().await?;
        Ok(Some(body.items))
    }

    async fn upsert_registry(&self, items: &[TokenApiItem]) -> Result<(), sqlx::Error> {
        let token_ids: Vec<&str> = items.iter().map(|i| i.defuse_asset_id.as_str()).collect();
        let symbols: Vec<&str> = items.iter().map(|i| i.symbol.as_str()).collect();
        let decimals: Vec<i16> = items.iter().map(|i| i.decimals).collect();
        let blockchains: Vec<&str> = items.iter().map(|i| i.blockchain.as_str()).collect();
        let contracts: Vec<Option<&str>> = items
            .iter()
            .map(|i| i.contract_address.as_deref())
            .collect();
        let coingecko_ids: Vec<Option<&str>> =
            items.iter().map(|i| i.coingecko_id.as_deref()).collect();
        let prices: Vec<Option<BigDecimal>> = items.iter().map(|i| i.usable_price()).collect();
        let price_updated_ats: Vec<Option<DateTime<Utc>>> =
            items.iter().map(|i| i.price_updated_at).collect();

        sqlx::query(
            r#"
            INSERT INTO tokens
                (token_id, symbol, decimals, blockchain, contract_address,
                 coingecko_id, price_usd, price_updated_at)
            SELECT * FROM UNNEST(
                $1::text[], $2::text[], $3::int2[], $4::text[], $5::text[],
                $6::text[], $7::numeric[], $8::timestamptz[]
            )
            ON CONFLICT (token_id) DO UPDATE SET
                symbol = EXCLUDED.symbol,
                decimals = EXCLUDED.decimals,
                blockchain = EXCLUDED.blockchain,
                contract_address = EXCLUDED.contract_address,
                coingecko_id = EXCLUDED.coingecko_id,
                price_usd = COALESCE(EXCLUDED.price_usd, tokens.price_usd),
                price_updated_at = COALESCE(EXCLUDED.price_updated_at, tokens.price_updated_at),
                updated_at = NOW()
            "#,
        )
        .bind(&token_ids)
        .bind(&symbols)
        .bind(&decimals)
        .bind(&blockchains)
        .bind(&contracts)
        .bind(&coingecko_ids)
        .bind(&prices)
        .bind(&price_updated_ats)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    /// Append one persisted sample per token whose price moved since the last
    /// written sample. Returns the number of rows written.
    async fn insert_changed_prices(
        &mut self,
        items: &[TokenApiItem],
        minute_at: DateTime<Utc>,
    ) -> Result<usize, sqlx::Error> {
        let mut token_ids: Vec<&str> = Vec::new();
        let mut prices: Vec<BigDecimal> = Vec::new();
        for item in items {
            let Some(price) = item.usable_price() else {
                continue;
            };
            if self.last_written.get(&item.defuse_asset_id) == Some(&price) {
                continue;
            }
            token_ids.push(&item.defuse_asset_id);
            prices.push(price);
        }

        if token_ids.is_empty() {
            return Ok(0);
        }

        sqlx::query(
            r#"
            INSERT INTO token_prices (token_ref, minute_at, price_usd)
            SELECT t.id, $2, u.price_usd
            FROM UNNEST($1::text[], $3::numeric[]) AS u(token_id, price_usd)
            JOIN tokens t ON t.token_id = u.token_id
            ON CONFLICT (token_ref, minute_at) DO NOTHING
            "#,
        )
        .bind(&token_ids)
        .bind(minute_at)
        .bind(&prices)
        .execute(&self.pool)
        .await?;

        let written = token_ids.len();
        for (token_id, price) in token_ids.into_iter().zip(prices) {
            self.last_written.insert(token_id.to_string(), price);
        }
        Ok(written)
    }

    /// Once per month: create partitions for this month and next month.
    async fn maintain_partitions(&mut self, today: NaiveDate) -> Result<(), sqlx::Error> {
        let month = month_start(today);
        if self.partitions_ensured_for == Some(month) {
            return Ok(());
        }

        create_month_partition(&self.pool, month).await?;
        create_month_partition(&self.pool, next_month_start(month)).await?;

        self.partitions_ensured_for = Some(month);
        Ok(())
    }
}

fn should_persist_price_sample(at: DateTime<Utc>) -> bool {
    at.minute()
        .is_multiple_of(TOKEN_PRICE_PERSIST_INTERVAL_MINUTES)
}

fn month_start(day: NaiveDate) -> NaiveDate {
    NaiveDate::from_ymd_opt(day.year(), day.month(), 1).expect("valid month start")
}

fn next_month_start(month: NaiveDate) -> NaiveDate {
    let (year, month) = if month.month() == 12 {
        (month.year() + 1, 1)
    } else {
        (month.year(), month.month() + 1)
    };
    NaiveDate::from_ymd_opt(year, month, 1).expect("valid next month start")
}

fn partition_name(month: NaiveDate) -> String {
    format!("token_prices_p{}", month.format("%Y%m"))
}

async fn create_month_partition(pool: &PgPool, month: NaiveDate) -> Result<(), sqlx::Error> {
    // DDL cannot take bind parameters; both values are chrono-formatted.
    let next_month = next_month_start(month);
    let sql = format!(
        "CREATE TABLE IF NOT EXISTS {} PARTITION OF token_prices \
         FOR VALUES FROM ('{} 00:00:00+00') TO ('{} 00:00:00+00')",
        partition_name(month),
        month,
        next_month,
    );
    sqlx::query(&sql).execute(pool).await?;
    Ok(())
}

/// Background worker: loads the registry snapshot, then ingests prices
/// every minute. Follows the spawn pattern of the other cron workers.
pub fn spawn_token_price_ingest_worker(state: Arc<AppState>) {
    tokio::spawn(async move {
        tracing::info!(
            "Starting token price ingest worker ({:?} tick)",
            TOKEN_PRICE_INGEST_TICK
        );

        if let Err(e) = state.token_price_service.refresh_snapshot().await {
            tracing::warn!("initial token snapshot load failed: {}", e);
        }

        let mut ingestor = TokenPriceIngestor::new(
            state.http_client.clone(),
            state.db_pool.clone(),
            Arc::clone(&state.token_price_service),
        );

        let mut timer = tokio::time::interval(TOKEN_PRICE_INGEST_TICK);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            timer.tick().await;
            ingestor.tick().await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(token_id: &str, price: Option<f64>) -> TokenApiItem {
        TokenApiItem {
            defuse_asset_id: token_id.to_string(),
            symbol: "TKN".to_string(),
            decimals: 18,
            blockchain: "near".to_string(),
            contract_address: None,
            coingecko_id: None,
            price,
            price_updated_at: Some(Utc::now()),
        }
    }

    #[test]
    fn usable_price_rejects_zero_negative_and_non_finite() {
        assert_eq!(item("a", Some(0.0)).usable_price(), None);
        assert_eq!(item("a", Some(-1.5)).usable_price(), None);
        assert_eq!(item("a", Some(f64::NAN)).usable_price(), None);
        assert_eq!(item("a", None).usable_price(), None);
    }

    #[test]
    fn usable_price_keeps_shortest_decimal_representation() {
        assert_eq!(
            item("a", Some(1.94)).usable_price(),
            Some(BigDecimal::from_str("1.94").unwrap())
        );
        assert_eq!(
            item("a", Some(7.075e-9)).usable_price(),
            Some(BigDecimal::from_str("0.000000007075").unwrap())
        );
    }

    #[test]
    fn partition_names_are_month_stamped() {
        let day = NaiveDate::from_ymd_opt(2026, 7, 2).unwrap();
        assert_eq!(partition_name(month_start(day)), "token_prices_p202607");
    }

    #[test]
    fn next_month_start_handles_year_boundary() {
        let december = NaiveDate::from_ymd_opt(2026, 12, 1).unwrap();
        assert_eq!(
            next_month_start(december),
            NaiveDate::from_ymd_opt(2027, 1, 1).unwrap()
        );
    }

    #[test]
    fn should_persist_only_on_five_minute_boundaries() {
        let boundary = DateTime::parse_from_rfc3339("2026-07-02T12:35:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let off_boundary = DateTime::parse_from_rfc3339("2026-07-02T12:36:00Z")
            .unwrap()
            .with_timezone(&Utc);

        assert!(should_persist_price_sample(boundary));
        assert!(!should_persist_price_sample(off_boundary));
    }
}
