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
/// Must stay in sync with the frontend (`DEPOSIT_ADDRESS_VALIDITY_MS`).
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
    /// Confidential: 1Click `quote.minAmountIn` (bridge floor). Public: unused/None.
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
pub struct ConfidentialDepositAddressStatusQuery {
    pub account_id: AccountId,
    /// Intents quote deposit address from address generation.
    pub deposit_address: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConfidentialDepositAddressStatusResult {
    pub found: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// ISO-8601 expiry (`createdAt + DEPOSIT_ADDRESS_VALIDITY_DAYS`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// Origin asset / network id for the quote (used by share pages).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_asset: Option<String>,
}

/// Matches near.com confidential deposit slippage (0.1% → 10 bips).
const CONFIDENTIAL_DEPOSIT_SLIPPAGE_TOLERANCE: u32 = 10;

/// For confidential treasuries, mint a one-time 1Click wet quote and return its
/// `depositAddress` (plus memo / bridge floor).
///
/// Quote shape: `FLEX_INPUT` + `INTENTS` deposit type; auth uses the app
/// `ONECLICK_API_KEY` only — no DAO JWT required.
///
/// `DepositAddressResult.min_amount` is always `quote.minAmountIn` (1Click's
/// bridge floor). The FE-supplied `amount` is only used as the quote input and
/// for retry probes when 1Click rejects the amount as too low — it is never
/// returned as `min_amount`.
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

    // Try with the FE-provided amount (usually a UI probe), retrying with the
    // bridge floor from the error (or 10x) when the quote API rejects as too low.
    if amount == 0 {
        amount = 1;
    }
    let mut last_error = String::new();

    for attempt in 0..3 {
        let quote_body = serde_json::json!({
            "dry": false,
            "swapType": "FLEX_INPUT",
            "slippageTolerance": CONFIDENTIAL_DEPOSIT_SLIPPAGE_TOLERANCE,
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
                let quote = response_body.get("quote").ok_or_else(|| {
                    (
                        StatusCode::BAD_GATEWAY,
                        "Confidential quote missing quote object".to_string(),
                    )
                })?;
                let quote_deposit_address = quote
                    .get("depositAddress")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        (
                            StatusCode::BAD_GATEWAY,
                            "Confidential quote did not return a depositAddress".to_string(),
                        )
                    })?
                    .to_string();

                let memo = quote
                    .get("depositMemo")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                // Source of truth for the FE minimum: 1Click bridge floor only.
                let min_amount = quote
                    .get("minAmountIn")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .ok_or_else(|| {
                        (
                            StatusCode::BAD_GATEWAY,
                            "Confidential quote did not return minAmountIn".to_string(),
                        )
                    })?;

                // The quote address lives inside intents.near (INTENTS deposit type);
                // funding it requires the Bridge origin-chain address that forwards to it.
                let mut bridge_result =
                    fetch_bridge_deposit_address(state, &quote_deposit_address, chain).await?;
                bridge_result.min_amount = Some(min_amount);
                if bridge_result.memo.is_none() {
                    bridge_result.memo = memo;
                }
                bridge_result.expires_at = Some(deadline.clone());
                bridge_result.quote_deposit_address = Some(quote_deposit_address);
                return Ok(bridge_result);
            }
            Err((status, msg)) => {
                last_error = msg.clone();
                let is_amount_error = msg.to_lowercase().contains("amount")
                    || msg.to_lowercase().contains("too low")
                    || msg.to_lowercase().contains("minimum");
                if !is_amount_error || attempt == 2 {
                    return Err((status, msg));
                }
                let next_amount = parse_bridge_minimum_hint(&msg)
                    .filter(|n| *n > amount)
                    .unwrap_or_else(|| amount.saturating_mul(10).max(10));
                tracing::info!(
                    "Quote amount {} too low (attempt {}), retrying with {}",
                    amount,
                    attempt + 1,
                    next_amount
                );
                amount = next_amount;
            }
        }
    }

    Err((StatusCode::BAD_GATEWAY, last_error))
}

