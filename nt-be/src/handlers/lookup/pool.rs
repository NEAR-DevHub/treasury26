use std::sync::Arc;

use axum::extract::{Query, State};
use near_api::{AccountId, Contract};
use reqwest::StatusCode;
use serde::Deserialize;

use crate::{
    AppState,
    utils::cache::{CacheKey, CacheTier},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolLookupQuery {
    pub account_id: AccountId,
}

pub async fn get_lockup_pool(
    State(state): State<Arc<AppState>>,
    Query(params): Query<PoolLookupQuery>,
) -> Result<axum::Json<Option<AccountId>>, (StatusCode, String)> {
    let cache_key = CacheKey::new("pool-lookup")
        .with(&params.account_id)
        .build();

    let result = state
        .clone()
        .cache
        .cached_contract_call(CacheTier::LongTerm, cache_key, async move {
            Ok(Contract(params.account_id.clone())
                .call_function("get_staking_pool_account_id", ())
                .read_only::<Option<AccountId>>()
                .fetch_from(&state.network)
                .await?
                .data)
        })
        .await?;

    Ok(axum::Json(result))
}
