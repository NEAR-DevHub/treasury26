//! Read seam for token metadata and USD prices.
//!
//! Latest prices are served from an in-memory snapshot of the `tokens`
//! table (refreshed by the ingest worker after every tick), so hot-path
//! valuation never touches the database. Point-in-time prices resolve to
//! the nearest earlier persisted sample in `token_prices`.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use bigdecimal::BigDecimal;
use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;

/// Events at most this old are valued with the in-memory latest price
/// (no DB hit); older events resolve through the minute time series.
const LATEST_PRICE_FRESH_WINDOW: Duration = Duration::minutes(10);

/// One row of the `tokens` registry as held in the in-memory snapshot.
#[derive(Debug, Clone)]
pub struct TokenRecord {
    /// Surrogate key; `token_prices` rows are keyed on this, not the TEXT id.
    pub id: i32,
    pub token_id: String,
    pub symbol: String,
    pub decimals: i16,
    pub blockchain: String,
    pub contract_address: Option<String>,
    pub coingecko_id: Option<String>,
    pub price_usd: Option<BigDecimal>,
    pub price_updated_at: Option<DateTime<Utc>>,
}

#[derive(Default)]
struct TokenSnapshot {
    by_token_id: HashMap<String, TokenRecord>,
    /// lowercased contract address -> canonical token_id
    by_contract: HashMap<String, String>,
}

type TokenSnapshotRow = (
    i32,
    String,
    String,
    i16,
    String,
    Option<String>,
    Option<String>,
    Option<BigDecimal>,
    Option<DateTime<Utc>>,
);

pub struct TokenPriceService {
    pool: PgPool,
    snapshot: RwLock<Arc<TokenSnapshot>>,
}

impl TokenPriceService {
    /// Starts with an empty snapshot; call [`Self::refresh_snapshot`] (the
    /// ingest worker does this on startup and after every tick) to populate.
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            snapshot: RwLock::new(Arc::new(TokenSnapshot::default())),
        }
    }

    /// Reload the in-memory snapshot from the `tokens` table (~200 rows).
    pub async fn refresh_snapshot(&self) -> Result<usize, sqlx::Error> {
        let rows: Vec<TokenSnapshotRow> = sqlx::query_as(
            r#"
            SELECT id, token_id, symbol, decimals, blockchain,
                   contract_address, coingecko_id, price_usd, price_updated_at
            FROM tokens
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        let mut by_token_id = HashMap::with_capacity(rows.len());
        let mut by_contract = HashMap::with_capacity(rows.len());
        for (
            id,
            token_id,
            symbol,
            decimals,
            blockchain,
            contract_address,
            coingecko_id,
            price_usd,
            price_updated_at,
        ) in rows
        {
            if let Some(contract) = &contract_address {
                by_contract.insert(contract.to_lowercase(), token_id.clone());
            }
            by_token_id.insert(
                token_id.clone(),
                TokenRecord {
                    id,
                    token_id,
                    symbol,
                    decimals,
                    blockchain,
                    contract_address,
                    coingecko_id,
                    price_usd,
                    price_updated_at,
                },
            );
        }

        let count = by_token_id.len();
        let snapshot = Arc::new(TokenSnapshot {
            by_token_id,
            by_contract,
        });
        *self.snapshot.write().expect("token snapshot lock poisoned") = snapshot;
        Ok(count)
    }

    fn snapshot(&self) -> Arc<TokenSnapshot> {
        Arc::clone(&self.snapshot.read().expect("token snapshot lock poisoned"))
    }

    /// Resolve any local token-id format to the canonical defuse asset id
    /// present in the registry. Returns None for tokens the registry does
    /// not know (callers fall back to the daily-EOD price path).
    pub fn resolve(&self, raw_token_id: &str) -> Option<String> {
        let candidate = canonicalize_token_id(raw_token_id);
        let snapshot = self.snapshot();
        if snapshot.by_token_id.contains_key(&candidate) {
            return Some(candidate);
        }
        // Bare contract ids that are not NEP-141 on NEAR (e.g. a lowercased
        // EVM address) can still match via the contract-address index.
        snapshot
            .by_contract
            .get(&raw_token_id.to_lowercase())
            .cloned()
    }

    /// Full registry record for a token, any local id format.
    pub fn token(&self, raw_token_id: &str) -> Option<TokenRecord> {
        let token_id = self.resolve(raw_token_id)?;
        self.snapshot().by_token_id.get(&token_id).cloned()
    }

    /// Latest known USD price from the in-memory snapshot. O(1), no DB.
    pub fn latest_price(&self, raw_token_id: &str) -> Option<(BigDecimal, DateTime<Utc>)> {
        let record = self.token(raw_token_id)?;
        Some((record.price_usd?, record.price_updated_at?))
    }

    /// USD price for valuing an event that happened at `at`: fresh events
    /// take the in-memory latest price (no DB hit — the common live-ingest
    /// case), older events (backfills, reprojections) resolve through the
    /// minute series so they are not valued with today's price.
    pub async fn price_for_valuation(
        &self,
        raw_token_id: &str,
        at: DateTime<Utc>,
    ) -> Result<Option<BigDecimal>, sqlx::Error> {
        if Utc::now() - at <= LATEST_PRICE_FRESH_WINDOW
            && let Some((price, _)) = self.latest_price(raw_token_id)
        {
            return Ok(Some(price));
        }
        self.price_at(raw_token_id, at).await
    }

    /// USD price at (or nearest before) a timestamp from the persisted series.
    /// Returns None when the timestamp predates stored samples or the token is
    /// unknown.
    pub async fn price_at(
        &self,
        raw_token_id: &str,
        at: DateTime<Utc>,
    ) -> Result<Option<BigDecimal>, sqlx::Error> {
        let Some(token_ref) = self.token(raw_token_id).map(|t| t.id) else {
            return Ok(None);
        };

        let price: Option<(BigDecimal,)> = sqlx::query_as(
            r#"
            SELECT price_usd
            FROM token_prices
            WHERE token_ref = $1 AND minute_at <= $2
            ORDER BY minute_at DESC
            LIMIT 1
            "#,
        )
        .bind(token_ref)
        .bind(at)
        .fetch_optional(&self.pool)
        .await?;

        Ok(price.map(|(p,)| p))
    }

    /// Batch variant of [`Self::price_at`]: one query for many tokens at the
    /// same timestamp. Keys of the returned map are the raw ids passed in.
    pub async fn prices_at_batch(
        &self,
        raw_token_ids: &[String],
        at: DateTime<Utc>,
    ) -> Result<HashMap<String, BigDecimal>, sqlx::Error> {
        // token_ref -> raw ids that resolved to it
        let mut ref_to_raw: HashMap<i32, Vec<&String>> = HashMap::new();
        for raw in raw_token_ids {
            if let Some(record) = self.token(raw) {
                ref_to_raw.entry(record.id).or_default().push(raw);
            }
        }
        if ref_to_raw.is_empty() {
            return Ok(HashMap::new());
        }

        let token_refs: Vec<i32> = ref_to_raw.keys().copied().collect();
        let rows: Vec<(i32, BigDecimal)> = sqlx::query_as(
            r#"
            SELECT DISTINCT ON (token_ref) token_ref, price_usd
            FROM token_prices
            WHERE token_ref = ANY($1) AND minute_at <= $2
            ORDER BY token_ref, minute_at DESC
            "#,
        )
        .bind(&token_refs)
        .bind(at)
        .fetch_all(&self.pool)
        .await?;

        let mut result = HashMap::new();
        for (token_ref, price) in rows {
            if let Some(raws) = ref_to_raw.get(&token_ref) {
                for raw in raws {
                    result.insert((*raw).clone(), price.clone());
                }
            }
        }
        Ok(result)
    }
}

