//! Historical token-price backfill from DefiLlama into `token_prices`.
//!
//! Fills the 5-minute price series for exactly the (token, bucket) pairs
//! gold public/confidential history rows need: 100 events for one token inside
//! one bucket cost one price point. Discovery is a single anti-join against
//! `token_prices` (plus a persistent miss list), so every run is idempotent
//! and self-resuming — the database is the cursor. Points are grouped by
//! `tokens.coingecko_id` (bridged variants share one upstream price), packed
//! ~450 to a `/batchHistorical` call, fetched by a small concurrent pool
//! behind the shared per-minute DeFiLlama rate limiter, and inserted with
//! `ON CONFLICT DO NOTHING`.

use std::collections::{BTreeMap, HashMap};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use bigdecimal::BigDecimal;
use chrono::{DateTime, TimeZone, Utc};
use futures::StreamExt;
use sqlx::PgPool;

use super::ingest::{create_month_partition, month_start, next_month_start, partition_name};
use super::service::{TokenPriceService, canonicalize_token_id};
use crate::services::defillama::{BatchHistoricalError, BatchHistoricalPoint, DeFiLlamaClient};
use crate::utils::rate_limiter::RateLimiter;

/// Max (coin, timestamp) points per /batchHistorical call; ~450 points keep
/// the encoded URL under CloudFront's 8 KB cap (measured ~6.5 KB).
const MAX_POINTS_PER_CALL: usize = 450;
/// Concurrent in-flight /batchHistorical calls. At ~14 s per call this is
/// ~26 calls/min — latency, not the shared rate limiter, binds throughput.
const BATCH_CONCURRENCY: usize = 6;
/// How far (either side) DeFiLlama may look for the nearest sample. Thin or
/// old coins often have only hourly/daily samples; `price_at` consumers
/// already accept nearest-earlier staleness, so a ≤4 h-away price stored at
/// the bucket beats a permanent miss.
const SEARCH_WIDTH_SECS: u32 = 14_400;
/// Successful-call attempts before a dataless point is permanently skipped.
const MAX_MISS_ATTEMPTS: i32 = 3;
/// Points fetched per run; the hourly cron drains the remainder.
const MAX_POINTS_PER_RUN: i64 = 200_000;
/// HTTP attempts (incl. the first) per batch before dropping it for this run.
const MAX_ATTEMPTS: u32 = 4;
/// Coins per /prices/current probe when registering tokens the chaindefuser
/// registry does not know (long `near:{contract}` ids keep URLs short).
const PROBE_CHUNK: usize = 50;
/// Fallback backoff when a 429 omits a usable `Retry-After` header.
const RATE_LIMIT_DEFAULT_BACKOFF: Duration = Duration::from_secs(6);
/// Cap on any single backoff so a hostile `Retry-After` can't stall a worker.
const RATE_LIMIT_MAX_BACKOFF: Duration = Duration::from_secs(30);

const GOLD_RAW_IDS_SQL: &str = r#"
    SELECT DISTINCT token_in
    FROM gold_public_history_events
    WHERE token_in IS NOT NULL
    UNION
    SELECT DISTINCT token_out
    FROM gold_public_history_events
    WHERE token_out IS NOT NULL
    UNION
    SELECT DISTINCT origin_asset
    FROM gold_confidential_history_events
    WHERE origin_asset IS NOT NULL
    UNION
    SELECT DISTINCT destination_asset
    FROM gold_confidential_history_events
"#;

