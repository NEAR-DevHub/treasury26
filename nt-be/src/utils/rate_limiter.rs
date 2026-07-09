//! Generalized async rate limiter for background workers and external API clients.
//!
//! A thin, reusable wrapper over [`governor`] (a GCRA token-bucket limiter).
//! Build one limiter per external dependency or shared budget, then call
//! [`RateLimiter::acquire`] before each outbound call. Concurrent callers are
//! serialized to the configured rate regardless of how many worker tasks run,
//! so existing `buffer_unordered` worker pools stay safe without extra plumbing.
//!
//! ```no_run
//! # use nt_be::utils::rate_limiter::RateLimiter;
//! # async fn demo(limiter: RateLimiter) {
//! limiter.acquire().await; // waits until a permit is free
//! // ... make the rate-limited call ...
//! # }
//! ```

use std::num::NonZeroU32;
use std::sync::Arc;

use governor::{DefaultDirectRateLimiter, Quota, RateLimiter as Governor};

/// Cheaply-cloneable, shareable async rate limiter.
///
/// Cloning shares the same underlying token bucket (via [`Arc`]), so placing a
/// single limiter on shared state (e.g. `AppState`) caps every caller against
/// one budget.
#[derive(Clone)]
pub struct RateLimiter {
    name: &'static str,
    inner: Arc<DefaultDirectRateLimiter>,
}

impl RateLimiter {
    /// Build from a raw [`Quota`] when you need full control over the cadence.
    pub fn from_quota(name: &'static str, quota: Quota) -> Self {
        Self {
            name,
            inner: Arc::new(Governor::direct(quota)),
        }
    }

    /// Replenish up to `per_minute` permits each minute, allowing a spike of up
    /// to `burst` permits. `burst` falls back to `per_minute` when zero; both
    /// are clamped to at least 1.
    pub fn per_minute(name: &'static str, per_minute: u32, burst: u32) -> Self {
        let rate = NonZeroU32::new(per_minute.max(1)).expect("rate is clamped to >= 1");
        let burst = NonZeroU32::new(burst).unwrap_or(rate);
        Self::from_quota(name, Quota::per_minute(rate).allow_burst(burst))
    }

    /// Replenish up to `per_second` permits each second (burst equals the rate).
    pub fn per_second(name: &'static str, per_second: u32) -> Self {
        let rate = NonZeroU32::new(per_second.max(1)).expect("rate is clamped to >= 1");
        Self::from_quota(name, Quota::per_second(rate))
    }

    /// Identifier used in logs / metrics.
    pub fn name(&self) -> &'static str {
        self.name
    }

    /// Wait asynchronously until one permit is available, then consume it.
    pub async fn acquire(&self) {
        self.inner.until_ready().await;
    }

    /// Try to consume one permit without waiting; `true` if one was available.
    pub fn try_acquire(&self) -> bool {
        self.inner.check().is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn try_acquire_exhausts_burst_then_refuses() {
        // Replenishes slowly (1/min) but allows an initial burst of 2.
        let limiter = RateLimiter::per_minute("test", 1, 2);
        assert!(limiter.try_acquire(), "first permit within burst");
        assert!(limiter.try_acquire(), "second permit within burst");
        assert!(
            !limiter.try_acquire(),
            "burst exhausted; next permit must wait for replenishment"
        );
    }

    #[test]
    fn clone_shares_one_budget() {
        let a = RateLimiter::per_minute("shared", 1, 1);
        let b = a.clone();
        assert!(a.try_acquire(), "first clone consumes the only permit");
        assert!(
            !b.try_acquire(),
            "second clone sees the same exhausted bucket"
        );
    }
}
