use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use crate::{
    AppState,
    handlers::warnings::{ACTIVE_WARNINGS_SQL, templates},
    utils::cache::{CacheKey, CacheTier},
};

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PublicWarning {
    pub id: i32,
    pub slot: Option<String>,
    pub token: Option<String>,
    pub network: Option<String>,
    pub severity: String,
    pub response: String,
    pub situation: Option<String>,
    #[sqlx(rename = "user_message")]
    pub message: Option<String>,
    pub show_from: Option<chrono::DateTime<chrono::Utc>>,
    pub starts_at: Option<chrono::DateTime<chrono::Utc>>,
    pub ends_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicWarningsResponse {
    pub warnings: Vec<PublicWarning>,
    pub action_by_slot: HashMap<String, String>,
}

pub async fn get_warnings(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PublicWarningsResponse>, (StatusCode, String)> {
    let cache_key = CacheKey::new("public-warnings").build();
    let pool = state.db_pool.clone();

    let warnings = state
        .cache
        .cached(CacheTier::ShortTerm, cache_key, async move {
            sqlx::query_as::<_, PublicWarning>(ACTIVE_WARNINGS_SQL)
                .fetch_all(&pool)
                .await
                .map_err(|e| {
                    tracing::error!("Failed to fetch public warnings: {}", e);
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Failed to fetch warnings: {}", e),
                    )
                })
        })
        .await?;

    Ok(Json(PublicWarningsResponse {
        warnings,
        action_by_slot: templates::action_by_slot(),
    }))
}
