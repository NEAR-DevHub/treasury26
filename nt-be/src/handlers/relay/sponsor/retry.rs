//! Small bounded-retry helper for transient failures (RPC blips, network errors).

use std::{fmt::Display, future::Future, time::Duration};

#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub max_attempts: usize,
    pub delay: Duration,
}

impl RetryPolicy {
    /// Default for NEAR RPC reads and idempotent sends: 3 attempts, 500ms apart.
    pub const fn rpc() -> Self {
        Self {
            max_attempts: 3,
            delay: Duration::from_millis(500),
        }
    }
}

/// Run `operation`, retrying while it errors up to `policy.max_attempts`. Only use
/// for operations that are safe to repeat (reads, or sends with on-chain replay
/// protection / idempotency) — never for bare value transfers.
pub async fn retry<T, E, F, Fut>(policy: RetryPolicy, label: &str, mut operation: F) -> Result<T, E>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, E>>,
    E: Display,
{
    let mut attempt = 1;
    loop {
        match operation().await {
            Ok(value) => return Ok(value),
            Err(e) if attempt < policy.max_attempts => {
                tracing::warn!(
                    "{label} attempt {attempt}/{} failed: {e}",
                    policy.max_attempts
                );
                attempt += 1;
                tokio::time::sleep(policy.delay).await;
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const NO_DELAY: RetryPolicy = RetryPolicy {
        max_attempts: 3,
        delay: Duration::ZERO,
    };

    #[tokio::test]
    async fn succeeds_after_transient_failures() {
        let attempts = Cell::new(0);
        let result: Result<u8, String> = retry(NO_DELAY, "test", || async {
            attempts.set(attempts.get() + 1);
            if attempts.get() < 3 {
                Err("transient".to_owned())
            } else {
                Ok(7)
            }
        })
        .await;
        assert_eq!(result, Ok(7));
        assert_eq!(attempts.get(), 3);
    }

    #[tokio::test]
    async fn gives_up_after_max_attempts() {
        let attempts = Cell::new(0);
        let result: Result<u8, String> = retry(NO_DELAY, "test", || async {
            attempts.set(attempts.get() + 1);
            Err("always".to_owned())
        })
        .await;
        assert_eq!(result, Err("always".to_owned()));
        assert_eq!(attempts.get(), 3);
    }
}
