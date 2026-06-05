use std::collections::HashMap;
use std::str::FromStr;

use bigdecimal::{BigDecimal, Zero};
use serde_json::Value;

use super::models::{BronzeProjectionRow, GoldHistoryEvent};
use crate::handlers::intents::confidential::types::{
    ConfidentialTxType, DepositType, HistoryApiItem, accounts_equal, bare_account,
};

enum Classification {
    Project(ConfidentialTxType),
    Skip,
}

fn normalized_str(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty()
        || value.eq_ignore_ascii_case("null")
        || value.eq_ignore_ascii_case("undefined")
    {
        return None;
    }
    Some(value.to_string())
}

fn payload_str(payload: &Value, key: &str) -> Option<String> {
    normalized_str(payload.get(key).and_then(|value| value.as_str()))
}

fn history_api_item(payload: &Value) -> Option<HistoryApiItem> {
    serde_json::from_value(payload.clone()).ok()
}

fn coalesce_str(primary: Option<&String>, payload: &Value, key: &str) -> Option<String> {
    normalized_str(primary.map(String::as_str)).or_else(|| payload_str(payload, key))
}

fn resolve_account(
    stored: Option<&String>,
    payload: &Value,
    field: &str,
) -> Result<String, String> {
    let raw = coalesce_str(stored, payload, field).ok_or_else(|| format!("missing {field}"))?;
    Ok(bare_account(&raw))
}

fn parse_decimal(value: Option<String>, field: &str) -> Result<BigDecimal, String> {
    let Some(value) = value else {
        return Err(format!("missing {}", field));
    };
    BigDecimal::from_str(&value).map_err(|e| format!("invalid {} '{}': {}", field, value, e))
}

fn parse_optional_decimal(
    value: Option<String>,
    field: &str,
) -> Result<Option<BigDecimal>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    BigDecimal::from_str(&value)
        .map(Some)
        .map_err(|e| format!("invalid {} '{}': {}", field, value, e))
}

fn classify(
    dao_id: &str,
    recipient: &str,
    origin_asset: Option<&str>,
    destination_asset: &str,
) -> Classification {
    // Self-deposit/exchange when recipient matches this DAO (bare or prefixed).
    let is_self = accounts_equal(recipient, dao_id);

    if !is_self && origin_asset.is_none() {
        return Classification::Skip;
    }

    if !is_self {
        return Classification::Project(ConfidentialTxType::Sent);
    }

    if let Some(origin_asset) = origin_asset
        && origin_asset != destination_asset
    {
        return Classification::Project(ConfidentialTxType::Exchange);
    }

    Classification::Project(ConfidentialTxType::Deposit)
}

fn is_intents_to_confidential_deposit(row: &BronzeProjectionRow) -> bool {
    let deposit_type = DepositType::parse(&row.deposit_type);
    let recipient_type = row
        .recipient_type
        .as_deref()
        .map(DepositType::parse)
        .unwrap_or(DepositType::Other);

    deposit_type == DepositType::Intents && recipient_type == DepositType::ConfidentialIntents
}

