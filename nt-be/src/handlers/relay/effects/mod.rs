//! Side effects the relayer performs around the core submission: NEP-141
//! registrations for approving votes (before submit), and usage accounting +
//! metrics (after success). [`background`] is the shared fire-and-forget helper.

pub mod accounting;
pub mod background;
pub mod registrations;
