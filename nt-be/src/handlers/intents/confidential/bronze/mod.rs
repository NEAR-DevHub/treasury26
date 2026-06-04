//! Bronze layer: 1Click history ingest and cursor storage.

pub mod api;
pub mod ingest_worker;
pub mod store;

pub use api::{HistoryEvent, HistoryPage, fetch_history, fetch_history_with_token};
pub use ingest_worker::{spawn_confidential_history_worker, trigger_confidential_history_refresh};
pub use store::{
    HistoryCursor, HistoryEventUpsertOutcome, HistoryEventUpsertState, HistoryUpsertResult,
    link_intent_to_history_event, load_confidential_history_accounts,
    load_due_confidential_history_accounts, load_history_cursor,
    mark_confidential_history_activity_due, mark_history_backfill_done,
    record_confidential_history_poll_result, save_backfill_progress, save_latest_page_cursor,
    upsert_history_events,
};
