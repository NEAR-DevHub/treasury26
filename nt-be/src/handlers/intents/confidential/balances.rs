//! Shared 1Click balance fetcher.
//!
//! Used both by the user-facing assets endpoint and the balance-change
//! polling worker. Returns raw `(token_id, available)` pairs; callers are
//! responsible for decimal adjustment if needed.

use near_account_id::AccountIdRef;
use reqwest::StatusCode;
use serde::Deserialize;

use crate::AppState;
use crate::handlers::intents::confidential::refresh_dao_jwt;

#[derive(Deserialize, Debug)]
struct BalanceEntry {
    available: String,
    #[serde(rename = "tokenId")]
    token_id: String,
}

#[derive(Deserialize, Debug)]
struct BalancesResponse {
    balances: Vec<BalanceEntry>,
}

/// Fetch confidential balances from the 1Click `/v0/account/balances` endpoint.
///
/// Returns `(token_id, available)` pairs where `token_id` is the raw intents
/// token ID (e.g. `nep141:wrap.near`) and `available` is a base-10 string of
/// the raw on-chain amount (pre-decimal-adjustment). Zero balances are filtered.
pub async fn fetch_confidential_balances(
    state: &AppState,
    dao_id: &AccountIdRef,
) -> Result<Vec<(String, String)>, (StatusCode, String)> {
    let access_token = refresh_dao_jwt(state, dao_id).await?;

    let url = format!(
        "{}/v0/account/balances",
        state.env_vars.confidential_api_url
    );

    let mut req = state
        .http_client
        .get(&url)
        .header("Authorization", format!("Bearer {}", access_token));
    if let Some(api_key) = &state.env_vars.oneclick_api_key {
        req = req.header("x-api-key", api_key);
    }

    let response = req.send().await.map_err(|e| {
        tracing::error!("Error fetching confidential balances for {}: {}", dao_id, e);
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to fetch confidential balances: {}", e),
        )
    })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        tracing::error!("1Click API returned {} for {}: {}", status, dao_id, body);
        return Err((
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            format!("1Click API error: {}", body),
        ));
    }

    let parsed: BalancesResponse = response.json().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to parse confidential balances: {}", e),
        )
    })?;

    Ok(parsed
        .balances
        .into_iter()
        .filter(|b| b.available.parse::<u128>().unwrap_or(0) > 0)
        .map(|b| (b.token_id, b.available))
        .collect())
}
