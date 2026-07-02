pub mod api;
pub mod ingest_worker;
pub mod jobs;
pub mod store;

use crate::utils::priority_rate_gate::GatePriority;

/// Priority classes for the shared NearBlocks rate budget. Latest (user-facing
/// refresh) preempts Backfill (bulk historical paging) for the next permit.
#[derive(Clone, Copy)]
pub enum NearblocksPriority {
    Latest,
    Backfill,
}

impl GatePriority for NearblocksPriority {
    fn lanes() -> usize {
        2
    }
    fn lane(self) -> usize {
        match self {
            Self::Latest => 0,
            Self::Backfill => 1,
        }
    }
}
