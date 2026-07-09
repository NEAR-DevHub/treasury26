use bigdecimal::BigDecimal;
use bigdecimal::num_traits::{Signed, Zero};

use super::models::{
    BronzePublicHistoryRow, NormalizedTransferLeg, ProposalLink, PublicAmount, PublicAsset,
    PublicTransferDirection, PublicTransferLegKind,
};
use crate::handlers::public_history::bronze::store::PublicHistorySource;
use crate::services::token_prices::canonicalize_token_id;

fn proposal_link(row: &BronzePublicHistoryRow) -> Option<ProposalLink> {
    Some(ProposalLink {
        proposal_ref: row.proposal_ref?,
        proposal_id: row.proposal_id?,
    })
}

fn normalize_cause(cause: Option<&str>) -> Option<&str> {
    cause.map(str::trim).filter(|cause| !cause.is_empty())
}

fn leg_kind_from_cause(cause: Option<&str>) -> PublicTransferLegKind {
    match normalize_cause(cause)
        .map(str::to_ascii_uppercase)
        .as_deref()
    {
        Some("MINT") => PublicTransferLegKind::Mint,
        Some("BURN") => PublicTransferLegKind::Burn,
        _ => PublicTransferLegKind::Transfer,
    }
}

fn direction_from_delta(
    delta: &BigDecimal,
    kind: PublicTransferLegKind,
) -> PublicTransferDirection {
    if matches!(
        kind,
        PublicTransferLegKind::Mint | PublicTransferLegKind::Burn
    ) {
        return PublicTransferDirection::Internal;
    }
    if delta.is_positive() {
        PublicTransferDirection::Incoming
    } else if delta.is_negative() {
        PublicTransferDirection::Outgoing
    } else {
        PublicTransferDirection::Internal
    }
}

fn source_event_leg_key(row: &BronzePublicHistoryRow) -> String {
    format!("{}:{}", row.source, row.source_event_key)
}

fn normalize_ft(row: &BronzePublicHistoryRow) -> Result<Option<NormalizedTransferLeg>, String> {
    let delta = row
        .delta_amount_raw
        .clone()
        .ok_or_else(|| "FT event missing delta_amount_raw".to_string())?;
    if delta.is_zero() {
        return Ok(None);
    }
    let contract = row
        .contract_account_id
        .clone()
        .ok_or_else(|| "FT event missing contract_account_id".to_string())?;
    let decimals = row
        .decimals
        .ok_or_else(|| "FT event missing decimals".to_string())?;
    let kind = leg_kind_from_cause(row.cause.as_deref());
    let amount = PublicAmount::from_raw(delta.abs(), decimals);

    Ok(Some(NormalizedTransferLeg {
        account_id: row.account_id.clone(),
        leg_key: source_event_leg_key(row),
        source_event_id: row.id,
        source: PublicHistorySource::NearblocksFt,
        proposal_link: proposal_link(row),
        transaction_hash: row.transaction_hash.clone(),
        receipt_id: row.receipt_id.clone(),
        block_height: row.block_height,
        block_time: row.block_time,
        asset: PublicAsset::nep141(contract),
        direction: direction_from_delta(&delta, kind),
        counterparty: row.involved_account_id.clone(),
        amount,
        leg_kind: kind,
        raw_payload: row.raw_payload.clone(),
    }))
}

fn normalize_mt(row: &BronzePublicHistoryRow) -> Result<Option<NormalizedTransferLeg>, String> {
    let delta = row
        .delta_amount_raw
        .clone()
        .ok_or_else(|| "MT event missing delta_amount_raw".to_string())?;
    if delta.is_zero() {
        return Ok(None);
    }
    let token_id = row
        .token_id
        .clone()
        .ok_or_else(|| "MT event missing token_id".to_string())?;
    let decimals = row
        .decimals
        .ok_or_else(|| "MT event missing decimals".to_string())?;
    let kind = leg_kind_from_cause(row.cause.as_deref());
    let direction = if delta.is_positive() {
        PublicTransferDirection::Incoming
    } else if delta.is_negative() {
        PublicTransferDirection::Outgoing
    } else {
        PublicTransferDirection::Internal
    };
    let amount = PublicAmount::from_raw(delta.abs(), decimals);
    let asset = if row.contract_account_id.as_deref() == Some("v2_1.omni.hot.tg") {
        PublicAsset::nep245(canonical_hot_omni_token_id(&token_id))
    } else {
        PublicAsset::intents(token_id)
    };

    Ok(Some(NormalizedTransferLeg {
        account_id: row.account_id.clone(),
        leg_key: source_event_leg_key(row),
        source_event_id: row.id,
        source: PublicHistorySource::NearblocksMt,
        proposal_link: proposal_link(row),
        transaction_hash: row.transaction_hash.clone(),
        receipt_id: row.receipt_id.clone(),
        block_height: row.block_height,
        block_time: row.block_time,
        asset,
        direction,
        counterparty: row.involved_account_id.clone(),
        amount,
        leg_kind: kind,
        raw_payload: row.raw_payload.clone(),
    }))
}

