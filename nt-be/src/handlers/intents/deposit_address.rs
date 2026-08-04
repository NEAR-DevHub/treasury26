use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use chrono::{Duration, Utc};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;
use crate::handlers::balance_changes::confidential_list::is_confidential_dao;
use crate::handlers::intents::confidential::bronze::api::fetch_history;
use crate::utils::cache::{CacheKey, CacheTier};
use crate::utils::jsonrpc::{JsonRpcRequest, JsonRpcResponse};

/// One-time confidential deposit addresses are valid for 14 days from generation.
/// Must stay in sync with the frontend deposit UI (`SINGLE_USE_VALIDITY_MS`).
pub const DEPOSIT_ADDRESS_VALIDITY_DAYS: i64 = 14;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositAddressRequest {
    pub account_id: AccountId,
    pub chain: String,
    pub token_id: Option<String>,
    pub amount: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DepositAddressResult {
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_amount: Option<String>,
    pub memo: Option<String>,
    /// ISO-8601 expiry for one-time confidential deposit addresses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// Intents quote deposit address (confidential). Used for status lookups via
    /// `/v0/account/history?depositAddress=…`. Differs from `address` when the
    /// bridge maps the quote address onto a chain-specific deposit address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote_deposit_address: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositAddressStatusQuery {
    pub account_id: AccountId,
    /// Intents quote deposit address from address generation.
    pub deposit_address: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DepositAddressStatusResult {
    pub deposit_address: String,
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// ISO-8601 expiry (`createdAt + DEPOSIT_ADDRESS_VALIDITY_DAYS`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_asset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_asset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_in_formatted: Option<String>,
}

/// For confidential treasuries, get a confidential quote to obtain the intents
/// deposit address, then fetch the bridge deposit address for that quote address.
///
/// Quote auth uses the app `ONECLICK_API_KEY` only — no DAO JWT required.
async fn get_confidential_deposit_address(
    state: &Arc<AppState>,
    account_id: &near_account_id::AccountIdRef,
    chain: &str,
    token_id: &str,
    mut amount: u128,
) -> Result<DepositAddressResult, (StatusCode, String)> {
    let expires_at = Utc::now() + Duration::days(DEPOSIT_ADDRESS_VALIDITY_DAYS);
    let deadline = expires_at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let account_id = account_id.as_str();

    let url = format!("{}/v0/quote", state.env_vars.confidential_api_url);

    // Try with the FE-provided amount, retrying with 10x increases if too low.
    // Max 5 retries (amount * 10^5) to avoid infinite loops.
    if amount == 0 {
        amount = 1;
    }
    let mut last_error = String::new();

    for attempt in 0..5 {
        let quote_body = serde_json::json!({
            "dry": false,
            "swapType": "EXACT_INPUT",
            "slippageTolerance": 100,
            "originAsset": token_id,
            "depositType": "INTENTS",
            "destinationAsset": token_id,
            "amount": amount.to_string(),
            "refundTo": account_id,
            "refundType": "CONFIDENTIAL_INTENTS",
            "recipient": account_id,
            "recipientType": "CONFIDENTIAL_INTENTS",
            "deadline": &deadline,
            "quoteWaitingTimeMs": 5000,
        });

        // API key is attached in send_oneclick_request; DAO JWT is not required.
        match super::quote::send_oneclick_request(state, &url, &quote_body, None).await {
            Ok(response_body) => {
                let quote_deposit_address = response_body
                    .get("quote")
                    .and_then(|q| q.get("depositAddress"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        (
                            StatusCode::BAD_GATEWAY,
                            "Confidential quote did not return a depositAddress".to_string(),
                        )
                    })?
                    .to_string();

                let mut bridge_result =
                    fetch_bridge_deposit_address(state, &quote_deposit_address, chain).await?;
                bridge_result.min_amount = Some(amount.to_string());
                bridge_result.expires_at = Some(deadline.clone());
                bridge_result.quote_deposit_address = Some(quote_deposit_address);
                return Ok(bridge_result);
            }
            Err((status, msg)) => {
                last_error = msg.clone();
                let is_amount_error = msg.to_lowercase().contains("amount")
                    || msg.to_lowercase().contains("too low")
                    || msg.to_lowercase().contains("minimum");
                if !is_amount_error || attempt == 4 {
                    return Err((status, msg));
                }
                tracing::info!(
                    "Quote amount {} too low (attempt {}), retrying with 10x",
                    amount,
                    attempt + 1
                );
                amount *= 10;
            }
        }
    }

    Err((StatusCode::BAD_GATEWAY, last_error))
}

/// Fetch deposit address from the bridge RPC for a given account and chain.
async fn fetch_bridge_deposit_address(
    state: &Arc<AppState>,
    account_id: &str,
    chain: &str,
) -> Result<DepositAddressResult, (StatusCode, String)> {
    let cache_key = CacheKey::new("bridge:deposit-address")
        .with(account_id)
        .with(chain)
        .build();

    let account_id = account_id.to_string();
    let chain = chain.to_string();
    let state_clone = state.clone();

    state
        .cache
        .cached(CacheTier::LongTerm, cache_key, async move {
            // Try SIMPLE mode first, fall back to MEMO if it fails
            match fetch_deposit_address(&state_clone, &account_id, &chain, "SIMPLE").await {
                Ok(result) => Ok(result),
                Err(_) => fetch_deposit_address(&state_clone, &account_id, &chain, "MEMO").await,
            }
        })
        .await
}

/// Fetch deposit address for a specific account and chain.
/// For confidential treasuries, this first obtains a confidential quote to get
/// an intents deposit address, then fetches the bridge address for that.
///
/// Guests and non-members may generate addresses — depositing funds into a
/// treasury is not a member-only action. Confidential quotes use the app API
/// key (no DAO JWT).
pub async fn get_deposit_address(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DepositAddressRequest>,
) -> Result<Json<DepositAddressResult>, (StatusCode, String)> {
    let account_id = request.account_id.clone();
    let chain = request.chain.clone();

    let confidential = is_confidential_dao(&state.db_pool, account_id.as_str())
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to check confidential status: {}", e),
            )
        })?;

    if confidential {
        let token_id = request.token_id.ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "tokenId is required for confidential treasuries".to_string(),
            )
        })?;
        let amount: u128 = request
            .amount
            .as_deref()
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);
        let result =
            get_confidential_deposit_address(&state, &account_id, &chain, &token_id, amount)
                .await?;
        return Ok(Json(result));
    }

    let result = fetch_bridge_deposit_address(&state, account_id.as_str(), &chain).await?;
    Ok(Json(result))
}