const GOLD_MISSING_PAIRS_SQL: &str = r#"
    WITH mapping(raw_token_id, token_ref) AS (
        SELECT * FROM UNNEST($1::text[], $2::int4[])
    ),
    sources(raw_token_id, at) AS (
        SELECT token_in, event_time
        FROM gold_public_history_events
        WHERE token_in IS NOT NULL
        UNION ALL
        SELECT token_out, event_time
        FROM gold_public_history_events
        WHERE token_out IS NOT NULL
        UNION ALL
        SELECT origin_asset, COALESCE(proposal_executed_at, quote_created_at)
        FROM gold_confidential_history_events
        WHERE origin_asset IS NOT NULL
        UNION ALL
        SELECT destination_asset, COALESCE(proposal_executed_at, quote_created_at)
        FROM gold_confidential_history_events
    ),
    needed AS (
        SELECT DISTINCT m.token_ref,
               to_timestamp(floor(extract(epoch FROM s.at) / 300) * 300) AS minute_at
        FROM sources s
        JOIN mapping m ON m.raw_token_id = s.raw_token_id
        WHERE s.at IS NOT NULL
    )
    SELECT n.token_ref, n.minute_at
    FROM needed n
    LEFT JOIN token_prices tp
           ON tp.token_ref = n.token_ref AND tp.minute_at = n.minute_at
    WHERE tp.token_ref IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM token_price_backfill_misses miss
          WHERE miss.token_ref = n.token_ref
            AND miss.minute_at = n.minute_at
            AND miss.attempts >= $3
      )
    ORDER BY n.minute_at
    LIMIT $4
"#;

pub struct HistoricalPriceBackfill {
    client: DeFiLlamaClient,
    pool: PgPool,
    service: Arc<TokenPriceService>,
    limiter: RateLimiter,
}

#[derive(Debug, Default)]
pub struct BackfillSummary {
    /// Missing (token_ref, bucket) pairs picked up this run (post-LIMIT).
    pub pairs_missing: usize,
    /// Deduped (coin, timestamp) points actually requested upstream.
    pub points_requested: usize,
    pub calls_made: usize,
    pub rows_inserted: u64,
    pub misses_recorded: u64,
    /// Distinct gold history token ids skipped (unknown to the registry
    /// or without a coingecko id).
    pub tokens_skipped: usize,
    /// True when this run saw fewer missing pairs than its cap, i.e. the
    /// backlog is drained and the next run only pays one discovery query.
    pub exhausted: bool,
}

impl std::fmt::Display for BackfillSummary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "missing={} points={} calls={} inserted={} misses={} skipped_tokens={} exhausted={}",
            self.pairs_missing,
            self.points_requested,
            self.calls_made,
            self.rows_inserted,
            self.misses_recorded,
            self.tokens_skipped,
            self.exhausted
        )
    }
}

/// Work for one run: per DeFiLlama coin, the requested buckets and, per
/// bucket, every token_ref that needs the price (tokens sharing a
/// coingecko_id collapse into one coin here and fan back out on insert).
struct CoinWork {
    coins: HashMap<String, BTreeMap<i64, Vec<i32>>>,
    pairs: usize,
    tokens_skipped: usize,
}

/// One packed /batchHistorical request.
struct BatchRequest {
    /// coin -> sorted requested unix timestamps
    coins: HashMap<String, Vec<i64>>,
    points: usize,
}

/// Outcome of one batch after its rows were persisted.
#[derive(Default)]
struct BatchOutcome {
    rows_inserted: u64,
    misses_recorded: u64,
    call_succeeded: bool,
}

impl HistoricalPriceBackfill {
    pub fn new(
        http: reqwest::Client,
        base_url: String,
        pool: PgPool,
        service: Arc<TokenPriceService>,
        limiter: RateLimiter,
    ) -> Self {
        Self {
            client: DeFiLlamaClient::with_base_url(http, base_url),
            pool,
            service,
            limiter,
        }
    }

