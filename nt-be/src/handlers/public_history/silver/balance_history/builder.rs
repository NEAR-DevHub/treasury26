use std::collections::HashMap;

use bigdecimal::{
    BigDecimal,
    num_traits::{Signed, Zero},
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::str::FromStr;

use super::models::{BalanceLedgerEntry, BalanceSeedRow, LedgerBuildResult, LedgerProjectionError};
use super::ownership::{native_movement_affects_user_balance, one_yocto_attachment_yoctos};
use crate::handlers::public_history::bronze::store::PublicHistorySource;
use crate::handlers::public_history::silver::models::{
    BronzePublicHistoryRow, PublicAmount, PublicAsset,
};
use crate::handlers::public_history::silver::normalize::canonical_nep245_token_id;

/// A balance movement extracted from bronze, before running totals are
/// assigned. FT/MT rows map one-to-one; native receipt rows are collapsed to
/// one movement per receipt.
#[derive(Debug)]
struct LedgerMovement {
    asset: PublicAsset,
    entry_key: String,
    source: PublicHistorySource,
    source_event_id: i64,
    receipt_id: Option<String>,
    transaction_hash: Option<String>,
    counterparty: Option<String>,
    block_height: i64,
    block_time: DateTime<Utc>,
    delta_raw: BigDecimal,
    decimals: i32,
    affects_user_balance: bool,
}

/// All bronze action rows of one native receipt. NearBlocks emits one row per
/// action, and `actions_agg.deposit` is a receipt-level aggregate duplicated
/// across those rows — the deposit must be read once per receipt, never
/// summed across action rows.
#[derive(Debug)]
struct ReceiptDepositGroup<'r> {
    rows: Vec<&'r BronzePublicHistoryRow>,
}

impl<'r> ReceiptDepositGroup<'r> {
    fn new(mut rows: Vec<&'r BronzePublicHistoryRow>) -> Self {
        rows.sort_by_key(|row| (row.event_index, row.id));
        Self { rows }
    }

    fn first(&self) -> &BronzePublicHistoryRow {
        self.rows[0]
    }

    fn is_failed(&self) -> bool {
        self.rows
            .iter()
            .any(|row| row.outcome_status == Some(false))
    }

    /// The receipt's native deposit magnitude in yoctoNEAR: the first action
    /// row's own deposit when present, else the receipt-level aggregate taken
    /// exactly once. This is the computation validated against archival RPC.
    fn deposit_magnitude_raw(&self) -> Result<BigDecimal, String> {
        let first = self.first();
        if let Some(deposit) = &first.deposit_raw {
            return Ok(deposit.clone());
        }
        aggregate_deposit(&first.raw_payload)
            .ok_or_else(|| "native receipt missing per-action and aggregate deposit".to_string())
    }

    /// Signed yoctoNEAR delta for the monitored account; `None` means the
    /// receipt does not move the account's own balance (self-receipt or a
    /// receipt where the account is neither receiver nor predecessor).
    ///
    /// A failed receipt still debited its attached deposit from the
    /// predecessor at receipt creation; the protocol returns it later via a
    /// separate `system` refund receipt that is booked as a normal inflow.
    /// Booking the debit here keeps the pair net-zero on the chain series —
    /// booking neither leg was impossible because the refund receipt itself
    /// reports a successful outcome. Nothing ever reached the receiver, and
    /// failed receipts without deposit data stay skipped instead of raising
    /// projection errors.
    fn signed_delta_raw(&self, account_id: &str) -> Result<Option<BigDecimal>, String> {
        let first = self.first();
        let receiver_is_account = first.affected_account_id == account_id;
        let predecessor_is_account = first.involved_account_id.as_deref() == Some(account_id);

        if self.is_failed() {
            if !predecessor_is_account || receiver_is_account {
                return Ok(None);
            }
            return Ok(self
                .deposit_magnitude_raw()
                .ok()
                .filter(|magnitude| !magnitude.is_zero())
                .map(|magnitude| -magnitude));
        }

        let magnitude = self.deposit_magnitude_raw()?;
        if magnitude.is_zero() {
            return Ok(None);
        }
        if receiver_is_account && !predecessor_is_account {
            Ok(Some(magnitude))
        } else if predecessor_is_account && !receiver_is_account {
            Ok(Some(-magnitude))
        } else {
            Ok(None)
        }
    }

