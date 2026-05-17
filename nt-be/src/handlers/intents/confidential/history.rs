//! 1Click confidential account history — fetcher + debug endpoint.
//!
//! Mirrors `@defuse-protocol/one-click-sdk-typescript::AccountService.getHistory`:
//!
//!     GET {HISTORY_BASE_URL}/v0/account/history
//!         ?prevCursor=&nextCursor=&status=&limit=20
//!         &depositAddress=&depositMemo=&search=
//!         &depositType=&recipientType=&refundType=
//!
//! Auth: Bearer `{confidential_access_token}` (the DAO's stored JWT, refreshed
//! via `refresh_dao_jwt`) + optional `x-api-key`. Same scheme as `balances.rs`.
//!
//! NOTE: the host for `q8v3n6.defuse.org` is *different* from the
//! confidential balances host. We let it be overridden via
//! `CONFIDENTIAL_HISTORY_BASE_URL` env var.

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::handlers::intents::confidential::refresh_dao_jwt;

const DEFAULT_HISTORY_BASE_URL: &str = "https://q8v3n6.defuse.org";

fn history_base_url() -> String {
    std::env::var("CONFIDENTIAL_HISTORY_BASE_URL")
        .unwrap_or_else(|_| DEFAULT_HISTORY_BASE_URL.to_string())
}

// ---------------------------------------------------------------------------
// Query parameters — mirror the SDK exactly
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    pub dao_id: String,
    pub prev_cursor: Option<String>,
    pub next_cursor: Option<String>,
    /// Comma-separated list of statuses, e.g. "SUCCESS,PROCESSING".
    /// Valid: PENDING_DEPOSIT, INCOMPLETE_DEPOSIT, PROCESSING, SUCCESS, REFUNDED, FAILED.
    pub status: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: u32,
    pub deposit_address: Option<String>,
    pub deposit_memo: Option<String>,
    pub search: Option<String>,
    /// Comma-separated list, e.g. "ORIGIN_CHAIN,CONFIDENTIAL_INTENTS".
    pub deposit_type: Option<String>,
    pub recipient_type: Option<String>,
    pub refund_type: Option<String>,
}

fn default_limit() -> u32 {
    20
}


#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub deposit_address: String, 
    pub deposit_memo: Option<String>,
    pub status: String,
    pub deposit_type: String,
    pub recipient_type: Option<String>,  
    pub recipient: Option<String>, 
    pub origin_asset: Option<String>,
    pub destination_asset: String,
    pub amount_in_formatted: Option<String>,
    pub amount_in_usd: Option<String>,
    pub amount_out_formatted: Option<String>,
    pub amount_out_usd: Option<String>,
    pub quote_transactions: Option<Vec<QuoteTransaction>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub items: Vec<HistoryItem>,
    pub next_cursor: Option<String>,
    pub prev_cursor: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QuoteTransaction{
    pub sender: String,
    pub tx_hash: String
}

pub async fn fetch_history_with_token(
    state: &AppState,
    account_id: &str,
    limit: u32,
    jwt_token: &str,
    next_cursor: Option<&str>,
    prev_cursor: Option<&str>,
) -> Result<HistoryPage,(StatusCode, String)>{

    let access_token = jwt_token.to_string();

    let base =history_base_url();
    let url = format!("{}/v0/account/history", base);
    let mut params: Vec<(&str, String)> = Vec::new();

    params.push(("limit", limit.to_string()));
    if let Some (forward) = next_cursor {
        params.push(("nextCursor", forward.to_string()));
    };

    if let Some (backward) = prev_cursor {
        params.push(("prevCursor", backward.to_string()));
    }

    let mut req = state
    .http_client
    .get(&url)
    .query(&params)
    .header("Authorization", format!("Bearer {}", access_token));

     if let Some(api_key) = &state.env_vars.oneclick_api_key {
    req = req.header("x-api-key", api_key);
    }

    let resp = req.send().await.map_err(|e|{
        log::error!("[confidential-history] {} request failed: {}", account_id, e);
        (
            StatusCode::BAD_GATEWAY,
            format!("history fetch failed: {}", e),
        )
    } )?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        log::error!(
            "[confidential-history] {} API returned {}: {}",
            account_id,
            status,
            body
        );
        return Err((
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            format!("history API error ({}): {}", status, body),
        ));
    }

    let body_text = resp.text().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("history body read failed: {}", e),
        )
    })?;
    log::debug!(
        "[confidential-history] {} raw response: {}",
        account_id,
        body_text
    );

    let parsed: HistoryPage = serde_json::from_str(&body_text).map_err(|e| {
        log::error!(
            "[confidential-history] {} parse failed: {} (body={})",
            account_id,
            e,
            body_text
        );
        (
            StatusCode::BAD_GATEWAY,
            format!("history parse failed: {}", e),
        )
    })?;
    Ok(parsed)


}


