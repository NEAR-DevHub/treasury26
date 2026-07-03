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
    handlers::balance_changes::confidential_list::is_confidential_dao,
    utils::cache::{CacheKey, CacheTier},
};

#[derive(Debug, Deserialize)]
pub struct SwapStatusQuery {
    #[serde(rename = "depositAddress")]
    pub deposit_address: String,
    #[serde(rename = "depositMemo")]
    pub deposit_memo: Option<String>,
    /// Treasury account id. Confidential treasuries read status from bronze;
    /// others fall through to 1Click `/v0/status`.
    #[serde(rename = "daoId")]
    pub dao_id: Option<String>,
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

/// Fetch swap status for a public (non-confidential) treasury from the 1Click
/// `/v0/status` endpoint.
pub async fn fetch_public_swap_status(
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
        tracing::error!("Error fetching 1Click status: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to fetch 1Click status: {}", e),
        )
    })?;

    let status_code = response.status();
    if !status_code.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        tracing::error!("1Click API error ({}): {}", status_code, error_text);
        return Err((
            StatusCode::from_u16(status_code.as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            format!("1Click API error: {}", error_text),
        ));
    }

    response
        .json::<FullSwapStatusResponse>()
        .await
        .map_err(|e| {
            tracing::error!("Error parsing 1Click status response: {}", e);
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

/// Map a bronze history `status` string onto [`SwapStatus`]; unknown values
/// fall back to `Processing`.
fn map_history_status(raw: &str) -> SwapStatus {
    match raw.trim().to_ascii_uppercase().as_str() {
        "SUCCESS" => SwapStatus::Success,
        "REFUNDED" => SwapStatus::Refunded,
        "FAILED" => SwapStatus::Failed,
        "PENDING_DEPOSIT" => SwapStatus::PendingDeposit,
        "INCOMPLETE_DEPOSIT" => SwapStatus::IncompleteDeposit,
        "KNOWN_DEPOSIT_TX" => SwapStatus::KnownDepositTx,
        _ => SwapStatus::Processing,
    }
}

/// Read confidential swap status from bronze. `None` means not yet ingested.
pub async fn fetch_confidential_swap_status(
    pool: &sqlx::PgPool,
    dao_id: &str,
    deposit_address: &str,
) -> Result<Option<SimplifiedSwapStatusResponse>, (StatusCode, String)> {
    let row = sqlx::query_as::<_, (String, chrono::DateTime<chrono::Utc>)>(
        r#"
        SELECT status, created_at_external
        FROM bronze_confidential_history_events
        WHERE account_id = $1
          AND deposit_address = $2
        ORDER BY created_at_external DESC
        LIMIT 1
        "#,
    )
    .bind(dao_id)
    .bind(deposit_address)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!("confidential swap status query failed: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to load confidential swap status: {}", e),
        )
    })?;

    Ok(row.map(
        |(status, created_at_external)| SimplifiedSwapStatusResponse {
            status: map_history_status(&status),
            updated_at: created_at_external.to_rfc3339(),
        },
    ))
}

pub async fn get_swap_status(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SwapStatusQuery>,
) -> Result<Json<SimplifiedSwapStatusResponse>, (StatusCode, String)> {
    let deposit_address = query.deposit_address;
    let deposit_memo = query.deposit_memo;
    let dao_id = query.dao_id;

    let cache_key = CacheKey::new("swap-status")
        .with(&deposit_address)
        .with(deposit_memo.clone().unwrap_or_default())
        .with(dao_id.clone().unwrap_or_default())
        .build();

    let http_client = state.http_client.clone();
    let oneclick_jwt_token = state.env_vars.oneclick_jwt_token.clone();
    let oneclick_api_url = state.env_vars.oneclick_api_url.clone();
    let db_pool = state.db_pool.clone();

    let result = state
        .cache
        .cached(CacheTier::ShortTerm, cache_key, async move {
            // Resolve the confidential treasury id up front so the two status
            // sources read as equal-level alternatives below (confidential
            // treasuries read from our own store; public ones hit 1Click).
            let confidential_dao_id = match dao_id.as_deref() {
                Some(dao_id)
                    if is_confidential_dao(&db_pool, dao_id).await.map_err(|e| {
                        (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            format!("Failed to check confidential treasury: {}", e),
                        )
                    })? =>
                {
                    Some(dao_id.to_string())
                }
                _ => None,
            };

            if let Some(dao_id) = confidential_dao_id {
                // Not ingested yet → PROCESSING so the UI shows a pending state
                // rather than nothing.
                Ok::<_, (StatusCode, String)>(
                    fetch_confidential_swap_status(&db_pool, &dao_id, &deposit_address)
                        .await?
                        .unwrap_or_else(|| SimplifiedSwapStatusResponse {
                            status: SwapStatus::Processing,
                            updated_at: chrono::Utc::now().to_rfc3339(),
                        }),
                )
            } else {
                let full_response = fetch_public_swap_status(
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
            }
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
            let full_response = fetch_public_swap_status(
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
