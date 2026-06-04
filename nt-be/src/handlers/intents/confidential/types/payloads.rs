use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;

use super::account_id::bare_account;

/// Deserialized 1Click `/v0/account/history` page.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryApiPage {
    pub items: Vec<HistoryApiItem>,
    pub next_cursor: Option<String>,
    pub prev_cursor: Option<String>,
}

/// One history row from 1Click, including projection fields read by classify.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryApiItem {
    pub created_at: DateTime<Utc>,
    pub deposit_address: String,
    pub deposit_memo: Option<String>,
    pub status: String,
    pub deposit_type: String,
    pub recipient_type: Option<String>,
    pub recipient: Option<String>,
    pub origin_asset: Option<String>,
    pub destination_asset: String,
    #[serde(default)]
    pub amount_in_formatted: Option<String>,
    #[serde(default)]
    pub amount_in_usd: Option<String>,
    #[serde(default)]
    pub amount_out_formatted: Option<String>,
    #[serde(default)]
    pub amount_out_usd: Option<String>,
    #[serde(default)]
    pub refund_to: Option<String>,
    #[serde(default)]
    pub refund_type: Option<String>,
}

/// Wrapper kept for bronze ingest: typed item + original JSON for storage.
#[derive(Debug, Clone)]
pub struct HistoryApiEvent {
    pub item: HistoryApiItem,
    pub raw_payload: Value,
}

/// Typed view of `confidential_intents.quote_metadata` JSONB.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfidentialQuoteMetadata {
    #[serde(default)]
    pub quote: Option<ConfidentialQuoteDetails>,
    #[serde(default)]
    pub quote_request: Option<ConfidentialQuoteRequest>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfidentialQuoteDetails {
    pub deposit_address: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfidentialQuoteRequest {
    pub recipient: Option<String>,
    #[serde(default)]
    pub refund_to: Option<String>,
    #[serde(default)]
    pub recipient_type: Option<String>,
    #[serde(default)]
    pub refund_type: Option<String>,
    #[serde(default)]
    pub origin_asset: Option<String>,
    #[serde(default)]
    pub destination_asset: Option<String>,
}

fn normalize_quote_request_field(quote_request: &mut serde_json::Map<String, Value>, field: &str) {
    let Some(Value::String(value)) = quote_request.get(field).cloned() else {
        return;
    };
    quote_request.insert(field.to_string(), Value::String(bare_account(&value)));
}

/// Strip `chain:` prefixes from account fields in `confidential_intents.quote_metadata` JSONB.
pub fn normalize_quote_metadata_accounts(mut value: Value) -> Value {
    let Some(obj) = value.as_object_mut() else {
        return value;
    };
    if let Some(Value::Object(quote_request)) = obj.get_mut("quoteRequest") {
        normalize_quote_request_field(quote_request, "recipient");
        normalize_quote_request_field(quote_request, "refundTo");
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_api_item_deserializes_sample_row() {
        let raw = serde_json::json!({
            "amountOutFormatted": "0.1",
            "amountOutUsd": "0.1570",
            "createdAt": "2026-05-12T09:05:19.160516Z",
            "depositAddress": "abc",
            "depositType": "CONFIDENTIAL_INTENTS",
            "destinationAsset": "nep141:wrap.near",
            "status": "SUCCESS"
        });
        let item: HistoryApiItem = serde_json::from_value(raw).expect("item should parse");
        assert_eq!(item.deposit_address, "abc");
        assert_eq!(item.amount_out_formatted.as_deref(), Some("0.1"));
    }

    #[test]
    fn confidential_quote_metadata_deserializes_camel_case_quote_request() {
        let raw = serde_json::json!({
            "quote": { "depositAddress": "deposit-abc" },
            "quoteRequest": { "recipient": "bob.near" }
        });
        let meta: ConfidentialQuoteMetadata =
            serde_json::from_value(raw).expect("quote metadata should parse");
        assert_eq!(meta.deposit_address(), Some("deposit-abc"));
        assert_eq!(meta.quote_request_recipient(), Some("bob.near"));
    }

    #[test]
    fn normalize_quote_metadata_keeps_bare_near() {
        let raw = serde_json::json!({
            "quoteRequest": {
                "recipient": "bob.near",
                "recipientType": "CONFIDENTIAL_INTENTS",
                "refundTo": "dao.sputnik-dao.near",
                "refundType": "CONFIDENTIAL_INTENTS",
                "destinationAsset": "nep141:wrap.near"
            }
        });
        let normalized = normalize_quote_metadata_accounts(raw);
        assert_eq!(
            normalized["quoteRequest"]["recipient"].as_str(),
            Some("bob.near")
        );
        assert_eq!(
            normalized["quoteRequest"]["refundTo"].as_str(),
            Some("dao.sputnik-dao.near")
        );
    }

    #[test]
    fn normalize_quote_metadata_keeps_bare_evm() {
        let raw = serde_json::json!({
            "quoteRequest": {
                "recipient": "0xabc123",
                "recipientType": "DESTINATION_CHAIN",
                "originAsset": "nep141:wrap.near",
                "destinationAsset": "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"
            }
        });
        let normalized = normalize_quote_metadata_accounts(raw);
        assert_eq!(
            normalized["quoteRequest"]["recipient"].as_str(),
            Some("0xabc123")
        );
    }

    #[test]
    fn normalize_quote_metadata_strips_near_prefix() {
        let raw = serde_json::json!({
            "quoteRequest": {
                "recipient": "near:bob.near",
                "recipientType": "CONFIDENTIAL_INTENTS"
            }
        });
        let normalized = normalize_quote_metadata_accounts(raw);
        assert_eq!(
            normalized["quoteRequest"]["recipient"].as_str(),
            Some("bob.near")
        );
    }
}

impl ConfidentialQuoteMetadata {
    pub fn from_value(value: &Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }

    pub fn deposit_address(&self) -> Option<&str> {
        self.quote
            .as_ref()
            .and_then(|q| q.deposit_address.as_deref())
    }

    pub fn quote_request_recipient(&self) -> Option<&str> {
        self.quote_request
            .as_ref()
            .and_then(|q| q.recipient.as_deref())
    }
}
