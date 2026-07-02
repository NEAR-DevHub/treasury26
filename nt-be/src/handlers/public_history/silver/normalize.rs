use bigdecimal::BigDecimal;
use bigdecimal::num_traits::{Signed, Zero};

use super::models::{
    BronzePublicHistoryRow, NormalizedTransferLeg, ProposalLink, PublicAmount, PublicAsset,
    PublicTransferConfidence, PublicTransferDirection, PublicTransferLegKind,
};
use crate::handlers::public_history::bronze::store::PublicHistorySource;

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
    let decimals = row.decimals.unwrap_or(24);
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
        event_index: row.event_index,
        block_height: row.block_height,
        block_timestamp: row.block_timestamp.clone(),
        block_time: row.block_time,
        asset: PublicAsset::nep141(contract),
        direction: direction_from_delta(&delta, kind),
        counterparty: row.involved_account_id.clone(),
        amount,
        leg_kind: kind,
        linked_mint_bronze_id: None,
        linked_transfer_bronze_id: None,
        confidence: PublicTransferConfidence::SourceEvent,
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
    let decimals = row.decimals.unwrap_or(24);
    let kind = leg_kind_from_cause(row.cause.as_deref());
    let amount = PublicAmount::from_raw(delta.abs(), decimals);

    Ok(Some(NormalizedTransferLeg {
        account_id: row.account_id.clone(),
        leg_key: source_event_leg_key(row),
        source_event_id: row.id,
        source: PublicHistorySource::NearblocksMt,
        proposal_link: proposal_link(row),
        transaction_hash: row.transaction_hash.clone(),
        receipt_id: row.receipt_id.clone(),
        event_index: row.event_index,
        block_height: row.block_height,
        block_timestamp: row.block_timestamp.clone(),
        block_time: row.block_time,
        asset: PublicAsset::intents(token_id),
        direction: direction_from_delta(&delta, kind),
        counterparty: row.involved_account_id.clone(),
        amount,
        leg_kind: kind,
        linked_mint_bronze_id: None,
        linked_transfer_bronze_id: None,
        confidence: PublicTransferConfidence::SourceEvent,
        raw_payload: row.raw_payload.clone(),
    }))
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
        event_index: row.event_index,
        block_height: row.block_height,
        block_timestamp: row.block_timestamp.clone(),
        block_time: row.block_time,
        asset: PublicAsset::native_near(),
        direction,
        counterparty: row.involved_account_id.clone(),
        amount: PublicAmount::from_raw(deposit, 24),
        leg_kind: PublicTransferLegKind::Transfer,
        linked_mint_bronze_id: None,
        linked_transfer_bronze_id: None,
        confidence: PublicTransferConfidence::ReceiptAction,
        raw_payload: row.raw_payload.clone(),
    }))
}

pub fn normalize_bronze_row(
    row: &BronzePublicHistoryRow,
) -> Result<Option<NormalizedTransferLeg>, String> {
    let source = PublicHistorySource::from_db(&row.source).map_err(|e| e.to_string())?;
    match source {
        PublicHistorySource::NearblocksFt => normalize_ft(row),
        PublicHistorySource::NearblocksMt => normalize_mt(row),
        PublicHistorySource::NearblocksReceipt => normalize_receipt(row),
    }
}

#[cfg(test)]
mod tests {
    use super::super::models::PublicTokenStandard;
    use super::*;

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
}
