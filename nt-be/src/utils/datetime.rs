use chrono::{DateTime, Datelike, Months, Utc};
use std::time::Duration;

/// Returns the next UTC month start (`YYYY-MM-01 00:00:00Z`) after `now`.
pub fn next_month_start_utc(now: DateTime<Utc>) -> DateTime<Utc> {
    let start_of_current_month = now
        .date_naive()
        .with_day(1)
        .expect("day 1 should always be valid")
        .and_hms_opt(0, 0, 0)
        .expect("00:00:00 should always be valid");

    let start_of_next_month = start_of_current_month
        .checked_add_months(Months::new(1))
        .expect("adding one month should always be valid");

    DateTime::<Utc>::from_naive_utc_and_offset(start_of_next_month, Utc)
}

/// Returns the next UTC midnight (`YYYY-MM-DD 00:00:00Z`) after `now`.
pub fn next_utc_midnight_after(now: DateTime<Utc>) -> DateTime<Utc> {
    let tomorrow = now
        .date_naive()
        .checked_add_days(chrono::Days::new(1))
        .expect("tomorrow should always be valid");

    let midnight = tomorrow
        .and_hms_opt(0, 0, 0)
        .expect("00:00:00 should always be valid");

    DateTime::<Utc>::from_naive_utc_and_offset(midnight, Utc)
}

/// Returns the sleep duration until the next UTC midnight.
pub fn duration_until_next_utc_midnight(now: DateTime<Utc>) -> Duration {
    let next_midnight = next_utc_midnight_after(now);
    let sleep_duration = next_midnight.signed_duration_since(now);

    sleep_duration
        .to_std()
        .unwrap_or_else(|_| Duration::from_secs(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_next_month_start_utc() {
        let now =
            DateTime::parse_from_rfc3339("2026-02-11T15:42:05Z").expect("timestamp should parse");
        let now = now.with_timezone(&Utc);
        let reset_at = next_month_start_utc(now);

        assert_eq!(reset_at.to_rfc3339(), "2026-03-01T00:00:00+00:00");
    }

    #[test]
    fn test_next_utc_midnight_after() {
        let now =
            DateTime::parse_from_rfc3339("2026-02-11T15:42:05Z").expect("timestamp should parse");
        let now = now.with_timezone(&Utc);
        let next_midnight = next_utc_midnight_after(now);

        assert_eq!(next_midnight.to_rfc3339(), "2026-02-12T00:00:00+00:00");
    }

    #[test]
    fn test_duration_until_next_utc_midnight() {
        let now =
            DateTime::parse_from_rfc3339("2026-02-11T23:59:30Z").expect("timestamp should parse");
        let now = now.with_timezone(&Utc);
        let duration = duration_until_next_utc_midnight(now);

        assert_eq!(
            duration,
            Duration::from_secs(30),
            "Expected 30 seconds until midnight"
        );
    }
}
