use chrono::{DateTime, Datelike, Duration, NaiveTime, TimeZone, Utc};

pub const DAILY_CHECKPOINT_COUNT: i64 = 90;
pub const WEEKLY_CHECKPOINT_COUNT: i64 = 53;

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

pub fn fixed_checkpoint_grid(now: DateTime<Utc>) -> Vec<DateTime<Utc>> {
    let daily_end = floor_boundary(now, SnapshotGridInterval::Daily);
    let weekly_end = floor_boundary(now, SnapshotGridInterval::Weekly);
    let mut grid = Vec::with_capacity((DAILY_CHECKPOINT_COUNT + WEEKLY_CHECKPOINT_COUNT) as usize);
    for offset in (0..DAILY_CHECKPOINT_COUNT).rev() {
        grid.push(daily_end - Duration::days(offset));
    }
    for offset in (0..WEEKLY_CHECKPOINT_COUNT).rev() {
        grid.push(weekly_end - Duration::weeks(offset));
    }
    grid.sort_unstable();
    grid.dedup();
    grid
}

pub fn requested_grid(
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    interval: SnapshotGridInterval,
) -> Vec<DateTime<Utc>> {
    if end < start {
        return Vec::new();
    }
    let mut current = ceil_boundary(start, interval);
    let end = floor_boundary(end, interval);
    let mut result = Vec::new();
    while current <= end {
        result.push(current);
        current = increment(current, interval);
    }
    result
}

pub fn fixed_coverage(
    applied_at: DateTime<Utc>,
    interval: SnapshotGridInterval,
) -> (DateTime<Utc>, DateTime<Utc>) {
    let end = floor_boundary(applied_at, interval);
    let start = match interval {
        SnapshotGridInterval::Daily => end - Duration::days(DAILY_CHECKPOINT_COUNT - 1),
        SnapshotGridInterval::Weekly => end - Duration::weeks(WEEKLY_CHECKPOINT_COUNT - 1),
    };
    (start, end)
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
    fn daily_request_uses_ceil_start_and_floor_end() {
        assert_eq!(
            requested_grid(
                ts("2026-07-20T12:30:00Z"),
                ts("2026-07-22T19:00:00Z"),
                SnapshotGridInterval::Daily,
            ),
            vec![ts("2026-07-21T00:00:00Z"), ts("2026-07-22T00:00:00Z")]
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
    fn fixed_grid_contains_complete_daily_and_weekly_windows() {
        let now = ts("2026-07-22T12:00:00Z");
        let grid = fixed_checkpoint_grid(now);
        let daily = (0..DAILY_CHECKPOINT_COUNT)
            .map(|offset| floor_boundary(now, SnapshotGridInterval::Daily) - Duration::days(offset))
            .all(|point| grid.contains(&point));
        let weekly = (0..WEEKLY_CHECKPOINT_COUNT)
            .map(|offset| {
                floor_boundary(now, SnapshotGridInterval::Weekly) - Duration::weeks(offset)
            })
            .all(|point| grid.contains(&point));
        assert!(daily && weekly);
    }
}
