use axum::{
    extract::{Query, State},
    http::StatusCode,
};
use near_api::{AccountId, Contract, Reference, types::json::U64};
use serde::{Deserialize, Serialize};
use serde_with::serde_as;
use std::sync::Arc;

use crate::utils::base64json::Base64Json;
use crate::utils::cache::CacheKey;
use crate::{AppState, utils::cache::CacheTier};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetTreasuryConfigQuery {
    pub treasury_id: AccountId,
    pub at_before: Option<U64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreasuryMetadata {
    #[serde(default)]
    pub primary_color: Option<String>,
    #[serde(default)]
    pub flag_logo: Option<String>,
}

#[serde_as]
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreasuryConfigFromContract {
    #[serde_as(as = "Base64Json<TreasuryMetadata>")]
    pub metadata: Option<TreasuryMetadata>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub purpose: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TreasuryConfig {
    pub metadata: Option<TreasuryMetadata>,
    pub name: Option<String>,
    pub purpose: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Treasury {
    pub dao_id: String,
    pub config: TreasuryConfig,
}

/// Fetch treasury config from contract with caching
///
/// - `at_before`: Optional timestamp in nanoseconds. If provided, fetches historical config.
pub async fn fetch_treasury_config(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    at_before: Option<u64>,
) -> Result<TreasuryConfig, (StatusCode, String)> {
    let at_before = at_before.unwrap_or(0);
    let cache_key = CacheKey::new("treasury-config")
        .with(treasury_id)
        .with(at_before)
        .build();

    let network = if at_before > 0 {
        state.archival_network.clone()
    } else {
        state.network.clone()
    };

    let treasury_id = treasury_id.clone();
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
            Contract(treasury_id)
                .call_function("get_config", ())
                .read_only::<TreasuryConfigFromContract>()
                .at(at)
                .fetch_from(&network)
                .await
                .map(|r| r.data)
        })
        .await?;

    Ok(TreasuryConfig {
        metadata: result.metadata,
        name: result.name,
        purpose: result.purpose,
    })
}

pub async fn get_treasury_config(
    State(state): State<Arc<AppState>>,
    Query(params): Query<GetTreasuryConfigQuery>,
) -> Result<axum::Json<TreasuryConfig>, (StatusCode, String)> {
    let at_before = params.at_before.map(|at| at.0);
    let config = fetch_treasury_config(&state, &params.treasury_id, at_before).await?;
    Ok(axum::Json(config))
}
