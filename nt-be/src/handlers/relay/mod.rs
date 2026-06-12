//! Sponsored relaying of Sputnik DAO proposal actions.
//!
//! The HTTP entry point is [`submit::relay_delegate_action`], which runs a request
//! through a fixed pipeline, grouped by concern:
//!
//! - [`parse`] — the relay request types and the parser that decodes a delegate
//!   action (direct or `w_execute_signed`) into the homogeneous DAO operation.
//! - [`access`] — authorize the caller (identity, DAO permissions, billing).
//! - [`sponsor`] — the relayer: signing/sending ([`sponsor::Sponsor`]), retry, and
//!   the spend policy ([`sponsor::policy`]: limits, tier, storage top-up).
//! - [`effects`] — side effects: NEP-141 registrations, usage accounting, metrics.
//! - [`confidential`] — auto-submit confidential intents after an approving vote.

pub mod access;
pub mod confidential;
pub mod effects;
pub mod parse;
pub mod sponsor;
pub mod submit;
