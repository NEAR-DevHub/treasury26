//! Sparse, effective-dated public balance history.
//!
//! History is seeded once per DAO from the trusted legacy balance ledger
//! (the seed module is its only sanctioned reader); afterwards balances move
//! forward only, refreshed for event-affected assets at one finalized block
//! per DAO. A snapshot row exists only where a balance changed; charts carry
//! rows forward and price each bucket from the stored price series. Missing
//! history is never represented as zero.

pub mod chart;
pub mod grid;
pub mod jobs;
pub mod models;
pub mod repository;
pub mod seed;
pub mod worker;

pub use worker::project_public_balance_snapshot_generation;
