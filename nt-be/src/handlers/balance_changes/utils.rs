//! Utility Functions
//!
//! Common utility functions used across balance change modules.

use sqlx::types::chrono::{DateTime, Utc};

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
