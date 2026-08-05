use std::collections::HashMap;

use bigdecimal::BigDecimal;

use super::classify::project_row;
use super::models::{
    BronzeRow, ConfidentialDepositCorrectionIndex, GoldHistoryEvent, UnifiedGoldBind,
};
use crate::handlers::intents::confidential::types::ConfidentialTxType;

/// Project a bronze suffix row into a gold history event using ledger replay.
pub(crate) fn bronze_to_gold(
    row: &BronzeRow,
    ledger: &mut HashMap<String, BigDecimal>,
    corrections: &ConfidentialDepositCorrectionIndex,
) -> Result<Option<GoldHistoryEvent>, String> {
    project_row(row, ledger, corrections)
}

/// Unified-ledger row identity for a confidential history event. Carries
/// provenance in place of a FK column: joins use
/// `gold_event_key = 'confidential:' || history_event_id`.
pub(crate) fn confidential_gold_event_key(history_event_id: i64) -> String {
    format!("confidential:{history_event_id}")
}

/// Map a replayed confidential gold event onto the unified-ledger leg shape.
///
/// Confidential naming is inverted relative to the unified table: 1Click
/// `origin`/`amount_in` is the debit side (unified `token_out`/`amount_out`)
/// and `destination`/`amount_out` is the credit side (unified `token_in`/
/// `amount_in`). The debit amount is the applied delta (before - after) so the
/// read-side `balance_before = after + amount_out` derivation holds on rows
/// where the replay clamped a would-be-negative balance at zero.
pub(crate) fn unified_bind_from_event(event: &GoldHistoryEvent) -> UnifiedGoldBind {
    let applied_debit = match (&event.origin_balance_before, &event.origin_balance_after) {
        (Some(before), Some(after)) => Some(before - after),
        _ => event.amount_in.clone(),
    };
    let applied_credit = match (
        &event.destination_balance_before,
        &event.destination_balance_after,
    ) {
        (Some(before), Some(after)) => Some(after - before),
        _ => Some(event.amount_out.clone()),
    };

    let (
        token_in,
        amount_in,
        amount_in_usd,
        token_in_user_balance_after,
        token_out,
        amount_out,
        amount_out_usd,
        token_out_user_balance_after,
    ) = match event.transaction_type {
        ConfidentialTxType::Sent => (
            None,
            None,
            None,
            None,
            event.origin_asset.clone(),
            applied_debit,
            event.amount_in_usd.clone(),
            event.origin_balance_after.clone(),
        ),
        ConfidentialTxType::Deposit => (
            Some(event.destination_asset.clone()),
            applied_credit,
            event.amount_out_usd.clone(),
            event.destination_balance_after.clone(),
            None,
            None,
            None,
            None,
        ),
        ConfidentialTxType::Exchange => (
            Some(event.destination_asset.clone()),
            applied_credit,
            event.amount_out_usd.clone(),
            event.destination_balance_after.clone(),
            event.origin_asset.clone(),
            applied_debit,
            event.amount_in_usd.clone(),
            event.origin_balance_after.clone(),
        ),
    };

    UnifiedGoldBind {
        gold_event_key: confidential_gold_event_key(event.history_event_id),
        event_time: event.quote_created_at,
        source_order: event.history_event_id,
        token_in,
        amount_in,
        amount_in_usd,
        token_in_user_balance_after,
        token_out,
        amount_out,
        amount_out_usd,
        token_out_user_balance_after,
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use chrono::Utc;

    use super::*;

    fn event(transaction_type: ConfidentialTxType) -> GoldHistoryEvent {
        GoldHistoryEvent {
            history_event_id: 42,
            intent_id: None,
            dao_id: "dao.near".parse().unwrap(),
            transaction_type,
            origin_asset: Some("nep141:usdt.near".to_string()),
            destination_asset: "nep141:wrap.near".to_string(),
            amount_in: Some(BigDecimal::from_str("2.5").unwrap()),
            amount_out: BigDecimal::from_str("2.4").unwrap(),
            amount_in_usd: Some(BigDecimal::from_str("2.5").unwrap()),
            amount_out_usd: Some(BigDecimal::from_str("2.4").unwrap()),
            usd_change: BigDecimal::from_str("-0.1").unwrap(),
            origin_balance_before: Some(BigDecimal::from(10)),
            origin_balance_after: Some(BigDecimal::from_str("7.5").unwrap()),
            destination_balance_before: Some(BigDecimal::from(1)),
            destination_balance_after: Some(BigDecimal::from_str("3.4").unwrap()),
            recipient: "external.near".to_string(),
            refund_to: "dao.near".to_string(),
            counterparty: "intents.near".to_string(),
            deposit_address: "deposit-address".to_string(),
            deposit_memo: None,
            proposal_execution_block_height: None,
            proposal_executed_at: None,
            proposal_execution_transaction_hash: None,
            quote_created_at: Utc::now(),
            proposal_created_at: None,
            proposal_id: None,
            deposit_tx_hash: None,
        }
    }

    #[test]
    fn key_and_replay_position_come_from_the_bronze_event() {
        let event = event(ConfidentialTxType::Sent);
        let bind = unified_bind_from_event(&event);
        assert_eq!(bind.gold_event_key, "confidential:42");
        assert_eq!(bind.source_order, 42);
        assert_eq!(bind.event_time, event.quote_created_at);
    }

    #[test]
    fn sent_maps_origin_to_out_leg_only() {
        let bind = unified_bind_from_event(&event(ConfidentialTxType::Sent));
        assert!(bind.token_in.is_none());
        assert!(bind.amount_in.is_none());
        assert_eq!(bind.token_out.as_deref(), Some("nep141:usdt.near"));
        assert_eq!(bind.amount_out, Some(BigDecimal::from_str("2.5").unwrap()));
        assert_eq!(
            bind.amount_out_usd,
            Some(BigDecimal::from_str("2.5").unwrap())
        );
        assert_eq!(
            bind.token_out_user_balance_after,
            Some(BigDecimal::from_str("7.5").unwrap())
        );
    }

    #[test]
    fn sent_out_amount_is_the_applied_delta_when_clamped() {
        let mut clamped = event(ConfidentialTxType::Sent);
        clamped.origin_balance_before = Some(BigDecimal::from(1));
        clamped.origin_balance_after = Some(BigDecimal::from(0));
        let bind = unified_bind_from_event(&clamped);
        assert_eq!(bind.amount_out, Some(BigDecimal::from(1)));
    }

    #[test]
    fn deposit_maps_destination_to_in_leg_only() {
        let mut deposit = event(ConfidentialTxType::Deposit);
        deposit.origin_asset = None;
        deposit.amount_in = None;
        deposit.amount_in_usd = None;
        deposit.origin_balance_before = None;
        deposit.origin_balance_after = None;
        let bind = unified_bind_from_event(&deposit);
        assert!(bind.token_out.is_none());
        assert_eq!(bind.token_in.as_deref(), Some("nep141:wrap.near"));
        assert_eq!(bind.amount_in, Some(BigDecimal::from_str("2.4").unwrap()));
        assert_eq!(
            bind.amount_in_usd,
            Some(BigDecimal::from_str("2.4").unwrap())
        );
        assert_eq!(
            bind.token_in_user_balance_after,
            Some(BigDecimal::from_str("3.4").unwrap())
        );
    }

    #[test]
    fn exchange_carries_both_legs_with_inverted_naming() {
        let bind = unified_bind_from_event(&event(ConfidentialTxType::Exchange));
        assert_eq!(bind.token_in.as_deref(), Some("nep141:wrap.near"));
        assert_eq!(bind.amount_in, Some(BigDecimal::from_str("2.4").unwrap()));
        assert_eq!(
            bind.amount_in_usd,
            Some(BigDecimal::from_str("2.4").unwrap())
        );
        assert_eq!(bind.token_out.as_deref(), Some("nep141:usdt.near"));
        assert_eq!(bind.amount_out, Some(BigDecimal::from_str("2.5").unwrap()));
        assert_eq!(
            bind.amount_out_usd,
            Some(BigDecimal::from_str("2.5").unwrap())
        );
        assert_eq!(
            bind.token_in_user_balance_after,
            Some(BigDecimal::from_str("3.4").unwrap())
        );
        assert_eq!(
            bind.token_out_user_balance_after,
            Some(BigDecimal::from_str("7.5").unwrap())
        );
    }
}
