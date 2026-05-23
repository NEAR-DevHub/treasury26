//! Gold projection for confidential 1Click history rows.

mod classify;
mod models;
mod projector;
mod repository;

pub use projector::{project_confidential_gold_for_dao, project_confidential_gold_for_dirty_daos};
pub use repository::{
    mark_backfilled_confidential_daos_gold_dirty, mark_gold_dirty_for_history_event,
    mark_gold_dirty_tx, refresh_gold_metadata_for_intent,
};

pub const CONFIDENTIAL_GOLD_RECONCILIATION_WORKERS: usize = 8;
pub const CONFIDENTIAL_GOLD_RECONCILIATION_INTERVAL_SECS: u64 = 86_400;
