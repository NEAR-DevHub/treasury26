use std::collections::HashMap;
use std::str::FromStr;

use bigdecimal::{BigDecimal, Zero};
use serde_json::Value;

use super::models::{BronzeProjectionRow, ConfidentialDepositCorrectionIndex, GoldHistoryEvent};
use crate::handlers::intents::confidential::types::{
    ConfidentialTxType, DepositType, HistoryApiItem, accounts_equal, bare_account,
};

enum Classification {
    Project(ConfidentialTxType),
    Skip,
}

/// True when a row classifies as a deposit (recipient is this DAO, with no
/// origin asset or the same origin/destination asset) — every deposit shape the
/// 1Click history API misreports as the ~0.001 quote nominal, and therefore the
/// shapes we correct.
pub(crate) fn classify_is_deposit(
    dao_id: &str,
    recipient: &str,
    origin_asset: Option<&str>,
    destination_asset: &str,
) -> bool {
    matches!(
        classify(dao_id, recipient, origin_asset, destination_asset),
        Classification::Project(ConfidentialTxType::Deposit)
    )
}

/// Rescale the quote's implied per-unit USD price to the corrected quantity:
/// `usd_nominal * (corrected_qty / qty_nominal)`. Returns `None` when the
/// nominal USD is absent or the nominal quantity is zero (no derivable price) —
/// callers store NULL rather than a wrong value.
fn scale_usd_to_corrected(
    usd_nominal: Option<&BigDecimal>,
    qty_nominal: &BigDecimal,
    corrected_qty: &BigDecimal,
) -> Option<BigDecimal> {
    let usd_nominal = usd_nominal?;
    if qty_nominal.is_zero() {
        return None;
    }
    Some((usd_nominal * corrected_qty) / qty_nominal)
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
    corrections: &ConfidentialDepositCorrectionIndex,
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
    let mut amount_out = parse_decimal(
        api.as_ref()
            .and_then(|i| i.amount_out_formatted.clone())
            .or_else(|| payload_str(&row.raw_payload, "amountOutFormatted")),
        "amountOutFormatted",
    )?;
    let mut amount_out_usd = parse_optional_decimal(
        api.as_ref()
            .and_then(|i| i.amount_out_usd.clone())
            .or_else(|| payload_str(&row.raw_payload, "amountOutUsd")),
        "amountOutUsd",
    )?;
    let mut amount_in_usd = parse_optional_decimal(
        api.as_ref()
            .and_then(|i| i.amount_in_usd.clone())
            .or_else(|| payload_str(&row.raw_payload, "amountInUsd")),
        "amountInUsd",
    )?;

    let mut amount_in = match kind {
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
    // Recorded real deposited quantity for this row, if any. Only consumed by
    // the pure-external-deposit arm below (origin-less deposits, the case the
    // 1Click history API misreports). Read-only — does not mutate the ledger.
    let deposit_correction = if kind == ConfidentialTxType::Deposit && corrections.is_enabled() {
        corrections.correction_for(row.id)
    } else {
        None
    };

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
            // The 1Click history API reports the ~0.001 quote nominal for
            // deposits (both same-asset `out - in` and origin-less shapes), so
            // prefer a recorded correction (real deposited quantity) and rescale
            // the quote-implied USD price to it. Falls back to the raw amount
            // (or `out - in`) when uncorrected.
            let net_amount = if let Some(correction) = deposit_correction {
                amount_out_usd = scale_usd_to_corrected(
                    amount_out_usd.as_ref(),
                    &amount_out,
                    &correction.corrected_net_amount,
                );
                correction.corrected_net_amount.clone()
            } else {
                match amount_in.as_ref() {
                    Some(amount_in)
                        if origin_asset.as_deref() == Some(destination_asset.as_str()) =>
                    {
                        if intents_to_confidential_deposit {
                            amount_out.clone()
                        } else {
                            &amount_out - amount_in
                        }
                    }
                    _ => amount_out.clone(),
                }
            };
            // A zero-net deposit has no balance impact, so it is not a history
            // event — skip it (e.g. a merge-extra sibling credited 0, or an
            // uncorrected same-asset nominal where `out == in`). Returning here
            // before touching the ledger keeps the no-mutation-before-skip
            // invariant; re-projection re-emits the row if a correction later
            // makes the net non-zero.
            if net_amount.is_zero() {
                return Ok(None);
            }
            let mut destination_after = &destination_before + &net_amount;
            if destination_after < zero {
                destination_after = BigDecimal::zero();
            }
            ledger.insert(destination_asset.clone(), destination_after.clone());
            // Keep the gold row self-consistent: a deposit credits exactly
            // `destination_after - destination_before` of the destination asset,
            // so store that delta as amount_out and drop amount_in (a deposit has
            // no outgoing leg). This holds the invariant
            // `amount_out == destination_balance_after - destination_balance_before`
            // the read side already displays. The raw, 1Click-misreported amounts
            // remain in bronze for provenance.
            amount_out = &destination_after - &destination_before;
            // A deposit has no incoming leg: drop amount_in / amount_in_usd and
            // record the inflow's USD value (the corrected, or nominal,
            // amount_out_usd) as usd_change.
            amount_in = None;
            amount_in_usd = None;
            let usd_change = amount_out_usd.clone().unwrap_or_else(BigDecimal::zero);
            (
                None,
                None,
                Some(destination_before),
                Some(destination_after),
                usd_change,
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

    // Extract quoteTransactions[0] from the parsed API item or raw_payload directly
    // (fallback for rows ingested before the typed field was added).
    let first_quote_tx = row
        .raw_payload
        .get("quoteTransactions")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first());
    let deposit_sender = api
        .as_ref()
        .and_then(|i| i.first_quote_sender())
        .map(str::to_owned)
        .or_else(|| {
            first_quote_tx
                .and_then(|tx| tx.get("sender"))
                .and_then(|s| s.as_str())
                .map(str::to_owned)
        });
    let deposit_tx_hash = api
        .as_ref()
        .and_then(|i| i.first_quote_tx_hash())
        .map(str::to_owned)
        .or_else(|| {
            first_quote_tx
                .and_then(|tx| tx.get("txHash"))
                .and_then(|s| s.as_str())
                .map(str::to_owned)
        });

    // `counterparty` is the single frontend-facing "other side" field:
    //   Sent     → the recipient (who received funds)
    //   Deposit  → the real on-chain sender from quoteTransactions[0].sender,
    //              falling back to intents.near when unavailable
    //   Exchange → intents.near (the solver)
    let counterparty = match kind {
        ConfidentialTxType::Sent => recipient.clone(),
        ConfidentialTxType::Deposit => deposit_sender
            .clone()
            .unwrap_or_else(|| bare_account("intents.near")),
        ConfidentialTxType::Exchange => bare_account("intents.near"),
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
        proposal_execution_block_height: row.proposal_execution_block_height,
        proposal_executed_at: row.proposal_executed_at,
        proposal_execution_transaction_hash: row.proposal_execution_transaction_hash.clone(),
        quote_created_at: row.created_at_external,
        proposal_created_at: row.proposal_created_at,
        deposit_tx_hash,
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
            proposal_executed_at: None,
            proposal_execution_block_height: None,
            proposal_execution_transaction_hash: None,
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

        let projected = project_row(
            &row,
            &mut ledger,
            &ConfidentialDepositCorrectionIndex::empty_disabled(),
        )
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

        let projected = project_row(
            &row,
            &mut ledger,
            &ConfidentialDepositCorrectionIndex::empty_disabled(),
        )
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

        let disabled = ConfidentialDepositCorrectionIndex::empty_disabled();
        let exchange = project_row(&exchange, &mut ledger, &disabled)
            .expect("exchange should project")
            .expect("exchange should not skip");
        let sent = project_row(&sent, &mut ledger, &disabled)
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

        let projected = project_row(
            &row,
            &mut ledger,
            &ConfidentialDepositCorrectionIndex::empty_disabled(),
        )
        .expect("skip should not error");

        assert!(projected.is_none());
        assert!(ledger.is_empty());
    }

    fn deposit_correction_index(
        history_event_id: i64,
        net: &str,
    ) -> ConfidentialDepositCorrectionIndex {
        use super::super::models::ConfidentialDepositCorrection;

        let net = BigDecimal::from_str(net).unwrap();
        let mut entries = HashMap::new();
        entries.insert(
            history_event_id,
            ConfidentialDepositCorrection {
                history_event_id,
                // Raw scale is irrelevant to projection (it consumes net); reuse net.
                corrected_raw_amount: net.clone(),
                corrected_net_amount: net,
            },
        );
        ConfidentialDepositCorrectionIndex::new(entries)
    }

    #[test]
    fn test_deposit_correction_overrides_amount_and_usd() {
        let raw_payload = payload(&[
            ("amountOutFormatted", Value::String("0.001".to_string())),
            ("amountOutUsd", Value::String("0.0010".to_string())),
        ]);
        let row = row(
            "dao.near",
            Some("dao.near"),
            None,
            "nep141:wrap.near",
            raw_payload,
        );
        let mut ledger = HashMap::new();
        let corrections = deposit_correction_index(row.id, "5");

        let projected = project_row(&row, &mut ledger, &corrections)
            .expect("deposit should project")
            .expect("deposit should not skip");

        assert_eq!(projected.transaction_type, ConfidentialTxType::Deposit);
        assert_eq!(
            projected.destination_balance_after,
            Some(BigDecimal::from(5))
        );
        // Per-unit price = 0.0010 / 0.001 = 1.0 → corrected USD = 1.0 * 5 = 5.
        assert_eq!(
            projected
                .amount_out_usd
                .as_ref()
                .map(BigDecimal::normalized),
            Some(BigDecimal::from(5))
        );
        assert_eq!(projected.usd_change.normalized(), BigDecimal::from(5));
        // Gold stores the credited delta (= corrected net), not the raw nominal,
        // and a deposit carries no amount_in. The raw amounts remain in bronze.
        assert_eq!(projected.amount_out, BigDecimal::from(5));
        assert!(projected.amount_in.is_none());
        // A deposit has no incoming leg, so amount_in_usd is dropped too.
        assert!(projected.amount_in_usd.is_none());
        assert_eq!(ledger.get("nep141:wrap.near"), Some(&BigDecimal::from(5)));
    }

    #[test]
    fn test_deposit_correction_usd_null_when_no_nominal_usd() {
        let raw_payload = payload(&[("amountOutFormatted", Value::String("0.001".to_string()))]);
        let row = row(
            "dao.near",
            Some("dao.near"),
            None,
            "nep141:wrap.near",
            raw_payload,
        );
        let mut ledger = HashMap::new();
        let corrections = deposit_correction_index(row.id, "5");

        let projected = project_row(&row, &mut ledger, &corrections)
            .expect("deposit should project")
            .expect("deposit should not skip");

        assert_eq!(
            projected.destination_balance_after,
            Some(BigDecimal::from(5))
        );
        assert!(projected.amount_out_usd.is_none());
        assert_eq!(projected.usd_change, BigDecimal::zero());
    }

    #[test]
    fn test_merge_extra_zero_correction_is_skipped() {
        // The merge-extra sibling carries a 0 correction → no balance impact →
        // skipped (no gold row), ledger untouched.
        let raw_payload = payload(&[
            ("amountOutFormatted", Value::String("0.001".to_string())),
            ("amountOutUsd", Value::String("0.0010".to_string())),
        ]);
        let mut row = row(
            "dao.near",
            Some("dao.near"),
            None,
            "nep141:wrap.near",
            raw_payload,
        );
        row.id = 2;
        let mut ledger = HashMap::from([("nep141:wrap.near".to_string(), BigDecimal::from(8))]);
        let corrections = deposit_correction_index(2, "0");

        let projected = project_row(&row, &mut ledger, &corrections).expect("should not error");

        assert!(projected.is_none(), "zero-net deposit should be skipped");
        assert_eq!(ledger.get("nep141:wrap.near"), Some(&BigDecimal::from(8)));
    }

    #[test]
    fn test_uncorrected_same_asset_zero_net_deposit_is_skipped() {
        // origin == destination, amountIn == amountOut, no correction → net is
        // `out - in = 0` → skipped, ledger untouched.
        let raw_payload = payload(&[
            ("amountInFormatted", Value::String("0.0001".to_string())),
            ("amountOutFormatted", Value::String("0.0001".to_string())),
        ]);
        let row = row(
            "dao.near",
            Some("dao.near"),
            Some("nep141:wrap.near"),
            "nep141:wrap.near",
            raw_payload,
        );
        let mut ledger = HashMap::new();
        let disabled = ConfidentialDepositCorrectionIndex::empty_disabled();

        let projected = project_row(&row, &mut ledger, &disabled).expect("should not error");

        assert!(
            projected.is_none(),
            "uncorrected zero-net same-asset deposit should be skipped"
        );
        assert!(ledger.get("nep141:wrap.near").is_none());
    }

    #[test]
    fn test_same_asset_deposit_correction_overrides_net() {
        // origin == destination (same-asset deposit): uncorrected net would be
        // out - in (= 0 for nominal 0.0001/0.0001); a correction overrides it.
        let raw_payload = payload(&[
            ("amountInFormatted", Value::String("0.0001".to_string())),
            ("amountOutFormatted", Value::String("0.0001".to_string())),
            ("amountOutUsd", Value::String("0.0001".to_string())),
        ]);
        let row = row(
            "dao.near",
            Some("dao.near"),
            Some("nep141:wrap.near"),
            "nep141:wrap.near",
            raw_payload,
        );
        let mut ledger = HashMap::new();
        let corrections = deposit_correction_index(row.id, "2");

        let projected = project_row(&row, &mut ledger, &corrections)
            .expect("deposit should project")
            .expect("deposit should not skip");

        assert_eq!(projected.transaction_type, ConfidentialTxType::Deposit);
        assert_eq!(
            projected.destination_balance_after,
            Some(BigDecimal::from(2))
        );
        assert_eq!(ledger.get("nep141:wrap.near"), Some(&BigDecimal::from(2)));
    }
}
