pub mod api;
pub mod ingest_worker;
pub mod jobs;
pub mod store;

use crate::utils::priority_rate_gate::GatePriority;

/// Priority classes for the shared NearBlocks rate budget. Latest
/// (transaction-triggered realtime refresh) always gets the next permit;
/// Readiness (verification-coverage refresh) runs on spare capacity ahead of
/// Backfill (bulk historical paging).
#[derive(Clone, Copy, Debug)]
pub enum NearblocksPriority {
    Latest,
    Readiness,
    Backfill,
}

impl GatePriority for NearblocksPriority {
    fn lanes() -> usize {
        3
    }
    fn lane(self) -> usize {
        match self {
            Self::Latest => 0,
            Self::Readiness => 1,
            Self::Backfill => 2,
        }
    }
}
