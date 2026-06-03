use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

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

#[derive(Debug, Deserialize)]
pub struct QuoteByDepositAddressQuery {
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

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct QuoteByDepositAddressResponse {
    #[serde(rename = "amountInFormatted")]
    pub amount_in_formatted: Option<String>,
    #[serde(rename = "amountOutFormatted")]
    pub amount_out_formatted: Option<String>,
    #[serde(rename = "amountInUsd")]
    pub amount_in_usd: Option<String>,
    #[serde(rename = "amountOutUsd")]
    pub amount_out_usd: Option<String>,
}

pub type QuoteData = QuoteByDepositAddressResponse;

#[derive(Debug, Deserialize, Clone)]
pub struct FullSwapStatusResponse {
    pub status: SwapStatus,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "quoteResponse")]
    pub quote_response: Option<QuoteEnvelope>,
    #[serde(rename = "swapDetails")]
    pub swap_details: Option<QuoteData>,
    #[serde(flatten)]
    pub _other: serde_json::Value,
}

#[derive(Debug, Deserialize, Clone)]
pub struct QuoteEnvelope {
    pub quote: Option<QuoteData>,
}

pub async fn fetch_swap_status_response(
    http_client: &Client,
    oneclick_api_url: &str,
    oneclick_jwt_token: Option<&String>,
    deposit_address: &str,
    deposit_memo: Option<&str>,
) -> Result<FullSwapStatusResponse, (StatusCode, String)> {
    let url = format!("{}/v0/status", oneclick_api_url.trim_end_matches('/'));
    let mut request = http_client
        .get(&url)
        .query(&[("depositAddress", deposit_address)])
        .timeout(Duration::from_secs(15));

    if let Some(memo) = deposit_memo {
        request = request.query(&[("depositMemo", memo)]);
    }

    if let Some(jwt_token) = oneclick_jwt_token {
        request = request.header("Authorization", format!("Bearer {}", jwt_token));
    }

    let response = request.send().await.map_err(|e| {
        log::error!("Error fetching 1Click status: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to fetch 1Click status: {}", e),
        )
    })?;

    let status_code = response.status();
    if !status_code.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        log::error!("1Click API error ({}): {}", status_code, error_text);
        return Err((
            StatusCode::from_u16(status_code.as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            format!("1Click API error: {}", error_text),
        ));
    }

    response
        .json::<FullSwapStatusResponse>()
        .await
        .map_err(|e| {
            log::error!("Error parsing 1Click status response: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to parse 1Click status response: {}", e),
            )
        })
}

pub fn extract_quote_data(full_response: &FullSwapStatusResponse) -> Option<QuoteData> {
    full_response
        .quote_response
        .as_ref()
        .and_then(|quote_response| quote_response.quote.clone())
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
        .with(deposit_memo.clone().unwrap_or_default())
        .build();

    let http_client = state.http_client.clone();
    let oneclick_jwt_token = state.env_vars.oneclick_jwt_token.clone();
    let oneclick_api_url = state.env_vars.oneclick_api_url.clone();

    let result = state
        .cache
        .cached(CacheTier::ShortTerm, cache_key, async move {
            let full_response = fetch_swap_status_response(
                &http_client,
                &oneclick_api_url,
                oneclick_jwt_token.as_ref(),
                &deposit_address,
                deposit_memo.as_deref(),
            )
            .await?;

            Ok::<_, (StatusCode, String)>(SimplifiedSwapStatusResponse {
                status: full_response.status,
                updated_at: full_response.updated_at,
            })
        })
        .await?;

    Ok(Json(result))
}

pub async fn get_quote_by_deposit_address(
    State(state): State<Arc<AppState>>,
    Query(query): Query<QuoteByDepositAddressQuery>,
) -> Result<Json<QuoteByDepositAddressResponse>, (StatusCode, String)> {
    let deposit_address = query.deposit_address;
    let deposit_memo = query.deposit_memo;

    let cache_key = CacheKey::new("quote-by-deposit-address")
        .with(&deposit_address)
        .with(deposit_memo.clone().unwrap_or_default())
        .build();

    let http_client = state.http_client.clone();
    let oneclick_jwt_token = state.env_vars.oneclick_jwt_token.clone();
    let oneclick_api_url = state.env_vars.oneclick_api_url.clone();

    let result = state
        .cache
        .cached(CacheTier::ShortTerm, cache_key, async move {
            let full_response = fetch_swap_status_response(
                &http_client,
                &oneclick_api_url,
                oneclick_jwt_token.as_ref(),
                &deposit_address,
                deposit_memo.as_deref(),
            )
            .await?;

            if let Some(quote_data) = extract_quote_data(&full_response) {
                return Ok::<_, (StatusCode, String)>(quote_data);
            }

            Ok::<_, (StatusCode, String)>(QuoteByDepositAddressResponse::default())
        })
        .await?;

    Ok(Json(result))
}
