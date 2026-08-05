//! On-chain verification of the bronze-derived public balance ledger.
//!
//! RPC is verification-only: the ledger is built purely from bronze, then
//! checked against the chain at the bronze coverage watermark. A DAO's chart
//! becomes servable only after its full-history gate passes (head balances
//! match chain, running balances never negative); ongoing head checks flag
//! drift as staleness without revoking readiness. Bounded native drift is
//! absorbed by explicit reconciliation rebases.

pub mod models;
pub mod repository;
pub mod worker;

pub use worker::BalanceVerifier;
