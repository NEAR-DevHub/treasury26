//! DAO-related API handlers

use axum::{Json, extract::State, http::StatusCode};
use serde::Deserialize;
use std::sync::Arc;

use crate::AppState;
use crate::services::mark_dao_dirty;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkDirtyRequest {
    pub dao_id: String,
}

/// Mark a DAO as dirty, triggering immediate re-sync of membership data
///
/// POST /api/dao/mark-dirty
/// Request body: { "daoId": "treasury.sputnik-dao.near" }
///
/// Returns 200 OK (idempotent - no error if DAO not found)
pub async fn mark_dirty(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<MarkDirtyRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    if payload.dao_id.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "daoId is required".to_string()));
    }

    mark_dao_dirty(&state.db_pool, &payload.dao_id)
        .await
        .map_err(|e| {
            log::error!("Failed to mark DAO {} as dirty: {}", payload.dao_id, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to mark DAO as dirty".to_string(),
            )
        })?;

    Ok(StatusCode::OK)
}
