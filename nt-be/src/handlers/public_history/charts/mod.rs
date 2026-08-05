//! Public balance charts read from gold balance columns.
//!
//! Gold rows carry absolute `balance_before`/`balance_after` stamped from the
//! bronze-derived `silver_balance_history` ledger, so the chart needs no
//! separate snapshot store: per asset, the latest balance-bearing gold leg at
//! or before each bucket is carried forward and priced. Readiness gates on
//! complete backfill, a ready gold projection, and a passed on-chain
//! verification — missing history is never served as zero.

pub mod chart;
pub mod grid;
pub mod models;
pub mod repository;