    /// One backfill run, bounded by [`MAX_POINTS_PER_RUN`]. Idempotent:
    /// re-running continues from whatever is still missing.
    pub async fn run(&self) -> Result<BackfillSummary, Box<dyn std::error::Error + Send + Sync>> {
        self.ensure_partitions().await?;

        let work = self.discover_missing().await?;
        let mut summary = BackfillSummary {
            pairs_missing: work.pairs,
            tokens_skipped: work.tokens_skipped,
            exhausted: (work.pairs as i64) < MAX_POINTS_PER_RUN,
            ..Default::default()
        };
        if work.coins.is_empty() {
            return Ok(summary);
        }

        let batches = pack_batches(&work.coins, MAX_POINTS_PER_CALL);
        summary.points_requested = batches.iter().map(|b| b.points).sum();
        let total_batches = batches.len();

        // Each batch persists its own rows as soon as its fetch completes, so
        // progress is incremental and a crash loses at most the in-flight
        // batches — the next run's anti-join picks up whatever is left.
        let outcomes: Vec<BatchOutcome> = futures::stream::iter(
            batches
                .into_iter()
                .map(|batch| self.process_batch(batch, &work)),
        )
        .buffer_unordered(BATCH_CONCURRENCY)
        .collect()
        .await;

        for outcome in &outcomes {
            summary.calls_made += usize::from(outcome.call_succeeded);
            summary.rows_inserted += outcome.rows_inserted;
            summary.misses_recorded += outcome.misses_recorded;
        }
        tracing::info!(
            batches = total_batches,
            calls_ok = summary.calls_made,
            rows_inserted = summary.rows_inserted,
            misses = summary.misses_recorded,
            "token price backfill run finished"
        );
        Ok(summary)
    }

