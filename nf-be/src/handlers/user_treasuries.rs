use crate::utils::base64json::Base64Json;
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use serde_with::serde_as;
use std::sync::Arc;

use crate::AppState;

#[derive(Deserialize)]
pub struct UserTreasuriesQuery {
    #[serde(rename = "accountId")]
    pub account_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TreasuryMetadata {
    #[serde(rename = "primaryColor")]
    pub primary_color: Option<String>,
    #[serde(rename = "flagLogo")]
    pub flag_logo: Option<String>,
    pub theme: Option<String>,
}

#[serde_as]
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TreasuryConfigFromContract {
    #[serde_as(as = "Base64Json<TreasuryMetadata>")]
    pub metadata: Option<TreasuryMetadata>,
    pub name: Option<String>,
    pub purpose: Option<String>,
}

#[serde_as]
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TreasuryConfig {
    pub metadata: Option<TreasuryMetadata>,
    pub name: Option<String>,
    pub purpose: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Treasury {
    #[serde(rename = "daoId")]
    pub dao_id: AccountId,
    pub config: TreasuryConfig,
}

pub async fn get_user_treasuries(
    State(state): State<Arc<AppState>>,
    Query(params): Query<UserTreasuriesQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let account_id = &params.account_id;

    if account_id.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "account_id is required".to_string(),
        ));
    }

    let cache_key = format!("user-treasuries:{}", account_id);

    if let Some(cached_treasuries) = state.cache.get(&cache_key).await {
        println!("🔁 Returning cached treasuries for {}", account_id);
        return Ok((StatusCode::OK, Json(cached_treasuries)));
    }

    let response = state
        .http_client
        .get("https://api.pikespeak.ai/daos/members")
        .header("x-api-key", state.env_vars.pikespeak_key.clone())
        .send()
        .await
        .map_err(|e| {
            eprintln!("Error fetching user daos: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch user daos".to_string(),
            )
        })?;

    let data: serde_json::Value = response.json().await.map_err(|e| {
        eprintln!("Error parsing response: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to parse response".to_string(),
        )
    })?;

    let user_daos = data
        .get(account_id)
        .and_then(|v| v.get("daos"))
        .and_then(|v| v.as_array())
        .ok_or((StatusCode::NOT_FOUND, "No DAOs found for user".to_string()))?;

    let mut treasuries = Vec::new();

    for dao in user_daos {
        let dao_id: AccountId = match dao.as_str() {
            Some(id) => id.parse().map_err(|e| {
                eprintln!("Error parsing DAO ID: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to parse DAO ID".to_string(),
                )
            })?,
            None => continue,
        };
        let result = near_api::Contract(dao_id.clone())
            .call_function("get_config", ())
            .read_only::<TreasuryConfigFromContract>()
            .fetch_from(&state.network)
            .await
            .map_err(|e| {
                eprintln!("Error fetching DAO config: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to fetch DAO config".to_string(),
                )
            })?
            .data;

        let dao_config: TreasuryConfig = TreasuryConfig {
            metadata: result.metadata,
            name: result.name,
            purpose: result.purpose,
        };
        treasuries.push(Treasury {
            dao_id,
            config: dao_config,
        });
    }

    let treasuries_value = serde_json::to_value(&treasuries).map_err(|e| {
        eprintln!("Error serializing treasuries: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to serialize treasuries".to_string(),
        )
    })?;

    state
        .cache
        .insert(cache_key, treasuries_value.clone())
        .await;

    Ok((StatusCode::OK, Json(treasuries_value)))
}
