use bigdecimal::BigDecimal;
use serde_json::{Map, Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuoteProposalType {
    AssetExchange,
    PaymentTransfer,
}

impl QuoteProposalType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AssetExchange => "asset_exchange",
            Self::PaymentTransfer => "payment_transfer",
        }
    }
}

impl std::str::FromStr for QuoteProposalType {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "asset_exchange" | "asset-exchange" => Ok(Self::AssetExchange),
            "payment_transfer" | "payment-transfer" => Ok(Self::PaymentTransfer),
            _ => Err(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuoteProposalSnapshot {
    pub quote_type: QuoteProposalType,
    pub deposit_address: String,
    pub recipient: Option<String>,
    pub origin_asset: String,
    pub origin_amount_raw: String,
    pub destination_asset: Option<String>,
    pub signature: Option<String>,
}

impl QuoteProposalSnapshot {
    pub fn to_value(&self) -> Value {
        json!({
            "type": self.quote_type.as_str(),
            "depositAddress": self.deposit_address,
            "recipient": self.recipient,
            "originAsset": self.origin_asset,
            "originAmountRaw": self.origin_amount_raw,
            "destinationAsset": self.destination_asset,
            "signature": self.signature,
        })
    }

    pub fn from_value(value: &Value) -> Option<Self> {
        let quote_type = value
            .get("type")
            .and_then(Value::as_str)
            .and_then(|quote_type| quote_type.parse().ok())?;
        Some(Self {
            quote_type,
            deposit_address: string_field(value, "depositAddress")?,
            recipient: string_field(value, "recipient"),
            origin_asset: string_field(value, "originAsset")?,
            origin_amount_raw: string_field(value, "originAmountRaw")?,
            destination_asset: string_field(value, "destinationAsset"),
            signature: string_field(value, "signature"),
        })
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub fn proposal_quote_from_metadata(metadata: Option<&Value>) -> Option<QuoteProposalSnapshot> {
    QuoteProposalSnapshot::from_value(metadata?.get("proposalQuote")?)
}

pub fn quote_status_value_from_metadata(metadata: Option<&Value>) -> Option<&Value> {
    let metadata = metadata?;
    if metadata.get("proposalQuote").is_some() {
        return metadata.get("status").filter(|status| !status.is_null());
    }
    Some(metadata)
}

pub fn build_quote_metadata(
    existing: Option<&Value>,
    proposal_quote: Option<&QuoteProposalSnapshot>,
    status: Option<Value>,
) -> Option<Value> {
    let mut envelope = existing
        .and_then(Value::as_object)
        .filter(|object| object.contains_key("proposalQuote") || object.contains_key("status"))
        .cloned()
        .unwrap_or_else(Map::new);

    if let Some(proposal_quote) = proposal_quote {
        envelope.insert("proposalQuote".to_string(), proposal_quote.to_value());
    }

    let status = status.or_else(|| quote_status_value_from_metadata(existing).cloned());
    if let Some(status) = status {
        envelope.insert("status".to_string(), status);
    }

    if envelope.is_empty() {
        None
    } else {
        Some(Value::Object(envelope))
    }
}

pub fn merge_quote_status(existing: Option<&Value>, status: Value) -> Value {
    build_quote_metadata(existing, None, Some(status)).unwrap_or_else(|| json!({}))
}

pub fn find_string(value: &Value, key: &str) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let Some(value) = map.get(key).and_then(Value::as_str) {
                return Some(value.to_string());
            }
            for value in map.values() {
                if let Some(found) = find_string(value, key) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(values) => values.iter().find_map(|value| find_string(value, key)),
        _ => None,
    }
}

pub fn quote_status_text_from_metadata(metadata: Option<&Value>) -> Option<String> {
    quote_status_value_from_metadata(metadata)
        .and_then(|status| find_string(status, "status"))
        .map(|status| status.to_ascii_lowercase())
}

pub fn quote_status_is_success(metadata: Option<&Value>) -> bool {
    matches!(
        quote_status_text_from_metadata(metadata).as_deref(),
        Some("success")
    )
}

/// 1Click terminal failure statuses (lowercased), including
/// `INCOMPLETE_DEPOSIT` which the API never advances past.
pub fn quote_status_str_is_failed(status: &str) -> bool {
    matches!(
        status,
        "failed" | "refunded" | "failure" | "incomplete_deposit"
    )
}

pub fn quote_status_is_failed(metadata: Option<&Value>) -> bool {
    quote_status_text_from_metadata(metadata)
        .as_deref()
        .is_some_and(quote_status_str_is_failed)
}

pub fn quote_status_is_terminal(metadata: Option<&Value>) -> bool {
    quote_status_is_success(metadata) || quote_status_is_failed(metadata)
}

pub fn quote_asset_matches_token(quote_asset: &str, token_id: &str) -> bool {
    let quote_asset = quote_asset.trim();
    let token_id = token_id.trim();
    if quote_asset == token_id {
        return true;
    }

    if quote_asset.eq_ignore_ascii_case("near") {
        return matches!(
            token_id,
            "near" | "wrap.near" | "nep141:wrap.near" | "intents.near:nep141:wrap.near"
        );
    }

    if let Some(raw_nep141) = quote_asset.strip_prefix("nep141:") {
        if raw_nep141 == token_id
            || quote_asset == token_id
            || format!("intents.near:{quote_asset}") == token_id
        {
            return true;
        }
        if raw_nep141 == "wrap.near" {
            return matches!(
                token_id,
                "near" | "wrap.near" | "nep141:wrap.near" | "intents.near:nep141:wrap.near"
            );
        }
    }

    if let Some(raw_intents) = quote_asset.strip_prefix("intents.near:") {
        return raw_intents == token_id || quote_asset == token_id;
    }

    token_id
        .strip_prefix("intents.near:")
        .is_some_and(|suffix| suffix == quote_asset || suffix == format!("nep141:{quote_asset}"))
}

pub fn quote_amount_matches(expected: Option<&BigDecimal>, actual_raw: &BigDecimal) -> bool {
    expected.is_none_or(|expected| expected == actual_raw)
}

/// SQL predicate matching an outgoing real silver leg (alias `l`) against a quote
/// proposal (alias `dp`) by dao, deposit address, raw amount, execution-time window,
/// and origin-asset equivalence. SQL counterpart of `quote_asset_matches_token` /
/// `quote_amount_matches`; keep them aligned when either changes.
pub const QUOTE_LEG_MATCH_SQL: &str = r#"
    dp.dao_id = l.account_id
    AND l.direction = 'outgoing'
    AND l.leg_kind <> 'quote_pending'
    AND dp.quote_deposit_address = l.counterparty
    AND dp.quote_metadata->'proposalQuote' IS NOT NULL
    AND dp.quote_metadata->'proposalQuote'->>'originAmountRaw' ~ '^[0-9]+(\.[0-9]+)?$'
    AND l.amount_raw = (dp.quote_metadata->'proposalQuote'->>'originAmountRaw')::numeric
    AND l.block_time >= dp.proposal_executed_at - INTERVAL '5 minutes'
    AND l.block_time <= dp.proposal_executed_at + INTERVAL '1 hour'
    AND (
        dp.quote_metadata->'proposalQuote'->>'originAsset' = l.token_id
        OR (
            dp.quote_metadata->'proposalQuote'->>'originAsset' = 'near'
            AND l.token_id IN ('near', 'wrap.near', 'nep141:wrap.near', 'intents.near:nep141:wrap.near')
        )
        OR (
            dp.quote_metadata->'proposalQuote'->>'originAsset' LIKE 'nep141:%'
            AND (
                substring(dp.quote_metadata->'proposalQuote'->>'originAsset' from 8) = l.token_id
                OR dp.quote_metadata->'proposalQuote'->>'originAsset' = l.token_id
                OR ('intents.near:' || (dp.quote_metadata->'proposalQuote'->>'originAsset')) = l.token_id
            )
        )
        OR (
            dp.quote_metadata->'proposalQuote'->>'originAsset' LIKE 'intents.near:%'
            AND (
                dp.quote_metadata->'proposalQuote'->>'originAsset' = l.token_id
                OR substring(dp.quote_metadata->'proposalQuote'->>'originAsset' from 14) = l.token_id
            )
        )
    )
"#;

pub fn quote_destination_token_id(destination_asset: &str) -> String {
    let destination_asset = destination_asset.trim();
    if destination_asset.eq_ignore_ascii_case("near") {
        return "near".to_string();
    }
    if destination_asset.starts_with("intents.near:") {
        return destination_asset.to_string();
    }
    if destination_asset.starts_with("nep141:") || destination_asset.starts_with("nep245:") {
        return format!("intents.near:{destination_asset}");
    }
    destination_asset.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_preserves_proposal_quote_when_status_is_merged() {
        let quote = QuoteProposalSnapshot {
            quote_type: QuoteProposalType::AssetExchange,
            deposit_address: "deposit".to_string(),
            recipient: None,
            origin_asset: "near".to_string(),
            origin_amount_raw: "100".to_string(),
            destination_asset: Some("nep141:usdc.near".to_string()),
            signature: Some("sig".to_string()),
        };
        let metadata = build_quote_metadata(None, Some(&quote), None).expect("metadata");
        let merged = merge_quote_status(Some(&metadata), json!({ "status": "SUCCESS" }));

        assert_eq!(
            proposal_quote_from_metadata(Some(&merged)).expect("quote"),
            quote
        );
        assert!(quote_status_is_success(Some(&merged)));
    }

    #[test]
    fn incomplete_deposit_is_terminal_and_failed() {
        let envelope = json!({ "status": { "status": "INCOMPLETE_DEPOSIT" } });
        assert!(quote_status_is_terminal(Some(&envelope)));
        assert!(quote_status_is_failed(Some(&envelope)));

        let bare = json!({ "status": "INCOMPLETE_DEPOSIT" });
        assert!(quote_status_is_terminal(Some(&bare)));
        assert!(!quote_status_is_success(Some(&bare)));
    }

    #[test]
    fn destination_token_keeps_intents_style_nep141_id() {
        assert_eq!(
            quote_destination_token_id("nep141:usdt.near"),
            "intents.near:nep141:usdt.near"
        );
    }

    #[test]
    fn near_quote_asset_matches_all_wrap_forms() {
        for token_id in [
            "near",
            "wrap.near",
            "nep141:wrap.near",
            "intents.near:nep141:wrap.near",
        ] {
            assert!(quote_asset_matches_token("near", token_id), "{token_id}");
        }
        assert!(!quote_asset_matches_token("near", "usdt.tether-token.near"));
    }

    #[test]
    fn nep141_quote_asset_matches_bare_and_intents_forms() {
        for token_id in [
            "usdt.tether-token.near",
            "nep141:usdt.tether-token.near",
            "intents.near:nep141:usdt.tether-token.near",
        ] {
            assert!(
                quote_asset_matches_token("nep141:usdt.tether-token.near", token_id),
                "{token_id}"
            );
        }
        assert!(!quote_asset_matches_token(
            "nep141:usdt.tether-token.near",
            "nep141:usdc.near"
        ));
    }

    #[test]
    fn intents_quote_asset_matches_stripped_form() {
        assert!(quote_asset_matches_token(
            "intents.near:nep141:usdt.tether-token.near",
            "nep141:usdt.tether-token.near"
        ));
        assert!(!quote_asset_matches_token(
            "intents.near:nep141:usdt.tether-token.near",
            "nep141:usdc.near"
        ));
    }

    #[test]
    fn amount_match_requires_exact_raw_amount_when_expected() {
        let expected: BigDecimal = "100".parse().unwrap();
        assert!(quote_amount_matches(
            Some(&expected),
            &"100".parse().unwrap()
        ));
        assert!(!quote_amount_matches(
            Some(&expected),
            &"101".parse().unwrap()
        ));
        assert!(quote_amount_matches(None, &"101".parse().unwrap()));
    }
}
