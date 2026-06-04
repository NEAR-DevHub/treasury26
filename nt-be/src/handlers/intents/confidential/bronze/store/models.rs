use chrono::{DateTime, Utc};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct HistoryCursor {
    pub account_id: String,
    pub forward_cursor: Option<String>,
    pub backward_cursor: Option<String>,
    pub backfill_done: bool,
    pub next_poll_at: DateTime<Utc>,
    pub last_polled_at: Option<DateTime<Utc>>,
    pub last_confidential_activity_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default)]
pub struct HistoryUpsertResult {
    pub rows_touched: u64,
    pub rows_inserted: u64,
    pub rows_changed: u64,
    pub rows_unchanged: u64,
    pub links_created: u64,
    pub earliest_changed_at: Option<DateTime<Utc>>,
    pub events: Vec<HistoryEventUpsertOutcome>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryEventUpsertState {
    Inserted,
    Changed,
    Unchanged,
}

#[derive(Debug, Clone)]
pub struct HistoryEventUpsertOutcome {
    pub history_event_id: i64,
    pub created_at_external: DateTime<Utc>,
    pub state: HistoryEventUpsertState,
}

pub(super) fn min_datetime(
    current: Option<DateTime<Utc>>,
    candidate: Option<DateTime<Utc>>,
) -> Option<DateTime<Utc>> {
    match (current, candidate) {
        (Some(current), Some(candidate)) => Some(current.min(candidate)),
        (None, Some(candidate)) => Some(candidate),
        (current, None) => current,
    }
}
