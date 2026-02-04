use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use near_api::Contract;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{AppState, utils::cache::CacheTier};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileQuery {
    pub account_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchProfileQuery {
    pub account_ids: String, // Comma-separated account IDs
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProfileData {
    pub name: Option<String>,
    pub image: Option<serde_json::Value>,
    pub background_image: Option<String>,
    pub description: Option<String>,
    pub linktree: Option<serde_json::Value>,
    pub tags: Option<serde_json::Value>,
}

const SOCIAL_DB_CONTRACT: &str = "social.near";

/// Fetch profile data from NEAR Social DB for a single account
async fn fetch_profile(state: &Arc<AppState>, account_id: &str) -> Result<ProfileData, String> {
    let keys = vec![format!("{}/profile/**", account_id)];

    let result: serde_json::Value = Contract(SOCIAL_DB_CONTRACT.parse().unwrap())
        .call_function("get", serde_json::json!({ "keys": keys }))
        .read_only()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching profile for {}: {}", account_id, e);
            format!("Failed to fetch profile: {}", e)
        })?
        .data;

    // Extract profile data from the result
    let profile = result
        .get(account_id)
        .and_then(|v| v.get("profile"))
        .cloned()
        .unwrap_or(serde_json::json!({}));

    let profile_data = ProfileData {
        name: profile
            .get("name")
            .and_then(|v| v.as_str())
            .map(String::from),
        image: profile.get("image").cloned(),
        background_image: profile
            .get("backgroundImage")
            .and_then(|v| v.as_str())
            .map(String::from),
        description: profile
            .get("description")
            .and_then(|v| v.as_str())
            .map(String::from),
        linktree: profile.get("linktree").cloned(),
        tags: profile.get("tags").cloned(),
    };

    Ok(profile_data)
}

/// Main handler for single profile endpoint
pub async fn get_profile(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ProfileQuery>,
) -> Result<Json<ProfileData>, (StatusCode, String)> {
    let account_id = params.account_id.trim().to_string();

    if account_id.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "account_id is required".to_string(),
        ));
    }

    let cache_key = format!("profile:{}", account_id);
    let state_clone = state.clone();

    let profile = state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            fetch_profile(&state_clone, &account_id).await.map_err(|e| {
                eprintln!("Error fetching profile: {}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, e)
            })
        })
        .await?;

    Ok(Json(profile))
}