pub async fn fetch_history(state: &AppState,
    account_id: &str,
    limit: u32,
    next_cursor: Option<&str>,
    prev_cursor: Option<&str>
)->Result<HistoryPage, (StatusCode, String)>{
    let jwt_token = refresh_dao_jwt(state, account_id).await?;
    fetch_history_with_token(state, account_id, limit, &jwt_token, next_cursor, prev_cursor).await
}


#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::utils::env::EnvVars;

    /// Helper to create AppState pointing at the real 1Click confidential
    /// history API. Mirrors `generate_intent::tests::create_real_api_state`.
    async fn create_real_api_state() -> Arc<AppState> {
        dotenvy::from_filename(".env").ok();
        dotenvy::from_filename(".env.test").ok();

        let env_vars = EnvVars::default();

        let db_pool = sqlx::postgres::PgPool::connect_lazy(&env_vars.database_url)
            .expect("Failed to create lazy pool");

        Arc::new(
            AppState::builder()
                .db_pool(db_pool)
                .env_vars(env_vars)
                .build()
                .await
                .expect("Failed to build AppState"),
        )
    }


    #[tokio::test]
    async fn test_real_fetch_history() {
        let state = create_real_api_state().await;
        let dao_id = "tobi.sputnik-dao.near";

        println!("=== Fetching confidential history for {} ===", dao_id);
        let page = fetch_history(&state, dao_id, 20, None, None)
            .await
            .unwrap_or_else(|(status, msg)| panic!("fetch_history failed: {} - {}", status, msg));

        println!("items: {}", page.items.len());
        println!("nextCursor: {:?}", page.next_cursor);
        println!("prevCursor: {:?}", page.prev_cursor);
        for (i, item) in page.items.iter().enumerate() {
            println!(
                "  [{}] {} {} → {} status={} recipient={:?}",
                i,
                item.created_at,
                item.origin_asset.as_deref().unwrap_or("-"),
                item.destination_asset,
                item.status,
                item.recipient,
            );
        }
    }

    /// Live integration test: page forward using the `nextCursor` returned by
    /// the first call. Verifies cursor forwarding against the real API.
    ///
    /// Run with: cargo test test_real_fetch_history_pagination -- --ignored --nocapture
    #[tokio::test]
    async fn test_real_fetch_history_pagination() {
        let state = create_real_api_state().await;
        let dao_id = "tobi.sputnik-dao.near";

        let first = fetch_history(&state, dao_id, 5, None, None)
            .await
            .unwrap_or_else(|(s, m)| panic!("first page failed: {} - {}", s, m));

        println!("first page: {} items, nextCursor={:?}", first.items.len(), first.next_cursor);

        let Some(cursor) = first.next_cursor.as_deref() else {
            println!("no nextCursor returned — only one page available, skipping");
            return;
        };

        let second = fetch_history(&state, dao_id, 5, Some(cursor), None)
            .await
            .unwrap_or_else(|(s, m)| panic!("second page failed: {} - {}", s, m));

        println!(
            "second page: {} items, nextCursor={:?}",
            second.items.len(),
            second.next_cursor
        );

        if let (Some(a), Some(b)) = (first.items.first(), second.items.first()) {
            assert_ne!(
                a.deposit_address, b.deposit_address,
                "second page should not start with the same item as the first"
            );
        }
    }
}

