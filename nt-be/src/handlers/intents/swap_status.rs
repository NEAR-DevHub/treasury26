use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{
    AppState,
    utils::cache::{CacheKey, CacheTier},
};

#[derive(Debug, Deserialize)]
pub struct SwapStatusQuery {
    #[serde(rename = "depositAddress")]
    pub deposit_address: String,
    #[serde(rename = "depositMemo")]
    pub deposit_memo: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SwapStatus {
    KnownDepositTx,
    PendingDeposit,
    IncompleteDeposit,
    Processing,
    Success,
    Refunded,
    Failed,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SimplifiedSwapStatusResponse {
    pub status: SwapStatus,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

// Full response structure for deserialization from 1Click API
#[derive(Debug, Deserialize)]
struct FullSwapStatusResponse {
    status: SwapStatus,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    // Ignore other fields we don't need
    #[serde(flatten)]
    _other: serde_json::Value,
}

pub async fn get_swap_status(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SwapStatusQuery>,
) -> Result<Json<SimplifiedSwapStatusResponse>, (StatusCode, String)> {
    let deposit_address = query.deposit_address;
    let deposit_memo = query.deposit_memo;

    // Create cache key based on deposit address
    let cache_key = CacheKey::new("swap-status")
        .with(&deposit_address)
        .with(&deposit_memo.clone().unwrap_or_default())
        .build();

    let http_client = state.http_client.clone();
    let oneclick_jwt_token = state.env_vars.oneclick_jwt_token.clone();

    let result = state
        .cache
        .cached(CacheTier::ShortTerm, cache_key, async move {
            let mut url = format!(
                "https://1click.chaindefuser.com/v0/status?depositAddress={}",
                deposit_address
            );

            if let Some(memo) = deposit_memo {
                url.push_str(&format!("&depositMemo={}", memo));
            }

            let mut request = http_client.get(&url);

            // Add JWT auth if available
            if let Some(jwt_token) = oneclick_jwt_token.as_ref() {
                request = request.header("Authorization", format!("Bearer {}", jwt_token));
            }

            let response = request.send().await.map_err(|e| {
                log::error!("Error fetching swap status: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to fetch swap status: {}", e),
                )
            })?;

            let status_code = response.status();

            if !status_code.is_success() {
                let error_text = response.text().await.unwrap_or_default();
                log::error!("1Click API error ({}): {}", status_code, error_text);

                return Err((
                    StatusCode::from_u16(status_code.as_u16())
                        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                    format!("1Click API error: {}", error_text),
                ));
            }

            let full_response: FullSwapStatusResponse = response.json().await.map_err(|e| {
                log::error!("Error parsing swap status response: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to parse swap status response: {}", e),
                )
            })?;

            // Return simplified response with only status
            Ok::<_, (StatusCode, String)>(SimplifiedSwapStatusResponse {
                status: full_response.status,
                updated_at: full_response.updated_at,
            })
        })
        .await?;

    Ok(Json(result))
}
