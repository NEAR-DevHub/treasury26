use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use near_api::Contract;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};

use crate::AppState;

#[derive(Deserialize)]
pub struct ProfileQuery {
    #[serde(rename = "accountId")]
    pub account_id: String,
}

#[derive(Deserialize)]
pub struct BatchProfileQuery {
    #[serde(rename = "accountIds")]
    pub account_ids: String, // Comma-separated account IDs
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProfileData {
    pub name: Option<String>,
    pub image: Option<serde_json::Value>,
    #[serde(rename = "backgroundImage")]
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
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let account_id = params.account_id.trim();

    if account_id.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "account_id is required".to_string(),
        ));
    }

    let cache_key = format!("profile:{}", account_id);

    // Check cache first
    if let Some(cached_data) = state.cache.get(&cache_key).await {
        println!("🔁 Returning cached profile for {}", account_id);
        return Ok((StatusCode::OK, Json(cached_data)));
    }

    println!("🚨 Fetching profile from Social DB for: {}", account_id);

    let profile = fetch_profile(&state, account_id).await.map_err(|e| {
        eprintln!("Error fetching profile: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, e)
    })?;

    let result_value = serde_json::to_value(&profile).map_err(|e| {
        eprintln!("Error serializing profile: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to serialize profile".to_string(),
        )
    })?;

    state.cache.insert(cache_key, result_value.clone()).await;

    Ok((StatusCode::OK, Json(result_value)))
}

/// Batch handler for multiple profiles endpoint
pub async fn get_batch_profiles(
    State(state): State<Arc<AppState>>,
    Query(params): Query<BatchProfileQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let account_ids: Vec<&str> = params.account_ids.split(',').map(|s| s.trim()).collect();

    if account_ids.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "No account IDs provided".to_string(),
        ));
    }

    // Check which accounts are not in cache
    let mut uncached_accounts = Vec::new();
    let mut cached_profiles: HashMap<String, ProfileData> = HashMap::new();

    for account_id in &account_ids {
        let cache_key = format!("profile:{}", account_id);
        if let Some(cached_data) = state.cache.get(&cache_key).await {
            if let Ok(profile) = serde_json::from_value::<ProfileData>(cached_data) {
                cached_profiles.insert(account_id.to_string(), profile);
            }
        } else {
            uncached_accounts.push(*account_id);
        }
    }

    if uncached_accounts.is_empty() {
        println!("✅ All profiles in cache, returning cached data");
        return Ok((StatusCode::OK, Json(cached_profiles)));
    }

    println!(
        "🚨 Fetching profiles from Social DB for: {:?}",
        uncached_accounts
    );

    // Fetch uncached profiles
    let mut futures = Vec::new();

    for account_id in uncached_accounts {
        let state_clone = state.clone();
        let account_id_owned = account_id.to_string();

        futures.push(async move {
            match fetch_profile(&state_clone, &account_id_owned).await {
                Ok(profile) => {
                    let cache_key = format!("profile:{}", account_id_owned);
                    if let Ok(value) = serde_json::to_value(&profile) {
                        state_clone.cache.insert(cache_key, value).await;
                    }
                    Some((account_id_owned, profile))
                }
                Err(e) => {
                    eprintln!("Error fetching profile for {}: {}", account_id_owned, e);
                    // Cache empty profile to prevent retries
                    let cache_key = format!("profile:{}", account_id_owned);
                    let empty_profile = ProfileData {
                        name: None,
                        image: None,
                        background_image: None,
                        description: None,
                        linktree: None,
                        tags: None,
                    };
                    if let Ok(value) = serde_json::to_value(&empty_profile) {
                        state_clone.cache.insert(cache_key, value).await;
                    }
                    Some((account_id_owned, empty_profile))
                }
            }
        });
    }

    let results = futures::future::join_all(futures).await;

    // Combine cached and fetched profiles
    for result in results.into_iter().flatten() {
        cached_profiles.insert(result.0, result.1);
    }

    Ok((StatusCode::OK, Json(cached_profiles)))
}
