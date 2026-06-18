use std::sync::Arc;

use axum::{Json, extract::State};
use reqwest::StatusCode;
use serde::Deserialize;

use crate::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhitelistRequestBody {
    pub contact: String,
    pub account_id: Option<String>,
}

pub async fn submit_whitelist_request(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<WhitelistRequestBody>,
) -> Result<(), (StatusCode, String)> {
    let account_part = payload
        .account_id
        .as_deref()
        .map(|id| format!("\nNEAR account: {id}"))
        .unwrap_or_default();

    let message = format!(
        "📋 Treasury whitelist request\nContact: {}{}",
        payload.contact, account_part,
    );

    state
        .telegram_client
        .send_message(&message)
        .await
        .map_err(|e| {
            tracing::warn!("Failed to send whitelist request to Telegram: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        })?;

    Ok(())
}