/// Pure string normalization of the token-id formats found across the DB
/// to a canonical defuse asset id candidate:
/// - `nep141:...` / `nep245:...` (confidential tables) pass through
/// - `near`, NULL-as-`near`, and `staking:<pool>` map to `nep141:wrap.near`
/// - `intents.near:<defuse id>` (public gold/silver) strips the prefix
/// - bare NEP-141 contract ids (`wrap.near`, balance_changes) gain `nep141:`
pub fn canonicalize_token_id(raw: &str) -> String {
    if raw == "near" || raw.starts_with("staking:") {
        return "nep141:wrap.near".to_string();
    }
    if let Some(stripped) = raw.strip_prefix("intents.near:") {
        return stripped.to_string();
    }
    if raw.starts_with("nep141:") || raw.starts_with("nep245:") {
        return raw.to_string();
    }
    format!("nep141:{raw}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalize_native_and_staking_map_to_wnear() {
        assert_eq!(canonicalize_token_id("near"), "nep141:wrap.near");
        assert_eq!(
            canonicalize_token_id("staking:astro-stakers.poolv1.near"),
            "nep141:wrap.near"
        );
    }

    #[test]
    fn canonicalize_strips_intents_prefix() {
        assert_eq!(
            canonicalize_token_id("intents.near:nep141:eth.omft.near"),
            "nep141:eth.omft.near"
        );
        assert_eq!(
            canonicalize_token_id("intents.near:nep245:v2_1.omni.hot.tg:137_abc"),
            "nep245:v2_1.omni.hot.tg:137_abc"
        );
    }

    #[test]
    fn canonicalize_passes_through_defuse_ids() {
        assert_eq!(
            canonicalize_token_id("nep141:wrap.near"),
            "nep141:wrap.near"
        );
        assert_eq!(
            canonicalize_token_id("nep245:v2_1.omni.hot.tg:137_abc"),
            "nep245:v2_1.omni.hot.tg:137_abc"
        );
    }

    #[test]
    fn canonicalize_prefixes_bare_contract_ids() {
        assert_eq!(canonicalize_token_id("wrap.near"), "nep141:wrap.near");
        assert_eq!(
            canonicalize_token_id("usdt.tether-token.near"),
            "nep141:usdt.tether-token.near"
        );
    }
}
