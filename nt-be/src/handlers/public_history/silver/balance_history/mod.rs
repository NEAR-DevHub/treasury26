//! Balance-complete public ledger projected purely from bronze.
//!
//! Unlike the display-oriented transfer legs, this ledger carries every
//! balance-affecting movement — receipt-attached function-call deposits
//! (wraps, staking), sponsor/system top-ups, FT/MT deltas — with running
//! `balance_before`/`balance_after` per (account, asset). Gold stamps its
//! balance columns from here; on-chain RPC is used only to verify it.

pub mod builder;
pub mod models;
pub mod ownership;
pub mod repository;

pub use builder::BalanceLedgerBuilder;
pub use models::{BalanceLedgerEntry, BalanceLedgerOutcome, LedgerBuildResult};
