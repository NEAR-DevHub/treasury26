//! Economic ownership classification for native ledger movements.
//!
//! The chain balance counts every movement; the user-owned balance excludes
//! platform plumbing. Classification happens exactly once, here at write
//! time — never at read time. The legacy chart instead subtracted cumulative
//! sponsor totals per request, which double-counts once sponsor funds are
//! storage-locked (the display basis already excluded them) and drives the
//! "now" point toward zero as drips accumulate.
//!
//! The deny-list is deterministic and mirrored by the gold feed-noise rules:
//! native legs against the sponsor/relayer or `system`, and the
//! platform-funded treasury-creation receipt. Everything else — including
//! hidden refunds and internal movements — belongs to the user. FT/MT legs
//! from the sponsor stay user-owned (the sponsor never gifts tokens; those
//! are real transfers it merely relayed).
//!
//! The sponsor is deliberately NOT a hardcoded account list: each
//! environment's `SIGNER_ID` is its sponsor (prod `sponsor.trezu.near`,
//! staging `sponsor-staging.trezu.near`). A hardcoded list classified other
//! environments' sponsors wrong and could never cover local test signers.
//! Corollary: replaying another environment's data locally requires setting
//! `SIGNER_ID` to that environment's sponsor, or its drips count as user
//! deposits — and deposits from the local signer get excluded.

use bigdecimal::{BigDecimal, num_traits::One};
use serde_json::Value;

const SYSTEM_ACCOUNT: &str = "system";

/// Platform-sponsored DAO creations attach a fixed small funding amount
/// (~0.09 NEAR); anything above this threshold is founder capital.
///
/// The creation receipt alone cannot distinguish the two cases because
/// NearBlocks often omits the signer: an externally created DAO looks
/// identical to a platform-sponsored one. Excluding a founder-funded
/// creation starts the user series below its real spending power and dips
/// it negative on the first outflow, which fails verification's
/// never-negative invariant and blocks the chart (observed on
/// `n1-staking.sputnik-dao.near`, created externally in 2024 with a 6 NEAR
/// founder deposit).
pub const MAX_PLATFORM_CREATION_DEPOSIT_YOCTO: u128 = 200_000_000_000_000_000_000_000;

/// The threshold as a BigDecimal, allocated once — comparison sites must not
/// build an owned instance per call (clippy::cmp_owned).
pub fn max_platform_creation_deposit() -> &'static BigDecimal {
    static THRESHOLD: std::sync::OnceLock<BigDecimal> = std::sync::OnceLock::new();
    THRESHOLD.get_or_init(|| BigDecimal::from(MAX_PLATFORM_CREATION_DEPOSIT_YOCTO))
}

/// Whether a native movement's signed delta belongs to the user balance.
/// The relayer/sponsor account is environment configuration: each system's
/// `SIGNER_ID` is its sponsor, threaded here as `relayer_account`.
pub fn native_movement_affects_user_balance(
    counterparty: Option<&str>,
    raw_payload: &Value,
    account_id: &str,
    relayer_account: &str,
    inflow_raw: Option<&BigDecimal>,
) -> bool {
    if matches!(counterparty, Some(cp) if cp == relayer_account || cp == SYSTEM_ACCOUNT) {
        return false;
    }
    if let Some(inflow_raw) = inflow_raw
        && inflow_raw <= max_platform_creation_deposit()
        && is_treasury_creation_receipt(raw_payload, account_id, relayer_account)
    {
        return false;
    }
    true
}

/// Methods whose standards mandate an attached deposit of exactly
/// 1 yoctoNEAR (`assert_one_yocto`): NEP-141/145/245 transfer and withdraw
/// calls, plus wrap.near's `near_withdraw`. A call with any other deposit
/// panics, and failed receipts never reach the ledger — so each occurrence
/// in a successful receipt contributed exactly 1 yocto to the receipt's
/// aggregate deposit.
///
/// The list only matters for receipts that also move real value (a wrap's
/// `near_deposit` + `ft_transfer` share one aggregate deposit); a receipt
/// whose ENTIRE deposit is 1 yocto is classified as an attachment without
/// consulting it — `assert_one_yocto` is a universal security pattern
/// (`sign` on v1.signer, `add_public_key` on intents.near, …) and 1 yocto
/// is never a real payment.
const ONE_YOCTO_METHODS: &[&str] = &[
    "ft_transfer",
    "ft_transfer_call",
    "ft_withdraw",
    "near_withdraw",
    "mt_transfer",
    "mt_batch_transfer",
    "mt_transfer_call",
    "mt_batch_transfer_call",
    "mt_withdraw",
    "storage_withdraw",
    "storage_unregister",
];