    /// Create `token_prices` partitions from the first gold history month
    /// through the current month, skipping months that already have one.
    async fn ensure_partitions(&self) -> Result<(), sqlx::Error> {
        let earliest: Option<(Option<DateTime<Utc>>,)> = sqlx::query_as(
            r#"
            SELECT MIN(at)
            FROM (
                SELECT MIN(event_time) AS at
                FROM gold_public_history_events
                UNION ALL
                SELECT MIN(COALESCE(proposal_executed_at, quote_created_at)) AS at
                FROM gold_confidential_history_events
            ) earliest
            "#,
        )
        .fetch_optional(&self.pool)
        .await?;
        let Some((Some(earliest),)) = earliest else {
            return Ok(());
        };

        let existing: Vec<(String,)> = sqlx::query_as(
            r#"
            SELECT c.relname
            FROM pg_inherits i
            JOIN pg_class c ON c.oid = i.inhrelid
            JOIN pg_class p ON p.oid = i.inhparent
            WHERE p.relname = 'token_prices'
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        let existing: std::collections::HashSet<String> =
            existing.into_iter().map(|(name,)| name).collect();

        let last = month_start(Utc::now().date_naive());
        let mut month = month_start(earliest.date_naive());
        while month <= last {
            if !existing.contains(&partition_name(month)) {
                create_month_partition(&self.pool, month).await?;
            }
            month = next_month_start(month);
        }
        Ok(())
    }

    /// Discover missing (token_ref, bucket) pairs and group them by coin.
    async fn discover_missing(&self) -> Result<CoinWork, Box<dyn std::error::Error + Send + Sync>> {
        // The boot-time push can run before the ingest worker's first tick;
        // resolving against an empty registry would silently skip everything.
        if self.service.refresh_snapshot().await? == 0 {
            return Err(
                "tokens registry is empty; waiting for the ingest worker's first tick".into(),
            );
        }

        let raw_ids: Vec<(String,)> = sqlx::query_as(GOLD_RAW_IDS_SQL)
            .fetch_all(&self.pool)
            .await?;

        let mut unresolved: Vec<String> = Vec::new();
        let mut resolvable: Vec<String> = Vec::new();
        for (raw,) in raw_ids {
            if self.service.token(&raw).is_some() {
                resolvable.push(raw);
            } else {
                unresolved.push(raw);
            }
        }

        // Second chance for tokens the chaindefuser registry does not know:
        // DeFiLlama prices many long-tail NEAR contracts via `near:{contract}`
        // and returns symbol/decimals, enough to register them locally.
        let registered = self.register_unknown_tokens(&unresolved).await;
        if !registered.is_empty() {
            self.service.refresh_snapshot().await?;
        }

        let mut mapping_raw: Vec<String> = Vec::new();
        let mut mapping_ref: Vec<i32> = Vec::new();
        let mut ref_to_coin: HashMap<i32, String> = HashMap::new();
        let mut no_coingecko: Vec<String> = Vec::new();
        let mut skipped_unresolved: Vec<String> = Vec::new();
        for raw in resolvable.into_iter().chain(unresolved) {
            let Some(record) = self.service.token(&raw) else {
                skipped_unresolved.push(raw);
                continue;
            };
            let coin = match (&record.coingecko_id, &record.contract_address) {
                (Some(coingecko_id), _) => format!("coingecko:{coingecko_id}"),
                // Self-registered long-tail tokens carry no coingecko id;
                // price them the same way they were probed.
                (None, Some(contract)) if record.blockchain == "near" => {
                    format!("near:{contract}")
                }
                _ => {
                    no_coingecko.push(raw);
                    continue;
                }
            };
            ref_to_coin.insert(record.id, coin);
            mapping_raw.push(raw);
            mapping_ref.push(record.id);
        }
        let tokens_skipped = skipped_unresolved.len() + no_coingecko.len();
        if !skipped_unresolved.is_empty() {
            tracing::warn!(
                "token price backfill: {} gold history token ids unknown to both the registry and DeFiLlama: {:?}",
                skipped_unresolved.len(),
                skipped_unresolved
            );
        }
        if !no_coingecko.is_empty() {
            tracing::warn!(
                "token price backfill: {} tokens have no usable DeFiLlama id: {:?}",
                no_coingecko.len(),
                no_coingecko
            );
        }
        if mapping_raw.is_empty() {
            return Ok(CoinWork {
                coins: HashMap::new(),
                pairs: 0,
                tokens_skipped,
            });
        }

        let missing: Vec<(i32, DateTime<Utc>)> = sqlx::query_as(GOLD_MISSING_PAIRS_SQL)
            .bind(&mapping_raw)
            .bind(&mapping_ref)
            .bind(MAX_MISS_ATTEMPTS)
            .bind(MAX_POINTS_PER_RUN)
            .fetch_all(&self.pool)
            .await?;

        let pairs = missing.len();
        let mut coins: HashMap<String, BTreeMap<i64, Vec<i32>>> = HashMap::new();
        for (token_ref, minute_at) in missing {
            let coin = ref_to_coin
                .get(&token_ref)
                .expect("every mapped token_ref has a coin")
                .clone();
            coins
                .entry(coin)
                .or_default()
                .entry(minute_at.timestamp())
                .or_default()
                .push(token_ref);
        }
        Ok(CoinWork {
            coins,
            pairs,
            tokens_skipped,
        })
    }

    /// Try to register gold history tokens the chaindefuser registry does
    /// not know, using DeFiLlama's `near:{contract}` current-price probe for
    /// symbol/decimals. Returns the raw ids that now resolve. Probe failures
    /// are logged and skipped — unknown tokens are retried next run.
    async fn register_unknown_tokens(&self, unresolved: &[String]) -> Vec<String> {
        // Only bare NEP-141 contracts have a `near:{contract}` representation.
        let candidates: Vec<(&String, String)> = unresolved
            .iter()
            .filter_map(|raw| {
                canonicalize_token_id(raw)
                    .strip_prefix("nep141:")
                    .map(|contract| (raw, contract.to_string()))
            })
            .collect();

        let mut registered: Vec<String> = Vec::new();
        for chunk in candidates.chunks(PROBE_CHUNK) {
            let coin_ids: Vec<String> = chunk
                .iter()
                .map(|(_, contract)| format!("near:{contract}"))
                .collect();

            self.limiter.acquire().await;
            let coins = match self.client.get_current_coins(&coin_ids).await {
                Ok(coins) => coins,
                Err(e) => {
                    tracing::warn!("DeFiLlama probe for unknown tokens failed: {}", e);
                    continue;
                }
            };

            let mut token_ids: Vec<String> = Vec::new();
            let mut symbols: Vec<String> = Vec::new();
            let mut decimals: Vec<i16> = Vec::new();
            let mut contracts: Vec<&str> = Vec::new();
            let mut prices: Vec<Option<BigDecimal>> = Vec::new();
            let mut price_ats: Vec<Option<DateTime<Utc>>> = Vec::new();
            for (raw, contract) in chunk {
                let Some(coin) = coins.get(&format!("near:{contract}")) else {
                    continue;
                };
                let (Some(symbol), Some(coin_decimals)) = (&coin.symbol, coin.decimals) else {
                    continue;
                };
                token_ids.push(format!("nep141:{contract}"));
                symbols.push(symbol.clone());
                decimals.push(coin_decimals);
                contracts.push(contract);
                prices.push(usable_price(coin.price));
                price_ats.push(
                    coin.timestamp
                        .and_then(|ts| Utc.timestamp_opt(ts, 0).single()),
                );
                registered.push((*raw).clone());
            }
            if token_ids.is_empty() {
                continue;
            }

            let result = sqlx::query(
                r#"
                INSERT INTO tokens
                    (token_id, symbol, decimals, blockchain, contract_address,
                     price_usd, price_updated_at)
                SELECT token_id, symbol, decimals, 'near', contract_address,
                       price_usd, price_updated_at
                FROM UNNEST($1::text[], $2::text[], $3::int2[], $4::text[],
                            $5::numeric[], $6::timestamptz[])
                    AS u(token_id, symbol, decimals, contract_address,
                         price_usd, price_updated_at)
                ON CONFLICT (token_id) DO UPDATE SET
                    price_usd = COALESCE(EXCLUDED.price_usd, tokens.price_usd),
                    price_updated_at = COALESCE(EXCLUDED.price_updated_at, tokens.price_updated_at),
                    updated_at = NOW()
                "#,
            )
            .bind(&token_ids)
            .bind(&symbols)
            .bind(&decimals)
            .bind(&contracts)
            .bind(&prices)
            .bind(&price_ats)
            .execute(&self.pool)
            .await;
            if let Err(e) = result {
                tracing::warn!("registering DeFiLlama-priced tokens failed: {}", e);
            }
        }

        if !registered.is_empty() {
            tracing::info!(
                "registered {} long-tail tokens via DeFiLlama near:contract probe",
                registered.len()
            );
        }
        registered
    }

    /// Fetch one packed batch, retrying 429s (honoring Retry-After) and
    /// transient transport errors, then persist its prices and misses. A
    /// batch that exhausts its attempts is dropped for this run — the next
    /// run's anti-join re-surfaces it.
    async fn process_batch(&self, batch: BatchRequest, work: &CoinWork) -> BatchOutcome {
        let mut outcome = BatchOutcome::default();

        let response = 'attempts: {
            for attempt in 1..=MAX_ATTEMPTS {
                self.limiter.acquire().await;
                match self
                    .client
                    .get_batch_historical(&batch.coins, SEARCH_WIDTH_SECS)
                    .await
                {
                    Ok(response) => break 'attempts Some(response),
                    Err(BatchHistoricalError::RateLimited { retry_after })
                        if attempt < MAX_ATTEMPTS =>
                    {
                        let backoff = retry_after
                            .unwrap_or(RATE_LIMIT_DEFAULT_BACKOFF)
                            .min(RATE_LIMIT_MAX_BACKOFF);
                        tracing::warn!(
                            attempt,
                            backoff_secs = backoff.as_secs(),
                            "DeFiLlama rate limited (429); backing off and retrying"
                        );
                        tokio::time::sleep(backoff).await;
                    }
                    Err(BatchHistoricalError::Transport(e)) if attempt < MAX_ATTEMPTS => {
                        let backoff = Duration::from_millis(200 * 2u64.pow(attempt - 1));
                        tracing::warn!(
                            attempt,
                            "DeFiLlama transport error, retrying in {:?}: {}",
                            backoff,
                            e
                        );
                        tokio::time::sleep(backoff).await;
                    }
                    Err(e) => {
                        tracing::warn!(points = batch.points, "dropping batch for this run: {}", e);
                        break 'attempts None;
                    }
                }
            }
            None
        };
        let Some(response) = response else {
            return outcome;
        };
        outcome.call_succeeded = true;

        let mut price_rows: Vec<(i32, DateTime<Utc>, BigDecimal)> = Vec::new();
        let mut miss_rows: Vec<(i32, DateTime<Utc>)> = Vec::new();
        let empty: Vec<BatchHistoricalPoint> = Vec::new();
        for (coin, requested) in &batch.coins {
            let returned = response.get(coin).unwrap_or(&empty);
            for (bucket, price) in match_points(requested, returned, i64::from(SEARCH_WIDTH_SECS)) {
                let Some(minute_at) = bucket_to_datetime(bucket) else {
                    continue;
                };
                match price.and_then(usable_price) {
                    Some(price) => {
                        for &token_ref in requested_refs(work, coin, bucket) {
                            price_rows.push((token_ref, minute_at, price.clone()));
                        }
                    }
                    None => {
                        for &token_ref in requested_refs(work, coin, bucket) {
                            miss_rows.push((token_ref, minute_at));
                        }
                    }
                }
            }
        }

        match self.insert_prices(&price_rows).await {
            Ok(inserted) => outcome.rows_inserted = inserted,
            Err(e) => tracing::warn!("backfill price insert failed: {}", e),
        }
        match self.record_misses(&miss_rows).await {
            Ok(recorded) => outcome.misses_recorded = recorded,
            Err(e) => tracing::warn!("backfill miss insert failed: {}", e),
        }
        tracing::info!(
            points = batch.points,
            rows_inserted = outcome.rows_inserted,
            misses = outcome.misses_recorded,
            "token price backfill batch done"
        );
        outcome
    }

