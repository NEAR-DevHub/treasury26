//! 1Click confidential account history fetcher.
//!
//! Mirrors `@defuse-protocol/one-click-sdk-typescript::AccountService.getHistory`.
//! NOTE: the host for `q8v3n6.defuse.org` is *different* from the
//! confidential balances host. We let it be overridden via
//! `CONFIDENTIAL_HISTORY_BASE_URL` env var.

use near_account_id::AccountIdRef;
use reqwest::StatusCode;
use serde_json::Value;

use crate::AppState;
use crate::handlers::intents::confidential::refresh_dao_jwt;
use crate::handlers::intents::confidential::types::{HistoryApiEvent, HistoryApiItem};

const DEFAULT_HISTORY_BASE_URL: &str = "https://q8v3n6.defuse.org";

fn history_base_url() -> String {
    std::env::var("CONFIDENTIAL_HISTORY_BASE_URL")
        .unwrap_or_else(|_| DEFAULT_HISTORY_BASE_URL.to_string())
}

/// Bronze ingest event: typed API item + original JSON for storage.
pub type HistoryEvent = HistoryApiEvent;

/// Alias for callers that still refer to `HistoryItem`.
pub type HistoryItem = HistoryApiItem;

#[derive(Debug, Clone)]
pub struct HistoryPage {
    pub items: Vec<HistoryEvent>,
    pub next_cursor: Option<String>,
    pub prev_cursor: Option<String>,
}

