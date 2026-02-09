//! Utility Functions
//!
//! Common utility functions used across balance change modules.

use sqlx::types::chrono::{DateTime, Utc};
use std::future::Future;
use tokio::time::{Duration, sleep};

const MAX_TRANSPORT_RETRIES: u32 = 3;

/// Check if an error is a transient transport/network error that should be retried
pub fn is_transport_error(err_debug: &str) -> bool {
    err_debug.contains("TransportError")
        || err_debug.contains("SendError")
        || err_debug.contains("DispatchGone")
        || err_debug.contains("sending payload")
        || err_debug.contains("error sending request")
        || err_debug.contains("connection")
        || err_debug.contains("timed out")
}

/// Retry an async operation on transient transport errors with exponential backoff.
///
/// Retries up to 3 times with delays of 200ms, 400ms, 800ms.
/// Non-transport errors are returned immediately without retrying.
pub async fn with_transport_retry<T, E, F, Fut>(label: &str, mut make_call: F) -> Result<T, E>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, E>>,
    E: std::fmt::Debug,
{
    for attempt in 0..=MAX_TRANSPORT_RETRIES {
        if attempt > 0 {
            let delay_ms = 200 * 2u64.pow(attempt - 1);
            log::warn!(
                "{}: transport error, retrying in {}ms (attempt {}/{})",
                label,
                delay_ms,
                attempt + 1,
                MAX_TRANSPORT_RETRIES + 1
            );
            sleep(Duration::from_millis(delay_ms)).await;
        }
        match make_call().await {
            Ok(result) => return Ok(result),
            Err(e) => {
                let err_debug = format!("{:?}", e);
                if is_transport_error(&err_debug) && attempt < MAX_TRANSPORT_RETRIES {
                    continue;
                }
                return Err(e);
            }
        }
    }
    unreachable!()
}

/// Convert NEAR block timestamp (nanoseconds) to DateTime<Utc>
///
/// NEAR stores timestamps as nanoseconds since Unix epoch.
/// This converts them to DateTime for database storage and API responses.
///
/// # Arguments
/// * `timestamp_nanos` - NEAR block timestamp in nanoseconds
///
/// # Returns
/// DateTime<Utc> or current time if conversion fails
pub fn block_timestamp_to_datetime(timestamp_nanos: i64) -> DateTime<Utc> {
    let secs = timestamp_nanos / 1_000_000_000;
    let nsecs = (timestamp_nanos % 1_000_000_000) as u32;
    DateTime::from_timestamp(secs, nsecs).unwrap_or_else(Utc::now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_block_timestamp_conversion() {
        // Test with a known timestamp (2024-01-01 00:00:00 UTC = 1704067200 seconds)
        let nanos = 1_704_067_200_000_000_000_i64;
        let dt = block_timestamp_to_datetime(nanos);

        assert_eq!(dt.timestamp(), 1704067200);
        assert_eq!(dt.timestamp_subsec_nanos(), 0);
    }

    #[test]
    fn test_block_timestamp_with_subsecond() {
        // Test with nanoseconds (1704067200.5 seconds)
        let nanos = 1_704_067_200_500_000_000_i64;
        let dt = block_timestamp_to_datetime(nanos);

        assert_eq!(dt.timestamp(), 1704067200);
        assert_eq!(dt.timestamp_subsec_nanos(), 500_000_000);
    }
}
