//! Gold layer: projected history events, dirty cursors, snapshots.

pub mod cursors;
pub mod history_events;
pub mod reconciliation_worker;
pub mod snapshots;

pub use cursors::{
    mark_gold_dirty_for_history_event, mark_gold_dirty_tx,
    mark_backfilled_confidential_daos_gold_dirty,
};
pub use history_events::{
    project_confidential_gold_for_dao, project_confidential_gold_for_dirty_daos,
    refresh_gold_metadata_for_intent, GoldProjector,
};
pub use reconciliation_worker::spawn_confidential_gold_reconciliation_worker;
pub use snapshots::{
    get_confidential_balance_chart, snapshot_confidential_dao_balances,
    spawn_confidential_snapshot_worker,
};