/// Yoctos of a receipt's outgoing deposit that are mandatory 1-yocto
/// security attachments rather than value moved. These are plumbing: the
/// sponsor top-ups that fund them are excluded from the user ledger, so
/// counting the attachments as user outflows drifts the user balance
/// negative by 1 yocto per token-transfer call.
pub fn one_yocto_attachment_yoctos(raw_payload: &Value, deposit_magnitude: &BigDecimal) -> u32 {
    let actions = raw_payload
        .get("receipt")
        .and_then(|receipt| receipt.get("actions"))
        .and_then(Value::as_array);
    let function_call = |entry: &Value| {
        entry
            .get("action")
            .and_then(Value::as_str)
            .is_some_and(|action| action.eq_ignore_ascii_case("FUNCTION_CALL"))
    };

    // A function-call receipt whose whole deposit is 1 yocto is pure
    // attachment, whatever the method.
    if deposit_magnitude.is_one()
        && actions.is_some_and(|actions| actions.iter().any(function_call))
    {
        return 1;
    }

    actions
        .map(|actions| {
            actions
                .iter()
                .filter(|entry| {
                    function_call(entry)
                        && entry
                            .get("method")
                            .and_then(Value::as_str)
                            .is_some_and(|method| {
                                ONE_YOCTO_METHODS
                                    .iter()
                                    .any(|expected| method.eq_ignore_ascii_case(expected))
                            })
                })
                .count() as u32
        })
        .unwrap_or(0)
}

fn receipt_field<'a>(receipt: &'a Value, key: &str) -> Option<&'a str> {
    receipt.get(key).and_then(Value::as_str)
}

fn receipt_field_matches(receipt: &Value, key: &str, expected: &str) -> bool {
    receipt_field(receipt, key) == Some(expected)
}

fn receipt_has_action(receipt: &Value, action: &str, method: Option<&str>) -> bool {
    receipt
        .get("actions")
        .and_then(Value::as_array)
        .is_some_and(|actions| {
            actions.iter().any(|entry| {
                let action_matches = entry
                    .get("action")
                    .and_then(Value::as_str)
                    .is_some_and(|actual| actual.eq_ignore_ascii_case(action));
                let method_matches = method.is_none_or(|expected| {
                    entry
                        .get("method")
                        .and_then(Value::as_str)
                        .is_some_and(|actual| actual.eq_ignore_ascii_case(expected))
                });
                action_matches && method_matches
            })
        })
}

fn receipt_signer_is_relayer_if_present(receipt: &Value, relayer_account: &str) -> bool {
    ["signer_id", "signer_account_id"]
        .iter()
        .find_map(|key| receipt_field(receipt, key))
        .is_none_or(|signer| signer == relayer_account)
}

/// The initial DAO creation funding receipt: relayer-signed, sent by
/// `sputnik-dao.near`, carrying CREATE_ACCOUNT + TRANSFER + contract
/// deployment + `new`.
fn is_treasury_creation_receipt(
    raw_payload: &Value,
    account_id: &str,
    relayer_account: &str,
) -> bool {
    let Some(receipt) = raw_payload.get("receipt") else {
        return false;
    };
    if !receipt_signer_is_relayer_if_present(receipt, relayer_account) {
        return false;
    }
    if !receipt_field_matches(receipt, "receiver_account_id", account_id)
        || !receipt_field_matches(receipt, "predecessor_account_id", "sputnik-dao.near")
    {
        return false;
    }

    receipt_has_action(receipt, "CREATE_ACCOUNT", None)
        && receipt_has_action(receipt, "TRANSFER", None)
        && (receipt_has_action(receipt, "USE_GLOBAL_CONTRACT", None)
            || receipt_has_action(receipt, "DEPLOY_CONTRACT", None))
        && receipt_has_action(receipt, "FUNCTION_CALL", Some("new"))
}
