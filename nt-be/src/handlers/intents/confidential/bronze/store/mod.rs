//! Postgres storage helpers for confidential history ingestion.

mod cursors;
mod events;
mod linking;
mod models;

pub use cursors::{
    load_confidential_history_accounts, load_due_confidential_history_accounts,
    load_history_cursor, mark_confidential_history_activity_due, mark_history_backfill_done,
    record_confidential_history_poll_result, save_backfill_progress, save_latest_page_cursor,
};
pub use events::upsert_history_events;
pub use linking::link_intent_to_history_event;
pub use models::{
    HistoryCursor, HistoryEventUpsertOutcome, HistoryEventUpsertState, HistoryUpsertResult,
};

#[cfg(test)]
mod tests;