/// Look up confidential deposit status via 1Click history (`depositAddress` filter).
/// Uses the DAO Intents JWT server-side so share pages can poll without membership.
pub async fn get_deposit_address_status(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DepositAddressStatusQuery>,
) -> Result<Json<DepositAddressStatusResult>, (StatusCode, String)> {
    let account_id = query.account_id;
    let deposit_address = query.deposit_address.trim().to_string();
    if deposit_address.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "depositAddress is required".to_string(),
        ));
    }

    let confidential = is_confidential_dao(&state.db_pool, account_id.as_str())
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to check confidential status: {}", e),
            )
        })?;
    if !confidential {
        return Err((
            StatusCode::BAD_REQUEST,
            "Deposit address status is only available for confidential treasuries".to_string(),
        ));
    }

    let page = fetch_history(
        &state,
        &account_id,
        5,
        None,
        None,
        Some(deposit_address.as_str()),
    )
    .await?;

    let item = page.items.into_iter().find(|event| {
        event
            .item
            .deposit_address
            .eq_ignore_ascii_case(&deposit_address)
    });

    match item {
        Some(event) => {
            let expires_at = (event.item.created_at
                + Duration::days(DEPOSIT_ADDRESS_VALIDITY_DAYS))
            .to_rfc3339();
            Ok(Json(DepositAddressStatusResult {
                deposit_address: event.item.deposit_address,
                found: true,
                status: Some(event.item.status),
                created_at: Some(event.item.created_at.to_rfc3339()),
                expires_at: Some(expires_at),
                origin_asset: event.item.origin_asset,
                destination_asset: Some(event.item.destination_asset),
                amount_in_formatted: event.item.amount_in_formatted,
            }))
        }
        None => Ok(Json(DepositAddressStatusResult {
            deposit_address,
            found: false,
            status: None,
            created_at: None,
            expires_at: None,
            origin_asset: None,
            destination_asset: None,
            amount_in_formatted: None,
        })),
    }
}

async fn fetch_deposit_address(
    state: &AppState,
    account_id: &str,
    chain: &str,
    deposit_mode: &str,
) -> Result<DepositAddressResult, String> {
    let rpc_request = JsonRpcRequest::new(
        "depositAddressFetch",
        "deposit_address",
        vec![serde_json::json!({
            "deposit_mode": deposit_mode,
            "account_id": account_id,
            "chain": chain,
        })],
    );

    let response = state
        .http_client
        .post(&state.env_vars.bridge_rpc_url)
        .header("content-type", "application/json")
        .json(&rpc_request)
        .send()
        .await
        .map_err(|e| {
            eprintln!("Error fetching deposit address from bridge: {}", e);
            format!("Failed to fetch deposit address: {}", e)
        })?;

    if !response.status().is_success() {
        return Err(format!("HTTP error! status: {}", response.status()));
    }

    let data = response
        .json::<JsonRpcResponse<DepositAddressResult>>()
        .await
        .map_err(|e| {
            eprintln!("Error parsing bridge response: {}", e);
            "Failed to parse bridge response".to_string()
        })?;

    if let Some(error) = data.error {
        return Err(error.message);
    }

    data.result
        .ok_or_else(|| "No deposit address found".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deposit_address_validity_is_fourteen_days() {
        assert_eq!(DEPOSIT_ADDRESS_VALIDITY_DAYS, 14);
        let expires_at = Utc::now() + Duration::days(DEPOSIT_ADDRESS_VALIDITY_DAYS);
        let remaining = expires_at.signed_duration_since(Utc::now());
        assert!(remaining.num_days() >= 13);
        assert!(remaining.num_days() <= 14);
    }

    #[test]
    fn deposit_address_result_deserializes_without_expires_at() {
        let json = r#"{"address":"abc","memo":null}"#;
        let parsed: DepositAddressResult =
            serde_json::from_str(json).expect("bridge payloads omit expiresAt");
        assert_eq!(parsed.address, "abc");
        assert_eq!(parsed.expires_at, None);
    }
}