    /// The other side of the movement: predecessor for inflows, receiver for
    /// outflows.
    fn counterparty(&self, account_id: &str) -> Option<String> {
        let first = self.first();
        if first.affected_account_id == account_id {
            first.involved_account_id.clone()
        } else {
            Some(first.affected_account_id.clone())
        }
    }
}

fn aggregate_deposit(raw_payload: &Value) -> Option<BigDecimal> {
    let deposit = raw_payload
        .get("receipt")?
        .get("actions_agg")?
        .get("deposit")?;
    match deposit {
        Value::String(text) => BigDecimal::from_str(text).ok(),
        Value::Number(number) => BigDecimal::from_str(&number.to_string()).ok(),
        _ => None,
    }
}

const NATIVE_DECIMALS: i32 = 24;

#[derive(Debug, Clone)]
struct RunningBalance {
    chain: BigDecimal,
    user: BigDecimal,
}

/// Builds the balance-complete running ledger for one account from a bronze
/// suffix. Seeds carry the trusted balances from before the recompute window.
pub struct BalanceLedgerBuilder<'a> {
    account_id: &'a str,
    relayer_account: &'a str,
    running_balances: HashMap<String, RunningBalance>,
}

impl<'a> BalanceLedgerBuilder<'a> {
    pub fn new(account_id: &'a str, relayer_account: &'a str, seeds: Vec<BalanceSeedRow>) -> Self {
        let running_balances = seeds
            .into_iter()
            .map(|seed| {
                (
                    seed.asset,
                    RunningBalance {
                        chain: seed.balance_after,
                        user: seed.user_balance_after,
                    },
                )
            })
            .collect();
        Self {
            account_id,
            relayer_account,
            running_balances,
        }
    }

    pub fn build(mut self, rows: &[BronzePublicHistoryRow]) -> LedgerBuildResult {
        let mut result = LedgerBuildResult::default();
        let mut movements = Vec::new();
        let mut receipt_rows: HashMap<&str, Vec<&BronzePublicHistoryRow>> = HashMap::new();
        let mut keyless_receipt_rows = Vec::new();

        for row in rows {
            match PublicHistorySource::from_db(&row.source) {
                Ok(PublicHistorySource::NearblocksFt) | Ok(PublicHistorySource::NearblocksMt) => {
                    match self.token_movement(row) {
                        Ok(Some(movement)) => movements.push(movement),
                        Ok(None) => {}
                        Err(reason) => result.errors.push(projection_error(row, reason)),
                    }
                }
                Ok(PublicHistorySource::NearblocksReceipt) => match row.receipt_id.as_deref() {
                    Some(receipt_id) => receipt_rows.entry(receipt_id).or_default().push(row),
                    None => keyless_receipt_rows.push(row),
                },
                Err(error) => result.errors.push(projection_error(row, error.to_string())),
            }
        }
        for row in keyless_receipt_rows {
            result.errors.push(projection_error(
                row,
                "receipt row missing receipt_id".to_string(),
            ));
        }

        for group_rows in receipt_rows.into_values() {
            let group = ReceiptDepositGroup::new(group_rows);
            match self.native_movements(&group) {
                Ok(receipt_movements) => movements.extend(receipt_movements),
                Err(reason) => result.errors.push(projection_error(group.first(), reason)),
            }
        }

        order_movements(&mut movements);
        result.entries = self.assign_running_balances(movements);
        result
    }

    fn token_movement(
        &self,
        row: &BronzePublicHistoryRow,
    ) -> Result<Option<LedgerMovement>, String> {
        if row.outcome_status == Some(false) {
            return Ok(None);
        }
        let delta_raw = row
            .delta_amount_raw
            .clone()
            .ok_or_else(|| "token event missing delta_amount_raw".to_string())?;
        if delta_raw.is_zero() {
            return Ok(None);
        }
        let contract = row
            .contract_account_id
            .as_deref()
            .ok_or_else(|| "token event missing contract_account_id".to_string())?;
        let decimals = row
            .decimals
            .ok_or_else(|| "token event missing decimals".to_string())?;

        let source = PublicHistorySource::from_db(&row.source).map_err(|e| e.to_string())?;
        let asset = match source {
            PublicHistorySource::NearblocksFt => PublicAsset::nep141(contract),
            PublicHistorySource::NearblocksMt => {
                let token_id = row
                    .token_id
                    .as_deref()
                    .ok_or_else(|| "MT event missing token_id".to_string())?;
                if contract == "intents.near" {
                    PublicAsset::intents(token_id)
                } else {
                    PublicAsset::nep245(canonical_nep245_token_id(contract, token_id))
                }
            }
            _ => unreachable!("token_movement only receives FT/MT rows"),
        };

        Ok(Some(LedgerMovement {
            asset,
            entry_key: format!("{}:{}", row.source, row.source_event_key),
            source,
            source_event_id: row.id,
            receipt_id: row.receipt_id.clone(),
            transaction_hash: row.transaction_hash.clone(),
            counterparty: row.involved_account_id.clone(),
            block_height: row.block_height,
            block_time: row.block_time,
            delta_raw,
            decimals,
            // FT/MT legs are user-owned even when the sponsor sends them.
            affects_user_balance: true,
        }))
    }

