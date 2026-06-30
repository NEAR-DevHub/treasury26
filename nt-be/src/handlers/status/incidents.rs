use axum::{Json, extract::State, http::HeaderMap};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

use crate::{AppState, handlers::warnings::admin::require_admin};

use super::oh_dear::{self, IntentsStatusPost, SUPPORTED_SERVICES};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub service: String,
    pub status: String,
    pub last_checked: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusIncidentsResponse {
    pub intents_posts: Vec<IntentsStatusPost>,
    pub services: Vec<ServiceStatus>,
}

pub async fn get_status_incidents(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<StatusIncidentsResponse>, (axum::http::StatusCode, Json<Value>)> {
    let _admin = require_admin(&headers, &state).map_err(|_| {
        (
            axum::http::StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "unauthorized" })),
        )
    })?;

    let intents_posts = match oh_dear::fetch_intents_posts(&state).await {
        Ok(posts) => posts,
        Err(e) => {
            tracing::warn!("[status-incidents] Failed to fetch intents posts: {e}");
            vec![]
        }
    };

    #[derive(sqlx::FromRow)]
    struct IncidentRow {
        service: String,
        status: String,
        last_failed_at: DateTime<Utc>,
    }

    let active_incidents = sqlx::query_as::<_, IncidentRow>(
        r#"
        SELECT service, status, last_failed_at
        FROM status_incidents
        WHERE recovered_at IS NULL
        "#,
    )
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| {
        tracing::error!("[status-incidents] Failed to load active incidents: {e}");
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to load status incidents." })),
        )
    })?;

    let services: Vec<ServiceStatus> = SUPPORTED_SERVICES
        .iter()
        .map(|&svc| {
            let incident = active_incidents.iter().find(|i| i.service == svc);
            ServiceStatus {
                service: svc.to_string(),
                status: incident.map_or("ok".to_string(), |i| i.status.clone()),
                last_checked: incident.map(|i| i.last_failed_at),
            }
        })
        .collect();

    Ok(Json(StatusIncidentsResponse {
        intents_posts,
        services,
    }))
}
