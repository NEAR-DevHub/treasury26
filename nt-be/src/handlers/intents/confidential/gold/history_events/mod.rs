//! Gold projection for confidential 1Click history rows.

mod classify;
mod convert;
mod models;
mod projector;
mod repository;

pub use models::GoldProjector;
pub use projector::{project_confidential_gold_for_dao, project_confidential_gold_for_dirty_daos};
pub use repository::refresh_gold_metadata_for_intent;

pub(crate) const CONFIDENTIAL_GOLD_RECONCILIATION_WORKERS: usize = 8;
