use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{
    AppState,
    utils::cache::{CacheKey, CacheTier},
};

#[derive(Debug, Serialize, Deserialize, Clone)]
struct InstatusUpdate {
    id: String,
    message: String,
    reported_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct InstatusPost {
    id: String,
    title: String,
    post_type: String,
    starts_at: Option<i64>,
    ends_at: Option<i64>,
    latest_update: Option<InstatusUpdate>,
}

#[derive(Debug, Deserialize)]
struct InstatusResponse {
    posts: Vec<InstatusPost>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SystemStatusPost {
    pub id: String,
    pub title: String,
    pub message: String,
    pub post_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SystemStatusResponse {
    pub posts: Vec<SystemStatusPost>,
}

pub async fn get_system_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SystemStatusResponse>, (StatusCode, String)> {
    let cache_key = CacheKey::new("intents-system-status").build();
    let http_client = state.http_client.clone();
    let status_url = state.env_vars.near_intents_status_api_url.clone();

    let posts = state
        .cache
        .cached(CacheTier::ShortTerm, cache_key, async move {
            let response = http_client.get(status_url).send().await.map_err(|e| {
                log::error!("Error fetching system status: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to fetch system status: {}", e),
                )
            })?;

            if !response.status().is_success() {
                let error_text = response.text().await.unwrap_or_default();
                log::error!("Instatus API error: {}", error_text);
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Instatus API error: {}", error_text),
                ));
            }

            let instatus_response: InstatusResponse = response.json().await.map_err(|e| {
                log::error!("Error parsing system status response: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to parse system status response: {}", e),
                )
            })?;

            let now = chrono::Utc::now().timestamp_millis();
            let posts: Vec<SystemStatusPost> = instatus_response
                .posts
                .into_iter()
                .filter(|post| {
                    if post.post_type == "incident" {
                        return true;
                    }
                    match (post.starts_at, post.ends_at) {
                        (Some(start), Some(end)) => now >= start && now <= end,
                        (Some(start), None) => now >= start,
                        _ => true,
                    }
                })
                .map(|post| {
                    let message = post
                        .latest_update
                        .map(|u| u.message)
                        .unwrap_or_else(|| post.title.clone());
                    SystemStatusPost {
                        id: post.id,
                        title: post.title,
                        message,
                        post_type: post.post_type,
                    }
                })
                .collect();

            Ok::<_, (StatusCode, String)>(SystemStatusResponse { posts })
        })
        .await?;

    Ok(Json(posts))
}
