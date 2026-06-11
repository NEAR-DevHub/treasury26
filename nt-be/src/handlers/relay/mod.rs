//! Sponsored relaying of Sputnik DAO proposal actions.
//!
//! The HTTP entry point is [`submit::relay_delegate_action`]. A request is run
//! through a fixed pipeline, one concern per module:
//!
//! 1. [`wallet`] / [`proposal`] — decode the delegate action (direct or
//!    `w_execute_signed`) into the DAO proposal operations we will sponsor.
//! 2. [`access`] — authorize the caller (DAO permissions, identity, gas credits,
//!    receiver allowlist via [`allowlist`]).
//! 3. [`sponsorship`] — bound the sponsored deposit and top up Sputnik storage.
//! 4. [`storage_deposit`] — sponsor-paid NEP-141 registrations for approving votes.
//! 5. [`accounting`] — charge a gas credit, record usage metrics.
//! 6. [`confidential`] — auto-submit confidential intents after an approving vote.

pub mod access;
pub mod accounting;
pub mod allowlist;
pub mod background;
pub mod confidential;
pub mod dto;
pub mod proposal;
pub mod retry;
pub mod sponsor;
pub mod sponsorship;
pub mod sputnik;
pub mod storage_deposit;
pub mod submit;
pub mod wallet;
