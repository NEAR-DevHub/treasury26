use axum::{
    extract::{Query, State},
    http::StatusCode,
};
use near_account_id::AccountIdRef;
use near_api::{AccountId, Contract, Reference, types::json::U64};
use serde::Deserialize;
use std::sync::Arc;

use crate::{
    AppState,
    utils::cache::{CacheKey, CacheTier},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetTreasuryPolicyQuery {
    pub treasury_id: AccountId,
    pub at_before: Option<U64>,
}

/// Cache key for a treasury's `get_policy` result. Shared with the test seeding helper
/// (`utils::test_utils::seed_treasury_policy`) so a key-scheme change can't silently desync the
/// seed from the fetch and leak into RPC calls.
pub(crate) fn treasury_policy_cache_key(treasury_id: &AccountIdRef, at_before: u64) -> String {
    CacheKey::new("treasury-policy")
        .with(treasury_id)
        .with(at_before)
        .build()
}

pub async fn fetch_treasury_policy_cached(
    state: &Arc<AppState>,
    treasury_id: &AccountIdRef,
    at_before: Option<u64>,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let at_before = at_before.unwrap_or(0);
    let cache_key = treasury_policy_cache_key(treasury_id, at_before);

    let network = if at_before > 0 {
        &state.archival_network
    } else {
        &state.network
    };
    let state_clone = state.clone();
    state
        .cache
        .cached_contract_call(CacheTier::ShortTerm, cache_key, async move {
            let at = if at_before > 0 {
                state_clone
                    .find_block_height(chrono::DateTime::<chrono::Utc>::from_timestamp_nanos(
                        at_before as i64,
                    ))
                    .await
                    .map(|at| Reference::AtBlock(at - 1))
                    .unwrap_or(Reference::Optimistic)
            } else {
                Reference::Optimistic
            };

            Contract(treasury_id.to_owned())
                .call_function("get_policy", ())
                .read_only::<serde_json::Value>()
                .at(at)
                .fetch_from(network)
                .await
                .map(|r| r.data)
        })
        .await
}

pub async fn get_treasury_policy(
    State(state): State<Arc<AppState>>,
    Query(params): Query<GetTreasuryPolicyQuery>,
) -> Result<axum::Json<serde_json::Value>, (StatusCode, String)> {
    let result =
        fetch_treasury_policy_cached(&state, &params.treasury_id, params.at_before.map(|at| at.0))
            .await?;

    Ok(axum::Json(result))
}