fn parse_history_page(body_text: &str) -> Result<HistoryPage, String> {
    let raw_page: Value = serde_json::from_str(body_text)
        .map_err(|e| format!("history response is not valid JSON: {}", e))?;

    let items = raw_page
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "history response missing items array".to_string())?
        .iter()
        .enumerate()
        .map(|(idx, raw_item)| {
            let item: HistoryApiItem = serde_json::from_value(raw_item.clone())
                .map_err(|e| format!("history item {} parse failed: {}", idx, e))?;

            Ok(HistoryEvent {
                item,
                raw_payload: raw_item.clone(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(HistoryPage {
        items,
        next_cursor: raw_page
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        prev_cursor: raw_page
            .get("prevCursor")
            .and_then(Value::as_str)
            .map(ToString::to_string),
    })
}

pub async fn fetch_history_with_token(
    state: &AppState,
    account_id: &str,
    limit: u32,
    jwt_token: &str,
    next_cursor: Option<&str>,
    prev_cursor: Option<&str>,
) -> Result<HistoryPage, (StatusCode, String)> {
    let access_token = jwt_token.to_string();

    let base = history_base_url();
    let url = format!("{}/v0/account/history", base);
    let mut params: Vec<(&str, String)> = Vec::new();

    params.push(("limit", limit.to_string()));
    if let Some(forward) = next_cursor {
        params.push(("nextCursor", forward.to_string()));
    };

    if let Some(backward) = prev_cursor {
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

    let resp = req.send().await.map_err(|e| {
        tracing::error!("{} request failed: {}", account_id, e);
        (
            StatusCode::BAD_GATEWAY,
            format!("history fetch failed: {}", e),
        )
    })?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        tracing::error!("{} API returned {}: {}", account_id, status, body);
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

    let parsed = parse_history_page(&body_text).map_err(|e| {
        tracing::error!("{} parse failed: {}", account_id, e);
        (
            StatusCode::BAD_GATEWAY,
            format!("history parse failed: {}", e),
        )
    })?;
    Ok(parsed)
}

pub async fn fetch_history(
    state: &AppState,
    account_id: &AccountIdRef,
    limit: u32,
    next_cursor: Option<&str>,
    prev_cursor: Option<&str>,
) -> Result<HistoryPage, (StatusCode, String)> {
    let jwt_token = refresh_dao_jwt(state, account_id).await?;
    fetch_history_with_token(
        state,
        account_id.as_str(),
        limit,
        &jwt_token,
        next_cursor,
        prev_cursor,
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::utils::env::EnvVars;

    const SAMPLE_HISTORY_RESPONSE: &str = r#"
    {
      "items": [
        {
          "amountInFormatted": "0.1",
          "amountInUsd": "0.1580",
          "amountOutFormatted": "0.157798",
          "amountOutUsd": "0.1578",
          "createdAt": "2026-05-12T09:32:09.214593Z",
          "depositAddress": "217207ee593800d1d536d69a6f8d7b175792ad3a9a744f8b2ef1f1585651f47d",
          "depositMemo": null,
          "depositType": "CONFIDENTIAL_INTENTS",
          "destinationAsset": "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
          "originAsset": "nep141:wrap.near",
          "recipient": "tobi.sputnik-dao.near",
          "recipientType": "CONFIDENTIAL_INTENTS",
          "refundFee": "0",
          "refundFeeFormatted": "0.0",
          "refundReason": null,
          "refundTo": "tobi.sputnik-dao.near",
          "refundType": "CONFIDENTIAL_INTENTS",
          "refundedAmountFormatted": "0",
          "refundedAmountUsd": "0",
          "status": "SUCCESS"
        },
        {
          "amountOutFormatted": "0.1",
          "amountOutUsd": "0.1570",
          "createdAt": "2026-05-12T09:05:19.160516Z",
          "depositAddress": "b9c773cbcdc6d1cc56acdf8b352fa42039f04c2ae553ca41cc9b0d950b9b0339",
          "depositMemo": null,
          "depositType": "CONFIDENTIAL_INTENTS",
          "destinationAsset": "nep141:wrap.near",
          "recipient": "tobi.sputnik-dao.near",
          "recipientType": "CONFIDENTIAL_INTENTS",
          "refundType": "CONFIDENTIAL_INTENTS",
          "status": "SUCCESS"
        }
      ],
      "nextCursor": "next-cursor",
      "prevCursor": "prev-cursor"
    }
    "#;

    #[test]
    fn test_parse_history_page_preserves_raw_payload() {
        let page = parse_history_page(SAMPLE_HISTORY_RESPONSE).expect("sample should parse");

        assert_eq!(page.items.len(), 2);
        assert_eq!(page.next_cursor.as_deref(), Some("next-cursor"));
        assert_eq!(page.prev_cursor.as_deref(), Some("prev-cursor"));

        let first = &page.items[0];
        assert_eq!(first.item.status, "SUCCESS");
        assert_eq!(
            first.item.deposit_address,
            "217207ee593800d1d536d69a6f8d7b175792ad3a9a744f8b2ef1f1585651f47d"
        );
        assert_eq!(
            first.raw_payload.get("refundFee").and_then(Value::as_str),
            Some("0")
        );
        assert_eq!(
            first.raw_payload.get("refundTo").and_then(Value::as_str),
            Some("tobi.sputnik-dao.near")
        );

        let second = &page.items[1];
        assert!(second.item.origin_asset.is_none());
        assert_eq!(second.item.destination_asset, "nep141:wrap.near");
    }

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
    #[ignore]
    async fn test_real_fetch_history() {
        let state = create_real_api_state().await;
        let dao_id = AccountIdRef::new("tobi.sputnik-dao.near").unwrap();

        println!("=== Fetching confidential history for {} ===", dao_id);
        let page = fetch_history(&state, dao_id, 20, None, None)
            .await
            .unwrap_or_else(|(status, msg)| panic!("fetch_history failed: {} - {}", status, msg));

        println!("items: {}", page.items.len());
        println!("nextCursor: {:?}", page.next_cursor);
        println!("prevCursor: {:?}", page.prev_cursor);
        for (i, event) in page.items.iter().enumerate() {
            let item = &event.item;
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
    #[ignore]
    async fn test_real_fetch_history_pagination() {
        let state = create_real_api_state().await;
        let dao_id = AccountIdRef::new("tobi.sputnik-dao.near").unwrap();

        let first = fetch_history(&state, dao_id, 5, None, None)
            .await
            .unwrap_or_else(|(s, m)| panic!("first page failed: {} - {}", s, m));

        println!(
            "first page: {} items, nextCursor={:?}",
            first.items.len(),
            first.next_cursor
        );

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
                a.item.deposit_address, b.item.deposit_address,
                "second page should not start with the same item as the first"
            );
        }
    }
}
