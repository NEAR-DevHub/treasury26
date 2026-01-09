use axum::{
    extract::{Query, State},
    http::StatusCode,
};
use near_api::{AccountId, Contract};
use serde::{Deserialize, Serialize};
use serde_with::serde_as;
use std::sync::Arc;

use crate::utils::base64json::Base64Json;
use crate::utils::cache::CacheKey;
use crate::{AppState, utils::cache::CacheTier};

#[derive(Deserialize)]
pub struct GetTreasuryConfigQuery {
    #[serde(rename = "treasuryId")]
    pub treasury_id: AccountId,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TreasuryMetadata {
    #[serde(rename = "primaryColor", default)]
    pub primary_color: Option<String>,
    #[serde(rename = "flagLogo", default)]
    pub flag_logo: Option<String>,
}

#[serde_as]
#[derive(Serialize, Deserialize, Clone, Debug)]
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
pub struct Treasury {
    #[serde(rename = "daoId")]
    pub dao_id: String,
    pub config: TreasuryConfig,
}

pub async fn get_treasury_config(
    State(state): State<Arc<AppState>>,
    Query(params): Query<GetTreasuryConfigQuery>,
) -> Result<axum::Json<TreasuryConfig>, (StatusCode, String)> {
    let treasury_id = params.treasury_id.clone();
    let cache_key = CacheKey::new("treasury-config").with(&treasury_id).build();

    let state_clone = state.clone();
    let result = state
        .clone()
        .cache
        .cached_contract_call(CacheTier::ShortTerm, cache_key, async move {
            Contract(treasury_id.clone())
                .call_function("get_config", ())
                .read_only::<TreasuryConfigFromContract>()
                .fetch_from(&state_clone.network)
                .await
                .map(|r| r.data)
        })
        .await?;

    Ok(axum::Json(TreasuryConfig {
        metadata: result.metadata,
        name: result.name,
        purpose: result.purpose,
    }))
}
