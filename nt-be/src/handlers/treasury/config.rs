use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use near_api::{AccountId, Contract};
use serde::{Deserialize, Serialize};
use serde_with::serde_as;
use std::sync::Arc;

use crate::AppState;
use crate::utils::base64json::Base64Json;

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
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let treasury_id = params.treasury_id;

    let cache_key = format!("treasury-config:{}", treasury_id);
    if let Some(cached_config) = state.cache.get(&cache_key).await {
        println!("🔁 Returning cached config for {}", treasury_id);
        return Ok((StatusCode::OK, Json(cached_config)));
    }

    let result = Contract(treasury_id.clone())
        .call_function("get_config", ())
        .read_only::<TreasuryConfigFromContract>()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching treasury config for {}: {}", treasury_id, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch treasury config: {}", e),
            )
        })?
        .data;

    let treasury = Treasury {
        dao_id: treasury_id.to_string(),
        config: TreasuryConfig {
            metadata: result.metadata,
            name: result.name,
            purpose: result.purpose,
        },
    };

    let treasury_value = serde_json::to_value(&treasury).map_err(|e| {
        eprintln!("Error serializing treasury: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to serialize treasury".to_string(),
        )
    })?;

    state.cache.insert(cache_key, treasury_value.clone()).await;

    Ok((StatusCode::OK, Json(treasury_value)))
}