    /// One receipt yields one movement, except a user-owned outflow whose
    /// deposit includes mandatory 1-yocto attachments: those yoctos split
    /// into a separate non-user movement, so the chain balance still counts
    /// the full deposit while the user balance only counts value moved.
    /// Without the split, every token-transfer call leaks 1 yocto of
    /// sponsor-funded plumbing into the user series and drifts it negative.
    fn native_movements(
        &self,
        group: &ReceiptDepositGroup<'_>,
    ) -> Result<Vec<LedgerMovement>, String> {
        let Some(delta_raw) = group.signed_delta_raw(self.account_id)? else {
            return Ok(Vec::new());
        };
        let first = group.first();
        let receipt_id = first
            .receipt_id
            .clone()
            .expect("receipt groups are keyed by receipt_id");
        let counterparty = group.counterparty(self.account_id);
        // Failed-deposit debits are chain plumbing like the system refunds
        // that return them (the refund inflow is already non-user via the
        // `system` counterparty rule) — both legs must stay off the user
        // series or it drifts by the deposit with no offsetting entry.
        let affects_user_balance = !group.is_failed()
            && native_movement_affects_user_balance(
                counterparty.as_deref(),
                &first.raw_payload,
                self.account_id,
                self.relayer_account,
                delta_raw.is_positive().then_some(&delta_raw),
            );
        let movement =
            |entry_key: String, delta_raw: BigDecimal, affects_user_balance: bool| LedgerMovement {
                asset: PublicAsset::native_near(),
                entry_key,
                source: PublicHistorySource::NearblocksReceipt,
                source_event_id: first.id,
                receipt_id: Some(receipt_id.clone()),
                transaction_hash: first.transaction_hash.clone(),
                counterparty: counterparty.clone(),
                block_height: first.block_height,
                block_time: first.block_time,
                delta_raw,
                decimals: NATIVE_DECIMALS,
                affects_user_balance,
            };
        let base_key = format!("native:{}:{}", self.account_id, receipt_id);

        if affects_user_balance && delta_raw.is_negative() {
            let magnitude = -delta_raw.clone();
            let attachments =
                BigDecimal::from(one_yocto_attachment_yoctos(&first.raw_payload, &magnitude))
                    .min(magnitude);
            if attachments.is_positive() {
                let user_delta = &delta_raw + &attachments;
                let mut movements = Vec::new();
                if !user_delta.is_zero() {
                    movements.push(movement(base_key.clone(), user_delta, true));
                }
                movements.push(movement(
                    format!("{base_key}:attachment"),
                    -attachments,
                    false,
                ));
                return Ok(movements);
            }
        }

        Ok(vec![movement(base_key, delta_raw, affects_user_balance)])
    }