fn canonical_hot_omni_token_id(token_id: &str) -> String {
    if token_id.starts_with("nep245:")
        || token_id.starts_with("nep141:")
        || token_id.starts_with("intents.near:")
        || token_id.starts_with("v2_1.omni.hot.tg:")
    {
        return canonicalize_token_id(token_id);
    }
    canonicalize_token_id(&format!("v2_1.omni.hot.tg:{token_id}"))
}

fn normalize_receipt(
    row: &BronzePublicHistoryRow,
) -> Result<Option<NormalizedTransferLeg>, String> {
    let action = row.action_kind.as_deref().unwrap_or_default();
    if !action.eq_ignore_ascii_case("TRANSFER") {
        return Ok(None);
    }
    let deposit = row
        .deposit_raw
        .clone()
        .ok_or_else(|| "native transfer receipt missing deposit_raw".to_string())?;
    if deposit.is_zero() {
        return Ok(None);
    }
    // Receipt rows only tell us predecessor/receiver, so direction is inferred
    // by whether the monitored account is the receiver or predecessor.
    let direction = if row.affected_account_id == row.account_id {
        PublicTransferDirection::Incoming
    } else if row.involved_account_id.as_deref() == Some(row.account_id.as_str()) {
        PublicTransferDirection::Outgoing
    } else {
        PublicTransferDirection::Internal
    };
    if direction == PublicTransferDirection::Internal {
        return Ok(None);
    }

    Ok(Some(NormalizedTransferLeg {
        account_id: row.account_id.clone(),
        leg_key: source_event_leg_key(row),
        source_event_id: row.id,
        source: PublicHistorySource::NearblocksReceipt,
        proposal_link: proposal_link(row),
        transaction_hash: row.transaction_hash.clone(),
        receipt_id: row.receipt_id.clone(),
        block_height: row.block_height,
        block_time: row.block_time,
        asset: PublicAsset::native_near(),
        direction,
        counterparty: row.involved_account_id.clone(),
        amount: PublicAmount::from_raw(deposit, 24),
        leg_kind: PublicTransferLegKind::Transfer,
        raw_payload: row.raw_payload.clone(),
    }))
}

pub fn normalize_bronze_row(
    row: &BronzePublicHistoryRow,
) -> Result<Option<NormalizedTransferLeg>, String> {
    // Failed receipts can appear in NearBlocks; silver only models effective
    // balance movements.
    if row.outcome_status == Some(false) {
        return Ok(None);
    }

    let source = PublicHistorySource::from_db(&row.source).map_err(|e| e.to_string())?;
    match source {
        PublicHistorySource::NearblocksFt => normalize_ft(row),
        PublicHistorySource::NearblocksMt => normalize_mt(row),
        PublicHistorySource::NearblocksReceipt => normalize_receipt(row),
    }
}

#[cfg(test)]
mod tests {
    use bigdecimal::BigDecimal;
    use chrono::{TimeZone, Utc};
    use std::str::FromStr;

    use super::super::models::PublicTokenStandard;
    use super::*;

    fn base_row(source: PublicHistorySource) -> BronzePublicHistoryRow {
        BronzePublicHistoryRow {
            id: 1,
            account_id: "dao.near".to_string(),
            source: source.as_str().to_string(),
            source_event_key: "event-1".to_string(),
            transaction_hash: Some("tx".to_string()),
            receipt_id: Some("receipt".to_string()),
            event_index: Some(0),
            block_height: 1,
            block_timestamp: BigDecimal::from(0),
            block_time: Utc.timestamp_opt(0, 0).unwrap(),
            affected_account_id: "dao.near".to_string(),
            involved_account_id: Some("alice.near".to_string()),
            contract_account_id: Some("token.near".to_string()),
            token_id: Some("nep141:token.near".to_string()),
            cause: None,
            action_kind: None,
            method_name: None,
            delta_amount_raw: Some(BigDecimal::from(100)),
            decimals: Some(6),
            deposit_raw: None,
            outcome_status: None,
            raw_payload: serde_json::json!({}),
            proposal_ref: None,
            proposal_id: None,
        }
    }

