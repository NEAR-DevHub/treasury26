//! Authoritative public balance history.
//!
//! Silver supplies asset and event coordinates. Balances are materialized at
//! those coordinates and at the fixed chart grid from archival chain state.
//! Public chart/backfill code in this module intentionally has no legacy
//! balance-ledger fallback.

pub mod block_resolver;
pub mod chart;
pub mod grid;
pub mod jobs;
pub mod models;
pub mod repository;
pub mod worker;

pub use models::SnapshotCycleStats;
pub use worker::{
    project_dirty_public_balance_snapshots, project_public_balance_snapshot_generation,
};
