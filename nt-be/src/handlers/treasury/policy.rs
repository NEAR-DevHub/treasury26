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
pub struct GetTreasuryPolicyQuery {
    #[serde(rename = "treasuryId")]
    pub treasury_id: AccountId,
    pub at: Option<U64>,
}

pub async fn get_treasury_policy(
    State(state): State<Arc<AppState>>,
    Query(params): Query<GetTreasuryPolicyQuery>,
) -> Result<axum::Json<serde_json::Value>, (StatusCode, String)> {
    let treasury_id = params.treasury_id.clone();
    let cache_key = CacheKey::new("treasury-policy").with(&treasury_id).build();

    let at = if let Some(at) = params.at {
        state
            .find_block_height(chrono::DateTime::<chrono::Utc>::from_timestamp_nanos(
                at.0 as i64,
            ))
            .await
            .map(Reference::AtBlock)
            .unwrap_or(Reference::Optimistic)
    } else {
        Reference::Optimistic
    };

    let state_clone = state.clone();
    let result = state
        .cache
        .cached_contract_call(CacheTier::ShortTerm, cache_key, async move {
            Contract(treasury_id.clone())
                .call_function("get_policy", ())
                .read_only::<serde_json::Value>()
                .at(at)
                .fetch_from(&state_clone.network)
                .await
                .map(|r| r.data)
        })
        .await?;

    Ok(axum::Json(result))
}
