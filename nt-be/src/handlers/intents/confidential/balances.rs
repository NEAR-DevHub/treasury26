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
use crate::observability::sanitize_sensitive_text;

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

/// Result of a confidential balance fetch. `unparseable_assets` lists tokens
/// present in the response whose `available` amount was not a valid integer;
/// callers must not treat them as zero/disappeared.
#[derive(Debug, Default)]
pub struct ConfidentialBalanceFetch {
    pub balances: Vec<(String, String)>,
    pub unparseable_assets: Vec<String>,
}

/// Fetch confidential balances from the 1Click `/v0/account/balances` endpoint.
///
/// `balances` holds `(token_id, available)` pairs where `token_id` is the raw
/// intents token ID (e.g. `nep141:wrap.near`) and `available` is a base-10
/// string of the raw on-chain amount (pre-decimal-adjustment). Zero balances
/// are filtered.
#[tracing::instrument(level = "debug", skip_all, fields(dao_id = %dao_id))]
pub async fn fetch_confidential_balances(
    state: &AppState,
    dao_id: &AccountIdRef,
) -> Result<ConfidentialBalanceFetch, (StatusCode, String)> {
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
        let sanitized_body = sanitize_sensitive_text(&body);
        tracing::error!(
            "1Click API returned {} for {}: {}",
            status,
            dao_id,
            sanitized_body
        );
        return Err((
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            format!("1Click API error: {}", sanitized_body),
        ));
    }

    let parsed: BalancesResponse = response.json().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to parse confidential balances: {}", e),
        )
    })?;

    let mut balances = Vec::with_capacity(parsed.balances.len());
    let mut unparseable_assets = Vec::new();
    for entry in parsed.balances {
        match entry.available.parse::<u128>() {
            Ok(0) => {}
            Ok(_) => balances.push((entry.token_id, entry.available)),
            Err(e) => {
                tracing::warn!(
                    "{} unparseable available amount for {}: {}",
                    dao_id,
                    entry.token_id,
                    e
                );
                unparseable_assets.push(entry.token_id);
            }
        }
    }

    Ok(ConfidentialBalanceFetch {
        balances,
        unparseable_assets,
    })
}