    async fn insert_prices(
        &self,
        rows: &[(i32, DateTime<Utc>, BigDecimal)],
    ) -> Result<u64, sqlx::Error> {
        if rows.is_empty() {
            return Ok(0);
        }
        let token_refs: Vec<i32> = rows.iter().map(|r| r.0).collect();
        let minutes: Vec<DateTime<Utc>> = rows.iter().map(|r| r.1).collect();
        let prices: Vec<BigDecimal> = rows.iter().map(|r| r.2.clone()).collect();

        let result = sqlx::query(
            r#"
            INSERT INTO token_prices (token_ref, minute_at, price_usd)
            SELECT * FROM UNNEST($1::int4[], $2::timestamptz[], $3::numeric[])
            ON CONFLICT (token_ref, minute_at) DO NOTHING
            "#,
        )
        .bind(&token_refs)
        .bind(&minutes)
        .bind(&prices)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    async fn record_misses(&self, rows: &[(i32, DateTime<Utc>)]) -> Result<u64, sqlx::Error> {
        if rows.is_empty() {
            return Ok(0);
        }
        let token_refs: Vec<i32> = rows.iter().map(|r| r.0).collect();
        let minutes: Vec<DateTime<Utc>> = rows.iter().map(|r| r.1).collect();

        let result = sqlx::query(
            r#"
            INSERT INTO token_price_backfill_misses (token_ref, minute_at)
            SELECT * FROM UNNEST($1::int4[], $2::timestamptz[])
            ON CONFLICT (token_ref, minute_at) DO UPDATE
                SET attempts = token_price_backfill_misses.attempts + 1,
                    last_attempt_at = NOW()
            "#,
        )
        .bind(&token_refs)
        .bind(&minutes)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }
}

#[allow(dead_code)]
fn assert_run_future_is_send(backfill: &'static HistoricalPriceBackfill) {
    fn check<T: Send>(_: T) {}
    check(backfill.run());
}

fn bucket_to_datetime(bucket: i64) -> Option<DateTime<Utc>> {
    Utc.timestamp_opt(bucket, 0).single()
}

fn requested_refs<'a>(work: &'a CoinWork, coin: &str, bucket: i64) -> &'a [i32] {
    work.coins
        .get(coin)
        .and_then(|buckets| buckets.get(&bucket))
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// Reject upstream junk the same way the ingest path does, and convert via
/// the shortest-round-trip decimal representation.
fn usable_price(price: f64) -> Option<BigDecimal> {
    if !price.is_finite() || price <= 0.0 {
        return None;
    }
    BigDecimal::from_str(&price.to_string()).ok()
}

