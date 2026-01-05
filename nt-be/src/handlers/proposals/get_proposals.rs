use axum::{
    Json,
    extract::{Path, RawQuery, State},
    http::StatusCode,
};
use std::sync::Arc;

use crate::AppState;

pub async fn get_proposals(
    State(state): State<Arc<AppState>>,
    Path(dao_id): Path<String>,
    RawQuery(query): RawQuery,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    if dao_id.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "dao_id is required".to_string()));
    }

    // Build URL with query string
    let url = if let Some(q) = query {
        format!(
            "{}/proposals/{}?{}",
            state.env_vars.sputnik_dao_api_base, dao_id, q
        )
    } else {
        format!(
            "{}/proposals/{}",
            state.env_vars.sputnik_dao_api_base, dao_id
        )
    };

    // Forward request to Sputnik DAO API
    let response = state.http_client.get(&url).send().await.map_err(|e| {
        eprintln!("Error fetching proposals from Sputnik DAO API: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to fetch proposals: {}", e),
        )
    })?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        eprintln!("Sputnik DAO API error: {} - {}", status, error_text);
        return Err((
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            format!("Sputnik DAO API error: {}", error_text),
        ));
    }

    // Forward response as-is
    let proposals_response: serde_json::Value = response.json().await.map_err(|e| {
        eprintln!("Error parsing proposals response: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to parse proposals: {}", e),
        )
    })?;

    Ok((StatusCode::OK, Json(proposals_response)))
}

pub async fn get_proposal(
    State(state): State<Arc<AppState>>,
    Path((dao_id, proposal_id)): Path<(String, String)>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    if dao_id.is_empty() || proposal_id.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "proposal_id is required".to_string(),
        ));
    }

    let response = state
        .http_client
        .get(format!(
            "{}/proposal/{}/{}",
            state.env_vars.sputnik_dao_api_base, dao_id, proposal_id
        ))
        .send()
        .await
        .map_err(|e| {
            eprintln!("Error fetching proposal from Sputnik DAO API: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch proposal: {}", e),
            )
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        eprintln!("Sputnik DAO API error: {} - {}", status, error_text);
        return Err((
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            format!("Sputnik DAO API error: {}", error_text),
        ));
    }

    let proposal_response: serde_json::Value = response.json().await.map_err(|e| {
        eprintln!("Error parsing proposal response: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to parse proposal: {}", e),
        )
    })?;

    Ok((StatusCode::OK, Json(proposal_response)))
}