    fn assign_running_balances(
        &mut self,
        movements: Vec<LedgerMovement>,
    ) -> Vec<BalanceLedgerEntry> {
        let mut entries = Vec::with_capacity(movements.len());
        let mut current_block = None;
        let mut intra_block_seq = 0;

        for movement in movements {
            if current_block != Some(movement.block_height) {
                current_block = Some(movement.block_height);
                intra_block_seq = 0;
            } else {
                intra_block_seq += 1;
            }

            let amount = PublicAmount::from_raw(movement.delta_raw.clone(), movement.decimals);
            let running = self
                .running_balances
                .get(movement.asset.token_id())
                .cloned()
                .unwrap_or_else(|| RunningBalance {
                    chain: BigDecimal::zero(),
                    user: BigDecimal::zero(),
                });
            let balance_before = running.chain.clone();
            let balance_after = &balance_before + &amount.amount;
            let user_balance_after = if movement.affects_user_balance {
                &running.user + &amount.amount
            } else {
                running.user.clone()
            };
            self.running_balances.insert(
                movement.asset.token_id().to_string(),
                RunningBalance {
                    chain: balance_after.clone(),
                    user: user_balance_after.clone(),
                },
            );

            entries.push(BalanceLedgerEntry {
                account_id: self.account_id.to_string(),
                asset: movement.asset,
                entry_key: movement.entry_key,
                source: movement.source,
                source_event_id: movement.source_event_id,
                receipt_id: movement.receipt_id,
                transaction_hash: movement.transaction_hash,
                counterparty: movement.counterparty,
                block_height: movement.block_height,
                block_time: movement.block_time,
                intra_block_seq,
                delta_raw: movement.delta_raw,
                delta: amount.amount,
                decimals: movement.decimals,
                balance_before,
                balance_after,
                affects_user_balance: movement.affects_user_balance,
                user_balance_after,
            });
        }
        entries
    }
}

/// Deterministic ledger order: by block, credits before debits within a
/// block, then immutable bronze ids. NearBlocks does not expose true receipt
/// execution order inside a block; credits-first is the only deterministic
/// choice that never introduces a spurious negative dip when the true
/// interleaving was non-negative, and bronze-id tie-breaks keep re-projection
/// stable.
fn order_movements(movements: &mut [LedgerMovement]) {
    movements.sort_by(|a, b| {
        a.block_height
            .cmp(&b.block_height)
            .then_with(|| debit_rank(a).cmp(&debit_rank(b)))
            .then_with(|| a.source_event_id.cmp(&b.source_event_id))
            .then_with(|| a.entry_key.cmp(&b.entry_key))
    });
}

fn debit_rank(movement: &LedgerMovement) -> u8 {
    u8::from(movement.delta_raw.is_negative())
}

