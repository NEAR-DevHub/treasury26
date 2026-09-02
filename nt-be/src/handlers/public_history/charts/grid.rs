use chrono::{DateTime, Datelike, Duration, NaiveTime, TimeZone, Utc};

// The frontend's widest daily window (3M = 90 days back from now) produces up
// to 91 buckets: 90 aligned midnights plus the trailing now-bucket.
pub const DAILY_BUCKET_LIMIT: usize = 92;
pub const WEEKLY_BUCKET_LIMIT: usize = 53;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotGridInterval {
    Daily,
    Weekly,
}

pub fn floor_boundary(at: DateTime<Utc>, interval: SnapshotGridInterval) -> DateTime<Utc> {
    let day = Utc.from_utc_datetime(&at.date_naive().and_time(NaiveTime::MIN));
    match interval {
        SnapshotGridInterval::Daily => day,
        SnapshotGridInterval::Weekly => {
            day - Duration::days(day.weekday().num_days_from_monday() as i64)
        }
    }
}

pub fn ceil_boundary(at: DateTime<Utc>, interval: SnapshotGridInterval) -> DateTime<Utc> {
    let floor = floor_boundary(at, interval);
    if floor == at {
        floor
    } else {
        increment(floor, interval)
    }
}

pub fn increment(at: DateTime<Utc>, interval: SnapshotGridInterval) -> DateTime<Utc> {
    match interval {
        SnapshotGridInterval::Daily => at + Duration::days(1),
        SnapshotGridInterval::Weekly => at + Duration::weeks(1),
    }
}

/// O(1) size of the grid `requested_grid` would produce, computed from the
/// aligned boundary distance instead of stepping bucket by bucket.
///
/// Callers must reject oversized ranges with this BEFORE calling
/// `requested_grid`: the range comes from unauthenticated query parameters,
/// and materializing first would let a single request with a huge date range
/// (e.g. year 1 to year 9999) force millions of loop iterations and a
/// multi-MB allocation before any validation runs.
pub fn bucket_count(
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    interval: SnapshotGridInterval,
) -> usize {
    if end < start {
        return 0;
    }
    let first = ceil_boundary(start, interval);
    let last = floor_boundary(end, interval);
    if last < first {
        // No aligned boundary inside the range; only the trailing bucket.
        return if end > start { 1 } else { 0 };
    }
    // Both boundaries are period-aligned, so the day distance divides evenly.
    let periods = match interval {
        SnapshotGridInterval::Daily => (last - first).num_days(),
        SnapshotGridInterval::Weekly => (last - first).num_days() / 7,
    };
    let aligned = periods as usize + 1;
    // requested_grid appends a trailing bucket at the raw end when it is not
    // boundary-aligned.
    if last == end { aligned } else { aligned + 1 }
}

pub fn requested_grid(
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    interval: SnapshotGridInterval,
) -> Vec<DateTime<Utc>> {
    if end < start {
        return Vec::new();
    }
    let mut result = Vec::with_capacity(bucket_count(start, end, interval) + 1);
    let mut current = ceil_boundary(start, interval);
    let aligned_end = floor_boundary(end, interval);
    while current <= aligned_end {
        result.push(current);
        current = increment(current, interval);
    }
    // A trailing "now" bucket at the requested end, so activity since the
    // last boundary is charted. Without it, a treasury created today has no
    // chartable bucket at all until the next midnight.
    if result.last() != Some(&end) && end > start {
        result.push(end);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn daily_request_uses_ceil_start_and_floor_end_plus_now_bucket() {
        assert_eq!(
            requested_grid(
                ts("2026-07-20T12:30:00Z"),
                ts("2026-07-22T19:00:00Z"),
                SnapshotGridInterval::Daily,
            ),
            vec![
                ts("2026-07-21T00:00:00Z"),
                ts("2026-07-22T00:00:00Z"),
                ts("2026-07-22T19:00:00Z"),
            ]
        );
    }

    #[test]
    fn same_day_request_still_gets_a_now_bucket() {
        // A treasury created today: no aligned boundary falls inside the
        // range, but the trailing bucket keeps the chart non-empty.
        assert_eq!(
            requested_grid(
                ts("2026-07-28T15:00:00Z"),
                ts("2026-07-28T19:00:00Z"),
                SnapshotGridInterval::Daily,
            ),
            vec![ts("2026-07-28T19:00:00Z")]
        );
    }

    #[test]
    fn weekly_boundaries_are_monday_utc() {
        assert_eq!(
            floor_boundary(ts("2026-07-22T12:00:00Z"), SnapshotGridInterval::Weekly),
            ts("2026-07-20T00:00:00Z")
        );
    }

    #[test]
    fn bucket_count_matches_the_materialized_grid() {
        let ranges = [
            ("2026-07-20T12:30:00Z", "2026-07-22T19:00:00Z"),
            ("2026-07-20T00:00:00Z", "2026-07-20T00:00:00Z"),
            ("2026-07-20T06:00:00Z", "2026-07-20T18:00:00Z"),
            ("2026-07-22T19:00:00Z", "2026-07-20T12:30:00Z"),
            ("2026-01-01T00:00:00Z", "2026-12-31T23:59:59Z"),
        ];
        for interval in [SnapshotGridInterval::Daily, SnapshotGridInterval::Weekly] {
            for (start, end) in ranges {
                assert_eq!(
                    bucket_count(ts(start), ts(end), interval),
                    requested_grid(ts(start), ts(end), interval).len(),
                    "{start}..{end} {interval:?}"
                );
            }
        }
    }

    #[test]
    fn oversized_range_is_counted_without_materializing_the_grid() {
        let start = ts("0001-01-01T00:00:00Z");
        let end = Utc.with_ymd_and_hms(262142, 1, 1, 0, 0, 0).unwrap();
        assert!(bucket_count(start, end, SnapshotGridInterval::Daily) > DAILY_BUCKET_LIMIT);
        assert!(bucket_count(start, end, SnapshotGridInterval::Weekly) > WEEKLY_BUCKET_LIMIT);
    }
}
