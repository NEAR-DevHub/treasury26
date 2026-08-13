//! Shared client for `GET https://1click.chaindefuser.com/v0/tokens`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;
use crate::utils::cache::CacheTier;

pub const ONECLICK_TOKENS_PATH: &str = "/v0/tokens";

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OneClickToken {
    pub asset_id: String,
    pub decimals: i16,
    pub blockchain: String,
    pub symbol: String,
    #[serde(default)]
    pub price: Option<f64>,
    #[serde(default)]
    pub price_updated_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub contract_address: Option<String>,
    #[serde(default)]
    pub coingecko_id: Option<String>,
}

/// Fetch the 1Click token list (cached LongTerm).
pub async fn fetch_oneclick_tokens(
    state: &Arc<AppState>,
) -> Result<Vec<OneClickToken>, (axum::http::StatusCode, String)> {
    let cache_key = "oneclick:v0:tokens".to_string();
    let state_clone = state.clone();
    state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            fetch_oneclick_tokens_uncached(&state_clone).await
        })
        .await
}

pub async fn fetch_oneclick_tokens_uncached(
    state: &Arc<AppState>,
) -> Result<Vec<OneClickToken>, (axum::http::StatusCode, String)> {
    let url = format!(
        "{}{}",
        state.env_vars.oneclick_api_url.trim_end_matches('/'),
        ONECLICK_TOKENS_PATH
    );
    let mut request = state
        .http_client
        .get(&url)
        .header("accept", "application/json");
    if let Some(api_key) = state.env_vars.oneclick_api_key.as_deref() {
        request = request.header("x-api-key", api_key);
    }
    let response = request.send().await.map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to fetch 1Click tokens: {e}"),
        )
    })?;
    if !response.status().is_success() {
        return Err((
            axum::http::StatusCode::BAD_GATEWAY,
            format!("1Click tokens API error: {}", response.status()),
        ));
    }
    response.json::<Vec<OneClickToken>>().await.map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to parse 1Click tokens response: {e}"),
        )
    })
}
