//! DAO synchronization service for caching DAO membership data
//!
//! This module provides background services to:
//! - Fetch DAO list from sputnik-dao.near factory (every 5 minutes)
//! - Process DAOs to extract member information (dirty DAOs immediately, stale periodically)
//! - Provide functions to mark DAOs as dirty when policy changes

mod dao_list_sync;
mod dao_policy_sync;
mod dirty_trigger;

pub use dao_list_sync::run_dao_list_sync_service;
pub use dao_policy_sync::run_dao_policy_sync_service;
pub use dirty_trigger::{mark_dao_dirty, register_new_dao};