/// Greedily pack (coin, bucket) points into batches of at most `max_points`.
/// A single coin's timestamps may split across batches (verified fine with
/// the upstream API). Deterministic: coins in sorted order.
fn pack_batches(
    coins: &HashMap<String, BTreeMap<i64, Vec<i32>>>,
    max_points: usize,
) -> Vec<BatchRequest> {
    let mut sorted: Vec<(&String, &BTreeMap<i64, Vec<i32>>)> = coins.iter().collect();
    sorted.sort_by_key(|(coin, _)| coin.as_str());

    let mut batches: Vec<BatchRequest> = Vec::new();
    let mut current = BatchRequest {
        coins: HashMap::new(),
        points: 0,
    };
    for (coin, buckets) in sorted {
        for bucket in buckets.keys() {
            if current.points == max_points {
                batches.push(std::mem::replace(
                    &mut current,
                    BatchRequest {
                        coins: HashMap::new(),
                        points: 0,
                    },
                ));
            }
            current.coins.entry(coin.clone()).or_default().push(*bucket);
            current.points += 1;
        }
    }
    if current.points > 0 {
        batches.push(current);
    }
    batches
}

/// Pair each requested timestamp with the nearest returned sample within
/// `width` seconds; `None` marks a dataless point. Handles fewer returned
/// samples than requested and two adjacent buckets matching the same sample.
fn match_points(
    requested: &[i64],
    returned: &[BatchHistoricalPoint],
    width: i64,
) -> Vec<(i64, Option<f64>)> {
    let mut samples: Vec<(i64, f64)> = returned.iter().map(|p| (p.timestamp, p.price)).collect();
    samples.sort_by_key(|(ts, _)| *ts);

    requested
        .iter()
        .map(|&ts| {
            let idx = samples.partition_point(|(sample_ts, _)| *sample_ts < ts);
            let after = samples.get(idx);
            let before = idx.checked_sub(1).and_then(|i| samples.get(i));
            let nearest = match (before, after) {
                (Some(b), Some(a)) => Some(if ts - b.0 <= a.0 - ts { b } else { a }),
                (Some(b), None) => Some(b),
                (None, Some(a)) => Some(a),
                (None, None) => None,
            };
            let price = nearest
                .filter(|(sample_ts, _)| (sample_ts - ts).abs() <= width)
                .map(|(_, price)| *price);
            (ts, price)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(timestamp: i64, price: f64) -> BatchHistoricalPoint {
        BatchHistoricalPoint {
            timestamp,
            price,
            confidence: Some(0.99),
        }
    }

    fn work(entries: &[(&str, &[i64])]) -> HashMap<String, BTreeMap<i64, Vec<i32>>> {
        entries
            .iter()
            .map(|(coin, buckets)| {
                (
                    coin.to_string(),
                    buckets.iter().map(|&b| (b, vec![1])).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn pack_batches_respects_point_cap() {
        let buckets: Vec<i64> = (0..1000).map(|i| i * 300).collect();
        let batches = pack_batches(&work(&[("coingecko:ethereum", &buckets)]), 450);

        assert_eq!(batches.len(), 3);
        assert_eq!(
            batches.iter().map(|b| b.points).collect::<Vec<_>>(),
            vec![450, 450, 100]
        );
        let total: usize = batches
            .iter()
            .flat_map(|b| b.coins.values())
            .map(Vec::len)
            .sum();
        assert_eq!(total, 1000);
    }

    #[test]
    fn pack_batches_merges_small_coins_and_is_deterministic() {
        let a: Vec<i64> = (0..10).map(|i| i * 300).collect();
        let b: Vec<i64> = (0..20).map(|i| i * 300).collect();
        let coins = work(&[("coingecko:aave", &a), ("coingecko:bitcoin", &b)]);

        let batches = pack_batches(&coins, 450);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].points, 30);
        assert_eq!(batches[0].coins.len(), 2);

        let again = pack_batches(&coins, 450);
        assert_eq!(
            again[0].coins["coingecko:aave"],
            batches[0].coins["coingecko:aave"]
        );
    }

    #[test]
    fn match_points_picks_nearest_sample() {
        let requested = [1000, 2000];
        let returned = [point(940, 1.0), point(2090, 2.0)];

        let matched = match_points(&requested, &returned, 14_400);
        assert_eq!(matched, vec![(1000, Some(1.0)), (2000, Some(2.0))]);
    }

    #[test]
    fn match_points_rejects_samples_outside_width() {
        let requested = [1000];
        let returned = [point(1000 + 14_401, 1.0)];

        assert_eq!(
            match_points(&requested, &returned, 14_400),
            vec![(1000, None)]
        );
    }

    #[test]
    fn match_points_handles_fewer_returned_and_shared_samples() {
        // Three buckets, one sample: adjacent buckets share it, the far one misses.
        let requested = [1000, 1300, 100_000];
        let returned = [point(1100, 5.0)];

        let matched = match_points(&requested, &returned, 14_400);
        assert_eq!(
            matched,
            vec![(1000, Some(5.0)), (1300, Some(5.0)), (100_000, None)]
        );
    }

    #[test]
    fn match_points_empty_response_is_all_misses() {
        assert_eq!(
            match_points(&[1000, 2000], &[], 14_400),
            vec![(1000, None), (2000, None)]
        );
    }

    #[test]
    fn usable_price_rejects_junk() {
        assert_eq!(usable_price(0.0), None);
        assert_eq!(usable_price(-1.0), None);
        assert_eq!(usable_price(f64::NAN), None);
        assert_eq!(
            usable_price(7.075e-9),
            Some(BigDecimal::from_str("0.000000007075").unwrap())
        );
    }

    #[test]
    fn raw_id_discovery_reads_public_and_confidential_gold_tokens() {
        assert!(GOLD_RAW_IDS_SQL.contains("token_in"));
        assert!(GOLD_RAW_IDS_SQL.contains("token_out"));
        assert!(GOLD_RAW_IDS_SQL.contains("origin_asset"));
        assert!(GOLD_RAW_IDS_SQL.contains("destination_asset"));
        assert!(GOLD_RAW_IDS_SQL.contains("gold_public_history_events"));
        assert!(GOLD_RAW_IDS_SQL.contains("gold_confidential_history_events"));
        assert!(!GOLD_RAW_IDS_SQL.contains("balance_changes"));
    }

    #[test]
    fn missing_pair_discovery_uses_gold_timestamps_and_dedupes_buckets() {
        assert!(GOLD_MISSING_PAIRS_SQL.contains("SELECT DISTINCT m.token_ref"));
        assert!(GOLD_MISSING_PAIRS_SQL.contains("event_time"));
        assert!(
            GOLD_MISSING_PAIRS_SQL.contains("COALESCE(proposal_executed_at, quote_created_at)")
        );
        assert!(GOLD_MISSING_PAIRS_SQL.contains("floor(extract(epoch FROM s.at) / 300) * 300"));
        assert!(GOLD_MISSING_PAIRS_SQL.contains("LEFT JOIN token_prices"));
        assert!(GOLD_MISSING_PAIRS_SQL.contains("token_price_backfill_misses"));
        assert!(!GOLD_MISSING_PAIRS_SQL.contains("balance_changes"));
    }

    #[test]
    fn bucket_math_floors_to_five_minutes() {
        // Mirrors the SQL floor(epoch/300)*300 bucketing.
        let bucket = |epoch: i64| (epoch / 300) * 300;
        assert_eq!(bucket(1719878400), 1719878400); // exact boundary
        assert_eq!(bucket(1719878400 + 299), 1719878400); // 12:04:59 -> 12:00
        assert_eq!(bucket(1719878400 + 300), 1719878700); // 12:05:00 -> 12:05
    }
}