/// Parse `try at least N` from 1Click bridge-floor errors.
/// Searches and slices the lowercased string so non-ASCII before the marker
/// cannot shift the byte offset relative to the original message.
fn parse_bridge_minimum_hint(msg: &str) -> Option<u128> {
    let lower = msg.to_lowercase();
    let marker = "try at least ";
    let idx = lower.find(marker)?;
    let rest = lower.get(idx + marker.len()..)?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok().filter(|n| *n > 0)
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
///
/// **Public** treasuries use Bridge/POA `depositAddressFetch(account, chain)` —
/// the address is stable for that treasury+chain (same as near.com).
/// **Confidential** treasuries mint a rotating 1Click wet quote (`tokenId`
/// should be the 1Click `quoteAssetId`, which may be `1cs_v1:…`) and return
/// that quote's Bridge origin-chain deposit address plus `minAmountIn`.
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

    let result = fetch_bridge_deposit_address(&state, account_id.as_str(), &chain)
        .await
        .inspect_err(|(status, msg)| {
            if status.is_server_error() {
                crate::error_event!(
                    crate::error_event::ErrorCode::DepositAddressFailed,
                    account_id = %account_id,
                    chain,
                    status = %status,
                    error = %msg
                );
            }
        })?;
    Ok(Json(result))
}

/// Look up confidential one-time deposit status via 1Click history
/// (`depositAddress` filter). Uses the DAO Intents JWT server-side so share
/// pages can poll without membership. Cached briefly to coalesce FE polls.
pub async fn get_confidential_deposit_address_status(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ConfidentialDepositAddressStatusQuery>,
) -> Result<Json<ConfidentialDepositAddressStatusResult>, (StatusCode, String)> {
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

    let cache_key = CacheKey::new("confidential:deposit-address:status")
        .with(account_id.as_str())
        .with(&deposit_address)
        .build();
    let account_id_for_fetch = account_id.clone();
    let deposit_address_for_fetch = deposit_address.clone();
    let state_for_fetch = state.clone();

    // ShortTerm ≈ 5s — covers concurrent share-page polls without stale "used" UI.
    let result = state
        .cache
        .cached(CacheTier::ShortTerm, cache_key, async move {
            fetch_confidential_deposit_address_status_uncached(
                &state_for_fetch,
                &account_id_for_fetch,
                &deposit_address_for_fetch,
            )
            .await
        })
        .await?;

    Ok(Json(result))
}

async fn fetch_confidential_deposit_address_status_uncached(
    state: &AppState,
    account_id: &AccountId,
    deposit_address: &str,
) -> Result<ConfidentialDepositAddressStatusResult, (StatusCode, String)> {
    // One-time quote ids are unique; history is already filtered by depositAddress.
    let page = fetch_history(state, account_id, 1, None, None, Some(deposit_address)).await?;

    match page.items.into_iter().next() {
        Some(event) => {
            let expires_at = (event.item.created_at
                + Duration::days(DEPOSIT_ADDRESS_VALIDITY_DAYS))
            .to_rfc3339();
            Ok(ConfidentialDepositAddressStatusResult {
                found: true,
                status: Some(event.item.status),
                expires_at: Some(expires_at),
                origin_asset: event.item.origin_asset,
            })
        }
        None => Ok(ConfidentialDepositAddressStatusResult {
            found: false,
            status: None,
            expires_at: None,
            origin_asset: None,
        }),
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

    let raw = response.json::<serde_json::Value>().await.map_err(|e| {
        eprintln!("Error parsing bridge response: {}", e);
        "Failed to parse bridge response".to_string()
    })?;

    // Bridge sometimes returns `"error": "Network not supported"` (string) instead
    // of a JSON-RPC `{ code, message }` object.
    if let Some(error) = raw.get("error") {
        if let Some(message) = error.as_str() {
            return Err(message.to_string());
        }
        if let Some(message) = error.get("message").and_then(|m| m.as_str()) {
            return Err(message.to_string());
        }
        return Err(format!("Bridge error: {error}"));
    }

    let data: JsonRpcResponse<DepositAddressResult> = serde_json::from_value(raw).map_err(|e| {
        eprintln!("Error parsing bridge response: {}", e);
        "Failed to parse bridge response".to_string()
    })?;

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

    #[test]
    fn parse_bridge_minimum_hint_reads_try_at_least() {
        assert_eq!(
            parse_bridge_minimum_hint("Amount is too low for bridge, try at least 324044069993519"),
            Some(324044069993519)
        );
        assert_eq!(parse_bridge_minimum_hint("tokenIn is not valid"), None);
        assert_eq!(parse_bridge_minimum_hint("try at least 0"), None);
    }
}
