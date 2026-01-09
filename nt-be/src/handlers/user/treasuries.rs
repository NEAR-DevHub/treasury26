use crate::utils::base64json::Base64Json;
use crate::utils::cache::CacheTier;
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
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
    pub dao_id: AccountId,
    pub config: TreasuryConfig,
}

pub async fn get_user_treasuries(
    State(state): State<Arc<AppState>>,
    Query(params): Query<UserTreasuriesQuery>,
) -> Result<Json<Vec<Treasury>>, (StatusCode, String)> {
    let account_id = params.account_id.clone();

    if account_id.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "account_id is required".to_string(),
        ));
    }

    let cache_key = format!("user-treasuries:{}", account_id);
    let state_clone = state.clone();

    let treasuries = state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            let response = state_clone
                .http_client
                .get("https://api.pikespeak.ai/daos/members")
                .header("x-api-key", state_clone.env_vars.pikespeak_key.clone())
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
                .get(&account_id)
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
                    .fetch_from(&state_clone.network)
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
            Ok::<_, (StatusCode, String)>(treasuries)
        })
        .await?;

    Ok(Json(treasuries))
}
