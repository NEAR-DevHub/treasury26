use axum::{
    extract::{Query, State},
    http::StatusCode,
};
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

pub async fn get_treasury_policy(
    State(state): State<Arc<AppState>>,
    Query(params): Query<GetTreasuryPolicyQuery>,
) -> Result<axum::Json<serde_json::Value>, (StatusCode, String)> {
    let treasury_id = params.treasury_id.clone();
    let at_before = params.at_before.map(|at| at.0).unwrap_or(0);
    let cache_key = CacheKey::new("treasury-policy")
        .with(&treasury_id)
        .with(at_before)
        .build();

    let network = if at_before > 0 {
        &state.archival_network
    } else {
        &state.network
    };
    let state_clone = state.clone();
    let result = state
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

            Contract(treasury_id.clone())
                .call_function("get_policy", ())
                .read_only::<serde_json::Value>()
                .at(at)
                .fetch_from(network)
                .await
                .map(|r| r.data)
        })
        .await?;

    Ok(axum::Json(result))
}