    #[test]
    fn public_asset_formats_are_canonical() {
        assert_eq!(PublicAsset::native_near().token_id(), "near");
        assert_eq!(PublicAsset::nep141("wrap.near").token_id(), "wrap.near");
        assert_eq!(
            PublicAsset::intents("nep141:eth.omft.near").token_id(),
            "intents.near:nep141:eth.omft.near"
        );
        assert_eq!(
            PublicAsset::intents("x").token_standard(),
            PublicTokenStandard::Nep245
        );
    }

    #[test]
    fn mt_mint_is_incoming_deposit_not_internal() {
        let row = BronzePublicHistoryRow {
            id: 1,
            account_id: "tobi.sputnik-dao.near".to_string(),
            source: PublicHistorySource::NearblocksMt.as_str().to_string(),
            source_event_key: "mt-mint".to_string(),
            transaction_hash: Some("tx".to_string()),
            receipt_id: Some("receipt".to_string()),
            event_index: Some(0),
            block_height: 205251934,
            block_timestamp: BigDecimal::from(0),
            block_time: Utc.timestamp_opt(0, 0).unwrap(),
            affected_account_id: "tobi.sputnik-dao.near".to_string(),
            involved_account_id: None,
            contract_account_id: Some("intents.near".to_string()),
            token_id: Some(
                "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near".to_string(),
            ),
            cause: Some("MINT".to_string()),
            action_kind: None,
            method_name: None,
            delta_amount_raw: Some(BigDecimal::from(100000)),
            decimals: Some(6),
            deposit_raw: None,
            outcome_status: None,
            raw_payload: serde_json::json!({}),
            proposal_ref: None,
            proposal_id: None,
        };

        let leg = normalize_bronze_row(&row)
            .expect("normalization should succeed")
            .expect("mint should create a leg");

        assert_eq!(leg.direction, PublicTransferDirection::Incoming);
        assert_eq!(leg.leg_kind, PublicTransferLegKind::Mint);
        assert_eq!(
            leg.asset.token_id(),
            "intents.near:nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"
        );
        assert_eq!(leg.amount.amount, BigDecimal::from_str("0.1").unwrap());
    }

    #[test]
    fn hot_omni_mt_asset_is_canonical_nep245() {
        let mut row = base_row(PublicHistorySource::NearblocksMt);
        row.contract_account_id = Some("v2_1.omni.hot.tg".to_string());
        row.token_id = Some("56_2CMMyVTGZkeyNZTSvS5sarzfir6g".to_string());

        let leg = normalize_bronze_row(&row)
            .expect("normalization should succeed")
            .expect("mt row should create a leg");

        assert_eq!(leg.asset.token_standard(), PublicTokenStandard::Nep245);
        assert_eq!(
            leg.asset.token_id(),
            "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g"
        );
    }

    #[test]
    fn hot_omni_native_asset_suffix_is_canonical_nep245() {
        let mut row = base_row(PublicHistorySource::NearblocksMt);
        row.contract_account_id = Some("v2_1.omni.hot.tg".to_string());
        row.token_id = Some("1117_".to_string());

        let leg = normalize_bronze_row(&row)
            .expect("normalization should succeed")
            .expect("mt row should create a leg");

        assert_eq!(leg.asset.token_id(), "nep245:v2_1.omni.hot.tg:1117_");
    }

    #[test]
    fn failed_receipt_is_skipped() {
        let mut row = base_row(PublicHistorySource::NearblocksReceipt);
        row.action_kind = Some("TRANSFER".to_string());
        row.deposit_raw = Some(BigDecimal::from(1000));
        row.decimals = Some(24);
        row.outcome_status = Some(false);

        let leg = normalize_bronze_row(&row).expect("failed row should not error");

        assert!(leg.is_none());
    }

    #[test]
    fn failed_ft_row_is_skipped_before_validation() {
        let mut row = base_row(PublicHistorySource::NearblocksFt);
        row.decimals = None;
        row.outcome_status = Some(false);

        let leg = normalize_bronze_row(&row).expect("failed row should not error");

        assert!(leg.is_none());
    }

    #[test]
    fn ft_missing_decimals_is_projection_error() {
        let mut row = base_row(PublicHistorySource::NearblocksFt);
        row.decimals = None;

        let err = normalize_bronze_row(&row).expect_err("missing decimals should error");

        assert_eq!(err, "FT event missing decimals");
    }

    #[test]
    fn mt_missing_decimals_is_projection_error() {
        let mut row = base_row(PublicHistorySource::NearblocksMt);
        row.decimals = None;

        let err = normalize_bronze_row(&row).expect_err("missing decimals should error");

        assert_eq!(err, "MT event missing decimals");
    }
}
