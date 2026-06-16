//! Gold projection for confidential 1Click history rows.

mod classify;
mod convert;
mod models;
mod projector;
mod repository;

pub use models::GoldProjector;
pub use projector::{project_confidential_gold_for_dao, project_confidential_gold_for_dirty_daos};
pub use repository::refresh_gold_metadata_for_intent;

pub(crate) use classify::classify_is_deposit;
pub(crate) use projector::confidential_deposit_corrections_enabled;
pub(crate) use repository::{
    ConfidentialDepositLeg, GoldDeposit, latest_gold_token_balance, load_confidential_deposit_legs,
    load_confidential_gold_deposits, upsert_confidential_deposit_correction,
};

pub(crate) const CONFIDENTIAL_GOLD_RECONCILIATION_WORKERS: usize = 8;