pub(crate) fn project_row(
    row: &BronzeProjectionRow,
    ledger: &mut HashMap<String, BigDecimal>,
) -> Result<Option<GoldHistoryEvent>, String> {
    let dao_id = row.account_id.clone();
    // Parse the DAO account id up front: it is the only fallible step that would
    // otherwise run *after* the ledger has been mutated below. Failing here keeps
    // the invariant that project_row never mutates `ledger` before returning Err,
    // so the caller can safely reuse the ledger across rows that error.
    let dao_account_id = dao_id
        .parse::<near_api::AccountId>()
        .map_err(|e| format!("invalid dao_id: {e}"))?;
    let origin_asset_opt = coalesce_str(row.origin_asset.as_ref(), &row.raw_payload, "originAsset");
    let destination_asset_opt = coalesce_str(
        Some(&row.destination_asset),
        &row.raw_payload,
        "destinationAsset",
    );
    let recipient = resolve_account(row.recipient.as_ref(), &row.raw_payload, "recipient")?;
    let destination_asset =
        destination_asset_opt.ok_or_else(|| "missing destinationAsset".to_string())?;
    let origin_asset = origin_asset_opt;
    let deposit_address = coalesce_str(
        Some(&row.deposit_address),
        &row.raw_payload,
        "depositAddress",
    )
    .ok_or_else(|| "missing depositAddress".to_string())?;

    let Classification::Project(kind) = classify(
        &dao_id,
        &recipient,
        origin_asset.as_deref(),
        &destination_asset,
    ) else {
        return Ok(None);
    };

    let api = history_api_item(&row.raw_payload);
    let amount_out = parse_decimal(
        api.as_ref()
            .and_then(|i| i.amount_out_formatted.clone())
            .or_else(|| payload_str(&row.raw_payload, "amountOutFormatted")),
        "amountOutFormatted",
    )?;
    let amount_out_usd = parse_optional_decimal(
        api.as_ref()
            .and_then(|i| i.amount_out_usd.clone())
            .or_else(|| payload_str(&row.raw_payload, "amountOutUsd")),
        "amountOutUsd",
    )?;
    let amount_in_usd = parse_optional_decimal(
        api.as_ref()
            .and_then(|i| i.amount_in_usd.clone())
            .or_else(|| payload_str(&row.raw_payload, "amountInUsd")),
        "amountInUsd",
    )?;

    let amount_in = match kind {
        ConfidentialTxType::Sent | ConfidentialTxType::Exchange => Some(parse_decimal(
            payload_str(&row.raw_payload, "amountInFormatted"),
            "amountInFormatted",
        )?),
        ConfidentialTxType::Deposit if origin_asset.is_some() => Some(parse_decimal(
            payload_str(&row.raw_payload, "amountInFormatted"),
            "amountInFormatted",
        )?),
        ConfidentialTxType::Deposit => None,
    };

    let zero = BigDecimal::zero();
    let amount_in_usd_for_delta = amount_in_usd.clone().unwrap_or_else(BigDecimal::zero);
    let amount_out_usd_for_delta = amount_out_usd.clone().unwrap_or_else(BigDecimal::zero);
    let intents_to_confidential_deposit =
        kind == ConfidentialTxType::Deposit && is_intents_to_confidential_deposit(row);

    let (
        origin_balance_before,
        origin_balance_after,
        destination_balance_before,
        destination_balance_after,
        usd_change,
    ) = match kind {
        ConfidentialTxType::Sent => {
            let origin_asset = origin_asset
                .as_ref()
                .ok_or_else(|| "missing originAsset for sent".to_string())?;
            let amount_in = amount_in
                .as_ref()
                .ok_or_else(|| "missing amountInFormatted for sent".to_string())?;
            let before = ledger
                .get(origin_asset)
                .cloned()
                .unwrap_or_else(BigDecimal::zero);
            let mut after = &before - amount_in;
            if after < zero {
                after = BigDecimal::zero();
            }
            ledger.insert(origin_asset.clone(), after.clone());
            (
                Some(before),
                Some(after),
                None,
                None,
                -amount_in_usd_for_delta,
            )
        }
        ConfidentialTxType::Exchange => {
            let origin_asset = origin_asset
                .as_ref()
                .ok_or_else(|| "missing originAsset for exchange".to_string())?;
            let amount_in = amount_in
                .as_ref()
                .ok_or_else(|| "missing amountInFormatted for exchange".to_string())?;
            let origin_before = ledger
                .get(origin_asset)
                .cloned()
                .unwrap_or_else(BigDecimal::zero);
            let mut origin_after = &origin_before - amount_in;
            if origin_after < zero {
                origin_after = BigDecimal::zero();
            }
            ledger.insert(origin_asset.clone(), origin_after.clone());

            let destination_before = ledger
                .get(&destination_asset)
                .cloned()
                .unwrap_or_else(BigDecimal::zero);
            let destination_after = &destination_before + &amount_out;
            ledger.insert(destination_asset.clone(), destination_after.clone());
            (
                Some(origin_before),
                Some(origin_after),
                Some(destination_before),
                Some(destination_after),
                amount_out_usd_for_delta - amount_in_usd_for_delta,
            )
        }
        ConfidentialTxType::Deposit => {
            let destination_before = ledger
                .get(&destination_asset)
                .cloned()
                .unwrap_or_else(BigDecimal::zero);
            let net_amount = match amount_in.as_ref() {
                Some(amount_in) if origin_asset.as_deref() == Some(destination_asset.as_str()) => {
                    if intents_to_confidential_deposit {
                        amount_out.clone()
                    } else {
                        &amount_out - amount_in
                    }
                }
                _ => amount_out.clone(),
            };
            let mut destination_after = &destination_before + &net_amount;
            if destination_after < zero {
                destination_after = BigDecimal::zero();
            }
            ledger.insert(destination_asset.clone(), destination_after.clone());
            (
                None,
                None,
                Some(destination_before),
                Some(destination_after),
                if intents_to_confidential_deposit {
                    amount_out_usd_for_delta
                } else {
                    amount_out_usd_for_delta - amount_in_usd_for_delta
                },
            )
        }
    };

    let refund_to_raw = api
        .as_ref()
        .and_then(|i| i.refund_to.clone())
        .or_else(|| payload_str(&row.raw_payload, "refundTo"));
    let refund_to = match refund_to_raw {
        Some(raw) => bare_account(&raw),
        None => bare_account(row.account_id.as_str()),
    };
    let counterparty = match kind {
        ConfidentialTxType::Sent => recipient.clone(),
        ConfidentialTxType::Exchange | ConfidentialTxType::Deposit => bare_account("intents.near"),
    };

    Ok(Some(GoldHistoryEvent {
        history_event_id: row.id,
        intent_id: row.intent_id,
        dao_id: dao_account_id,
        transaction_type: kind,
        origin_asset,
        destination_asset,
        amount_in,
        amount_out,
        amount_in_usd,
        amount_out_usd,
        usd_change,
        origin_balance_before,
        origin_balance_after,
        destination_balance_before,
        destination_balance_after,
        recipient,
        refund_to,
        counterparty,
        deposit_address,
        deposit_memo: row
            .deposit_memo
            .clone()
            .or_else(|| payload_str(&row.raw_payload, "depositMemo")),
        block_height: row.execution_block_height,
        block_time: row.executed_at,
        transaction_hash: row.execution_transaction_hash.clone(),
        quote_created_at: row.created_at_external,
        proposal_created_at: row.proposal_created_at,
        executed_at: row.executed_at,
    }))
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;

    fn payload(fields: &[(&str, Value)]) -> Value {
        let mut map = serde_json::Map::new();
        for (key, value) in fields {
            map.insert((*key).to_string(), value.clone());
        }
        Value::Object(map)
    }

    fn row(
        dao_id: &str,
        recipient: Option<&str>,
        origin_asset: Option<&str>,
        destination_asset: &str,
        raw_payload: Value,
    ) -> BronzeProjectionRow {
        BronzeProjectionRow {
            id: 1,
            account_id: dao_id.to_string(),
            created_at_external: Utc::now(),
            deposit_address: "deposit-address".to_string(),
            deposit_memo: None,
            deposit_type: "CONFIDENTIAL_INTENTS".to_string(),
            recipient_type: Some("CONFIDENTIAL_INTENTS".to_string()),
            recipient: recipient.map(ToString::to_string),
            origin_asset: origin_asset.map(ToString::to_string),
            destination_asset: destination_asset.to_string(),
            raw_payload,
            intent_id: None,
            proposal_created_at: None,
            executed_at: None,
            execution_block_height: None,
            execution_transaction_hash: None,
        }
    }

    fn recipient(value: &str) -> String {
        bare_account(value)
    }

    #[test]
    fn test_classification_rules() {
        assert!(matches!(
            classify(
                "dao.near",
                recipient("external.near").as_str(),
                None,
                "nep141:wrap.near"
            ),
            Classification::Skip
        ));
        assert!(matches!(
            classify(
                "dao.near",
                recipient("external.near").as_str(),
                Some("nep141:wrap.near"),
                "nep141:wrap.near"
            ),
            Classification::Project(ConfidentialTxType::Sent)
        ));
        assert!(matches!(
            classify(
                "dao.near",
                recipient("dao.near").as_str(),
                Some("nep141:usdt.near"),
                "nep141:wrap.near"
            ),
            Classification::Project(ConfidentialTxType::Exchange)
        ));
        assert!(matches!(
            classify(
                "dao.near",
                recipient("dao.near").as_str(),
                None,
                "nep141:wrap.near"
            ),
            Classification::Project(ConfidentialTxType::Deposit)
        ));
    }

    #[test]
    fn test_classification_strips_near_prefix() {
        assert!(matches!(
            classify(
                "tobi.sputnik-dao.near",
                recipient("near:tobi.sputnik-dao.near").as_str(),
                None,
                "nep141:wrap.near"
            ),
            Classification::Project(ConfidentialTxType::Deposit)
        ));
        assert!(matches!(
            classify(
                "tobi.sputnik-dao.near",
                recipient("near:tobi.sputnik-dao.near").as_str(),
                Some("nep141:usdt.near"),
                "nep141:wrap.near"
            ),
            Classification::Project(ConfidentialTxType::Exchange)
        ));
        assert!(matches!(
            classify(
                "tobi.sputnik-dao.near",
                recipient("near:external.near").as_str(),
                Some("nep141:wrap.near"),
                "nep141:wrap.near"
            ),
            Classification::Project(ConfidentialTxType::Sent)
        ));
    }

    #[test]
    fn test_project_sent_decreases_only_origin_balance() {
        let raw_payload = payload(&[
            ("recipient", Value::String("external.near".to_string())),
            ("amountInFormatted", Value::String("2.5".to_string())),
            ("amountOutFormatted", Value::String("2.4".to_string())),
            ("amountInUsd", Value::String("2.5".to_string())),
            ("amountOutUsd", Value::String("2.4".to_string())),
        ]);
        let row = row(
            "dao.near",
            Some("external.near"),
            Some("nep141:usdt.near"),
            "nep141:wrap.near",
            raw_payload,
        );
        let mut ledger = HashMap::from([("nep141:usdt.near".to_string(), BigDecimal::from(10))]);

        let projected = project_row(&row, &mut ledger)
            .expect("sent row should project")
            .expect("sent row should not skip");

        assert_eq!(projected.transaction_type, ConfidentialTxType::Sent);
        assert_eq!(projected.origin_balance_before, Some(BigDecimal::from(10)));
        assert_eq!(
            projected.origin_balance_after,
            Some(BigDecimal::from_str("7.5").unwrap())
        );
        assert!(projected.destination_balance_before.is_none());
        assert_eq!(
            ledger.get("nep141:usdt.near"),
            Some(&BigDecimal::from_str("7.5").unwrap())
        );
        assert!(ledger.get("nep141:wrap.near").is_none());
    }

    #[test]
    fn test_project_intents_to_confidential_same_asset_deposit_credits_balance() {
        let raw_payload = payload(&[
            ("depositType", Value::String("INTENTS".to_string())),
            (
                "recipientType",
                Value::String("CONFIDENTIAL_INTENTS".to_string()),
            ),
            ("amountInFormatted", Value::String("0.001".to_string())),
            ("amountOutFormatted", Value::String("0.001".to_string())),
            ("amountInUsd", Value::String("0.0010".to_string())),
            ("amountOutUsd", Value::String("0.0010".to_string())),
        ]);
        let mut row = row(
            "dao.near",
            Some("dao.near"),
            Some("nep141:usdt.near"),
            "nep141:usdt.near",
            raw_payload,
        );
        row.deposit_type = "INTENTS".to_string();
        row.recipient_type = Some("CONFIDENTIAL_INTENTS".to_string());
        let mut ledger = HashMap::new();

        let projected = project_row(&row, &mut ledger)
            .expect("deposit should project")
            .expect("deposit should not skip");

        assert_eq!(projected.transaction_type, ConfidentialTxType::Deposit);
        assert_eq!(
            projected.destination_balance_before,
            Some(BigDecimal::zero())
        );
        assert_eq!(
            projected.destination_balance_after,
            Some(BigDecimal::from_str("0.001").unwrap())
        );
        assert_eq!(
            projected.usd_change,
            BigDecimal::from_str("0.0010").unwrap()
        );
        assert_eq!(
            ledger.get("nep141:usdt.near"),
            Some(&BigDecimal::from_str("0.001").unwrap())
        );
    }

    #[test]
    fn test_project_exchange_chains_destination_to_later_sent() {
        let exchange_payload = payload(&[
            ("amountInFormatted", Value::String("5".to_string())),
            ("amountOutFormatted", Value::String("3".to_string())),
        ]);
        let exchange = row(
            "dao.near",
            Some("dao.near"),
            Some("nep141:usdt.near"),
            "nep141:wrap.near",
            exchange_payload,
        );
        let sent_payload = payload(&[
            ("amountInFormatted", Value::String("1".to_string())),
            ("amountOutFormatted", Value::String("1".to_string())),
        ]);
        let sent = row(
            "dao.near",
            Some("external.near"),
            Some("nep141:wrap.near"),
            "nep141:wrap.near",
            sent_payload,
        );
        let mut ledger = HashMap::from([("nep141:usdt.near".to_string(), BigDecimal::from(10))]);

        let exchange = project_row(&exchange, &mut ledger)
            .expect("exchange should project")
            .expect("exchange should not skip");
        let sent = project_row(&sent, &mut ledger)
            .expect("sent should project")
            .expect("sent should not skip");

        assert_eq!(
            exchange.destination_balance_after,
            sent.origin_balance_before
        );
    }

    #[test]
    fn test_origin_null_external_recipient_skips() {
        let raw_payload = payload(&[
            ("amountOutFormatted", Value::String("1".to_string())),
            ("recipient", Value::String("external.near".to_string())),
        ]);
        let row = row(
            "dao.near",
            Some("external.near"),
            None,
            "nep141:wrap.near",
            raw_payload,
        );
        let mut ledger = HashMap::new();

        let projected = project_row(&row, &mut ledger).expect("skip should not error");

        assert!(projected.is_none());
        assert!(ledger.is_empty());
    }
}