fn projection_error(row: &BronzePublicHistoryRow, reason: String) -> LedgerProjectionError {
    LedgerProjectionError {
        source_event_id: row.id,
        reason,
        raw_payload: row.raw_payload.clone(),
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    const DAO: &str = "dao.near";

    #[allow(clippy::too_many_arguments)]
    fn receipt_row(
        id: i64,
        receipt_id: &str,
        event_index: i32,
        block_height: i64,
        affected: &str,
        involved: Option<&str>,
        deposit_raw: Option<&str>,
        agg_deposit: Option<&str>,
    ) -> BronzePublicHistoryRow {
        let raw_payload = match agg_deposit {
            Some(agg) => serde_json::json!({
                "receipt": { "actions_agg": { "deposit": agg } }
            }),
            None => serde_json::json!({}),
        };
        BronzePublicHistoryRow {
            id,
            account_id: DAO.to_string(),
            source: "nearblocks_receipt".to_string(),
            source_event_key: format!("{DAO}:{receipt_id}:{event_index}"),
            transaction_hash: Some("tx".to_string()),
            receipt_id: Some(receipt_id.to_string()),
            event_index: Some(event_index),
            block_height,
            block_timestamp: BigDecimal::from(0),
            block_time: Utc.timestamp_opt(block_height, 0).unwrap(),
            affected_account_id: affected.to_string(),
            involved_account_id: involved.map(str::to_string),
            contract_account_id: Some(affected.to_string()),
            token_id: None,
            cause: None,
            action_kind: Some("FUNCTION_CALL".to_string()),
            method_name: None,
            delta_amount_raw: None,
            decimals: Some(24),
            deposit_raw: deposit_raw.map(|value| BigDecimal::from_str(value).unwrap()),
            outcome_status: Some(true),
            raw_payload,
            proposal_ref: None,
            proposal_id: None,
        }
    }

    fn ft_row(id: i64, block_height: i64, delta_raw: &str) -> BronzePublicHistoryRow {
        BronzePublicHistoryRow {
            id,
            account_id: DAO.to_string(),
            source: "nearblocks_ft".to_string(),
            source_event_key: format!("ft-{id}"),
            transaction_hash: Some("tx".to_string()),
            receipt_id: Some(format!("ft-receipt-{id}")),
            event_index: Some(0),
            block_height,
            block_timestamp: BigDecimal::from(0),
            block_time: Utc.timestamp_opt(block_height, 0).unwrap(),
            affected_account_id: DAO.to_string(),
            involved_account_id: Some("alice.near".to_string()),
            contract_account_id: Some("token.near".to_string()),
            token_id: None,
            cause: None,
            action_kind: None,
            method_name: None,
            delta_amount_raw: Some(BigDecimal::from_str(delta_raw).unwrap()),
            decimals: Some(6),
            deposit_raw: None,
            outcome_status: None,
            raw_payload: serde_json::json!({}),
            proposal_ref: None,
            proposal_id: None,
        }
    }

    const RELAYER: &str = "sponsor.trezu.near";

    fn build(rows: &[BronzePublicHistoryRow]) -> LedgerBuildResult {
        BalanceLedgerBuilder::new(DAO, RELAYER, Vec::new()).build(rows)
    }

    #[test]
    fn wrap_receipt_aggregate_deposit_is_counted_once() {
        // A wrap receipt has near_deposit + ft_transfer action rows sharing one
        // receipt-level actions_agg.deposit; summing per row double-counts.
        let rows = vec![
            receipt_row(1, "r1", 0, 100, "wrap.near", Some(DAO), None, Some("500")),
            receipt_row(2, "r1", 1, 100, "wrap.near", Some(DAO), None, Some("500")),
        ];

        let result = build(&rows);

        assert!(result.errors.is_empty());
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].delta_raw, BigDecimal::from(-500));
    }

    #[test]
    fn failed_incoming_receipt_moves_no_balance() {
        let mut failed = receipt_row(1, "r1", 0, 100, DAO, Some("alice.near"), Some("700"), None);
        failed.outcome_status = Some(false);

        let result = build(&[failed]);

        assert!(result.errors.is_empty());
        assert!(result.entries.is_empty());
    }

    #[test]
    fn failed_outgoing_deposit_is_a_non_user_debit() {
        let mut failed = receipt_row(
            1,
            "r1",
            0,
            100,
            "multisender.app.near",
            Some(DAO),
            None,
            Some("700"),
        );
        failed.outcome_status = Some(false);

        let result = build(&[failed]);

        assert!(result.errors.is_empty());
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].delta_raw, BigDecimal::from(-700));
        assert!(!result.entries[0].affects_user_balance);
        assert_eq!(result.entries[0].user_balance_after, BigDecimal::zero());
    }

    #[test]
    fn failed_outgoing_without_deposit_data_is_skipped_not_an_error() {
        let mut failed = receipt_row(
            1,
            "r1",
            0,
            100,
            "multisender.app.near",
            Some(DAO),
            None,
            None,
        );
        failed.outcome_status = Some(false);

        let result = build(&[failed]);

        assert!(result.errors.is_empty());
        assert!(result.entries.is_empty());
    }

    #[test]
    fn failed_payout_and_system_refund_net_to_zero() {
        // The nearuaguild.sputnik-dao.near pattern: a proposal payout with an
        // attached deposit fails at the receiver, and the protocol refunds
        // the deposit via a system receipt whose own outcome is SUCCESS.
        // Booking only the refund fabricated +15 NEAR per failed payout.
        let mut failed = receipt_row(
            1,
            "payout",
            0,
            100,
            "multisender.app.near",
            Some(DAO),
            None,
            Some("15000"),
        );
        failed.outcome_status = Some(false);
        let refund = receipt_row(
            2,
            "refund",
            0,
            102,
            DAO,
            Some("system"),
            None,
            Some("15000"),
        );

        let result = build(&[failed, refund]);

        assert!(result.errors.is_empty());
        assert_eq!(result.entries.len(), 2);
        let last = result.entries.last().unwrap();
        assert_eq!(last.balance_after, BigDecimal::zero());
        assert_eq!(last.user_balance_after, BigDecimal::zero());
        assert!(result.entries.iter().all(|e| !e.affects_user_balance));
    }

    #[test]
    fn self_receipt_moves_no_balance() {
        let row = receipt_row(1, "r1", 0, 100, DAO, Some(DAO), Some("700"), None);

        let result = build(&[row]);

        assert!(result.entries.is_empty());
    }

    #[test]
    fn sponsor_topup_is_a_real_inflow() {
        let row = receipt_row(
            1,
            "r1",
            0,
            100,
            DAO,
            Some("sponsor.trezu.near"),
            Some("6000"),
            None,
        );

        let result = build(&[row]);

        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].delta_raw, BigDecimal::from(6000));
        assert_eq!(
            result.entries[0].counterparty.as_deref(),
            Some("sponsor.trezu.near")
        );
    }

    #[test]
    fn sponsor_topup_moves_chain_but_not_user_balance() {
        let rows = vec![
            receipt_row(1, "r1", 0, 100, DAO, Some("alice.near"), Some("1000"), None),
            receipt_row(2, "r2", 0, 101, DAO, Some(RELAYER), Some("10"), None),
            receipt_row(3, "r3", 0, 102, "bob.near", Some(DAO), Some("200"), None),
        ];

        let result = build(&rows);

        assert_eq!(result.entries.len(), 3);
        let deposit = &result.entries[0];
        assert!(deposit.affects_user_balance);
        assert_eq!(deposit.user_balance_after, deposit.balance_after);

        let sponsor = &result.entries[1];
        assert!(!sponsor.affects_user_balance);
        assert_eq!(sponsor.user_balance_after, deposit.user_balance_after);
        assert_eq!(
            sponsor.balance_after,
            &deposit.balance_after + &sponsor.delta
        );

        let sent = &result.entries[2];
        assert!(sent.affects_user_balance);
        assert_eq!(
            sent.user_balance_after,
            &deposit.user_balance_after + &sent.delta
        );
        assert_eq!(sent.balance_after, &sponsor.balance_after + &sent.delta);
    }

    #[test]
    fn system_credit_moves_chain_but_not_user_balance() {
        let row = receipt_row(1, "r1", 0, 100, DAO, Some("system"), Some("300"), None);

        let result = build(&[row]);

        assert_eq!(result.entries.len(), 1);
        assert!(!result.entries[0].affects_user_balance);
        assert_eq!(result.entries[0].user_balance_after, BigDecimal::zero());
        assert_eq!(result.entries[0].balance_after, result.entries[0].delta);
    }

    #[test]
    fn treasury_creation_deposit_is_not_user_owned() {
        let mut row = receipt_row(1, "r1", 0, 100, DAO, Some("sputnik-dao.near"), None, None);
        row.raw_payload = serde_json::json!({
            "receipt": {
                "actions": [
                    { "action": "CREATE_ACCOUNT", "method": null },
                    { "action": "TRANSFER", "method": null },
                    { "action": "USE_GLOBAL_CONTRACT", "method": null },
                    { "action": "FUNCTION_CALL", "method": "new" }
                ],
                "actions_agg": { "deposit": "9000" },
                "receiver_account_id": DAO,
                "predecessor_account_id": "sputnik-dao.near",
                "signer_id": RELAYER
            }
        });

        let result = build(&[row]);

        assert_eq!(result.entries.len(), 1);
        assert!(!result.entries[0].affects_user_balance);
        assert_eq!(result.entries[0].delta_raw, BigDecimal::from(9000));
        assert_eq!(result.entries[0].balance_after, result.entries[0].delta);
        assert_eq!(result.entries[0].user_balance_after, BigDecimal::zero());
    }

    #[test]
    fn founder_funded_creation_deposit_is_user_owned() {
        // Externally created DAO: same creation receipt shape but the
        // founder's own 6 NEAR, far above the platform's fixed funding.
        let mut row = receipt_row(1, "r1", 0, 100, DAO, Some("sputnik-dao.near"), None, None);
        row.raw_payload = serde_json::json!({
            "receipt": {
                "actions": [
                    { "action": "CREATE_ACCOUNT", "method": null },
                    { "action": "TRANSFER", "method": null },
                    { "action": "DEPLOY_CONTRACT", "method": null },
                    { "action": "FUNCTION_CALL", "method": "new" }
                ],
                "actions_agg": { "deposit": "6000000000000000000000000" },
                "receiver_account_id": DAO,
                "predecessor_account_id": "sputnik-dao.near"
            }
        });

        let result = build(&[row]);

        assert_eq!(result.entries.len(), 1);
        assert!(result.entries[0].affects_user_balance);
        assert_eq!(
            result.entries[0].user_balance_after,
            result.entries[0].balance_after
        );
    }

    #[test]
    fn plain_deposit_from_sputnik_dao_stays_user_owned() {
        // Same predecessor but no CREATE_ACCOUNT shape: a real transfer.
        let row = receipt_row(
            1,
            "r1",
            0,
            100,
            DAO,
            Some("sputnik-dao.near"),
            Some("500"),
            None,
        );

        let result = build(&[row]);

        assert_eq!(result.entries.len(), 1);
        assert!(result.entries[0].affects_user_balance);
        assert_eq!(
            result.entries[0].user_balance_after,
            result.entries[0].balance_after
        );
    }

    #[test]
    fn deposit_ten_displays_ten_through_sponsor_and_technical_movements() {
        // The canonical acceptance walk: user deposits 10, sponsor fronts
        // 0.10, a 0.01 technical cost returns to the sponsor, the user sends
        // 2. Chain balance tracks every movement; the user sees 10 -> 8.
        let ten = "10000000000000000000000000"; // 10 NEAR in yocto
        let sponsor_topup = "100000000000000000000000"; // 0.10
        let technical_cost = "10000000000000000000000"; // 0.01
        let two = "2000000000000000000000000"; // 2
        let rows = vec![
            receipt_row(
                1,
                "r-deposit",
                0,
                100,
                DAO,
                Some("alice.near"),
                Some(ten),
                None,
            ),
            receipt_row(
                2,
                "r-sponsor",
                0,
                101,
                DAO,
                Some(RELAYER),
                Some(sponsor_topup),
                None,
            ),
            receipt_row(
                3,
                "r-cost",
                0,
                102,
                RELAYER,
                Some(DAO),
                Some(technical_cost),
                None,
            ),
            receipt_row(4, "r-send", 0, 103, "bob.near", Some(DAO), Some(two), None),
        ];

        let result = build(&rows);

        assert!(result.errors.is_empty());
        assert_eq!(result.entries.len(), 4);
        let near = |value: &str| {
            PublicAmount::from_raw(BigDecimal::from_str(value).unwrap(), NATIVE_DECIMALS).amount
        };
        let user_series: Vec<BigDecimal> = result
            .entries
            .iter()
            .map(|entry| entry.user_balance_after.clone())
            .collect();
        assert_eq!(
            user_series,
            vec![
                near(ten),
                near(ten),
                near(ten),
                near("8000000000000000000000000")
            ]
        );
        let chain_head = &result.entries[3].balance_after;
        assert_eq!(chain_head, &near("8090000000000000000000000"));
    }

    #[test]
    fn standalone_one_yocto_transfer_attachment_is_not_user_owned() {
        // mt_transfer to intents.near: the whole receipt deposit is the
        // mandatory 1-yocto attachment. Chain balance moves; user must not.
        let mut row = receipt_row(1, "r1", 0, 100, "intents.near", Some(DAO), None, Some("1"));
        row.raw_payload = serde_json::json!({
            "receipt": {
                "actions": [{ "action": "FUNCTION_CALL", "method": "mt_transfer" }],
                "actions_agg": { "deposit": "1" }
            }
        });

        let result = build(&[row]);

        assert!(result.errors.is_empty());
        assert_eq!(result.entries.len(), 1);
        let entry = &result.entries[0];
        assert!(!entry.affects_user_balance);
        assert_eq!(entry.entry_key, format!("native:{DAO}:r1:attachment"));
        assert_eq!(entry.delta_raw, BigDecimal::from(-1));
        assert_eq!(
            entry.balance_after,
            PublicAmount::from_raw(BigDecimal::from(-1), NATIVE_DECIMALS).amount
        );
        assert_eq!(entry.user_balance_after, BigDecimal::zero());
    }

    #[test]
    fn one_yocto_deposit_on_any_function_call_is_an_attachment() {
        // `sign` on v1.signer / `add_public_key` on intents.near: methods
        // outside the known list, but the whole deposit is 1 yocto —
        // universal `assert_one_yocto`, never user value (observed drifting
        // beyond.sputnik-dao.near negative).
        let mut row = receipt_row(1, "r1", 0, 100, "v1.signer", Some(DAO), None, Some("1"));
        row.raw_payload = serde_json::json!({
            "receipt": {
                "actions": [{ "action": "FUNCTION_CALL", "method": "sign" }],
                "actions_agg": { "deposit": "1" }
            }
        });

        let result = build(&[row]);

        assert_eq!(result.entries.len(), 1);
        assert!(!result.entries[0].affects_user_balance);
        assert_eq!(result.entries[0].user_balance_after, BigDecimal::zero());
    }

    #[test]
    fn wrap_receipt_splits_attachment_from_user_outflow() {
        // near_deposit(0.2) + ft_transfer share one aggregate deposit of
        // 0.2 NEAR + 1 yocto. The user spent exactly 0.2; the extra yocto is
        // the ft_transfer attachment.
        let two_tenths = "200000000000000000000000";
        let mut wrap = receipt_row(
            2,
            "r-wrap",
            0,
            101,
            "wrap.near",
            Some(DAO),
            None,
            Some("200000000000000000000001"),
        );
        wrap.raw_payload = serde_json::json!({
            "receipt": {
                "actions": [
                    { "action": "FUNCTION_CALL", "method": "near_deposit" },
                    { "action": "FUNCTION_CALL", "method": "ft_transfer" }
                ],
                "actions_agg": { "deposit": "200000000000000000000001" }
            }
        });
        let rows = vec![
            receipt_row(
                1,
                "r-in",
                0,
                100,
                DAO,
                Some("alice.near"),
                Some(two_tenths),
                None,
            ),
            wrap,
        ];

        let result = build(&rows);

        assert!(result.errors.is_empty());
        assert_eq!(result.entries.len(), 3);
        let near = |value: &str| {
            PublicAmount::from_raw(BigDecimal::from_str(value).unwrap(), NATIVE_DECIMALS).amount
        };
        let user_part = &result.entries[1];
        assert!(user_part.affects_user_balance);
        assert_eq!(user_part.delta, near("-200000000000000000000000"));
        let attachment = &result.entries[2];
        assert!(!attachment.affects_user_balance);
        assert_eq!(attachment.delta, near("-1"));
        // User spent exactly the deposit; the yocto stays out of the series.
        assert_eq!(attachment.user_balance_after, BigDecimal::zero());
        assert_eq!(attachment.balance_after, near("-1"));
    }

    #[test]
    fn ft_leg_from_sponsor_stays_user_owned() {
        let mut row = ft_row(1, 100, "700");
        row.involved_account_id = Some(RELAYER.to_string());

        let result = build(&[row]);

        assert_eq!(result.entries.len(), 1);
        assert!(result.entries[0].affects_user_balance);
    }

    #[test]
    fn credits_order_before_debits_within_a_block() {
        // Debit arrives with a lower bronze id than the credit in the same
        // block; credits-first ordering must keep the running balance from a
        // spurious negative dip.
        let rows = vec![
            receipt_row(1, "r-out", 0, 100, "bob.near", Some(DAO), Some("400"), None),
            receipt_row(
                2,
                "r-in",
                0,
                100,
                DAO,
                Some("alice.near"),
                Some("400"),
                None,
            ),
        ];

        let result = build(&rows);

        assert_eq!(result.entries.len(), 2);
        assert!(result.entries[0].delta_raw.is_positive());
        assert_eq!(result.entries[0].intra_block_seq, 0);
        assert_eq!(result.entries[1].intra_block_seq, 1);
        assert!(
            result
                .entries
                .iter()
                .all(|entry| !entry.balance_after.is_negative())
        );
    }

    #[test]
    fn running_balance_continues_from_seed() {
        let seeds = vec![BalanceSeedRow {
            asset: "token.near".to_string(),
            balance_after: BigDecimal::from_str("1.5").unwrap(),
            user_balance_after: BigDecimal::from_str("1.2").unwrap(),
        }];
        let rows = vec![ft_row(1, 100, "-1000000")];

        let result = BalanceLedgerBuilder::new(DAO, RELAYER, seeds).build(&rows);

        assert_eq!(result.entries.len(), 1);
        assert_eq!(
            result.entries[0].balance_before,
            BigDecimal::from_str("1.5").unwrap()
        );
        assert_eq!(
            result.entries[0].balance_after,
            BigDecimal::from_str("0.5").unwrap()
        );
        assert_eq!(
            result.entries[0].user_balance_after,
            BigDecimal::from_str("0.2").unwrap()
        );
    }

    #[test]
    fn ordering_is_deterministic_across_input_permutations() {
        let rows = vec![
            receipt_row(3, "r-b", 0, 100, DAO, Some("alice.near"), Some("10"), None),
            ft_row(4, 100, "250"),
            receipt_row(5, "r-c", 0, 100, "bob.near", Some(DAO), Some("5"), None),
        ];
        let mut reversed = rows.clone();
        reversed.reverse();

        let forward = build(&rows);
        let backward = build(&reversed);

        let keys = |entries: &[BalanceLedgerEntry]| {
            entries
                .iter()
                .map(|entry| (entry.entry_key.clone(), entry.intra_block_seq))
                .collect::<Vec<_>>()
        };
        assert_eq!(keys(&forward.entries), keys(&backward.entries));
    }
}
