//! Centralized token registry and minute-level USD price store.
//!
//! One background worker ([`spawn_token_price_ingest_worker`]) polls the
//! chaindefuser tokens API every minute and maintains two tables:
//! `tokens` (registry + latest price) and `token_prices` (minute time
//! series, month-partitioned, keyed on the `tokens.id` int surrogate).
//! All reads go through [`TokenPriceService`], which normalizes the
//! token-id formats used across the codebase to the canonical defuse
//! asset id and resolves them to the surrogate key internally.

mod backfill;
mod ingest;
mod service;
mod usd_backfill;

pub use backfill::{BackfillSummary, HistoricalPriceBackfill};
pub use ingest::{TokenPriceIngestor, spawn_token_price_ingest_worker};
pub use service::{TokenPriceService, TokenRecord, canonicalize_token_id};
pub use usd_backfill::{
    BalanceChangesUsdBackfill, GoldConfidentialUsdBackfill, GoldPublicUsdBackfill,
};
