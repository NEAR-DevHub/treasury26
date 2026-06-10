//! Backend-driven NEP-141 `storage_deposit` handling for relayed approvals.
//!
//! When an approving vote (`act_proposal` with `VoteApprove`) is relayed, the
//! backend inspects the on-chain proposal kind, derives which accounts need to
//! be registered on which token contracts, and performs the `storage_deposit`
//! calls itself (signed and paid by the sponsor) before the vote executes the
//! transfer. This removes the extra `storage_deposit` transactions the user
//! used to sign in the relay flow.
//!
//! Derivation uses ONLY the authoritative on-chain proposal kind (fetched via
//! `get_proposal`) — never the proposal description.

use std::collections::HashSet;
use std::ops::Deref;
use std::sync::Arc;

use base64::Engine as _;
use near_api::{
    AccountId, NearGas, NearToken, Transaction,
    types::{
        Action,
        transaction::{actions::FunctionCallAction, delegate_action::SignedDelegateAction},
    },
};
use serde_json::Value;

use crate::{
    AppState,
    handlers::{
        proposals::scraper::{fetch_batch_payment_list, fetch_proposal},
        relay::submit::extract_intents_contract,
        token::storage_deposit::is_registered::check_storage_deposit,
    },
};

/// Standard NEP-141 registration cost (0.00125 NEAR). The contract refunds any
/// excess, and `registration_only: true` is a no-op when already registered.
pub const STORAGE_DEPOSIT_AMOUNT: NearToken = NearToken::from_micronear(1250);
const STORAGE_DEPOSIT_GAS: NearGas = NearGas::from_tgas(30);
/// Upper bound on registrations performed for a single approval. Bulk payment
/// lists are capped well under this on the contract side; this is a backstop.
const MAX_STORAGE_DEPOSITS: usize = 200;

/// A single `(account_to_register, token_contract)` registration target.
type Target = (AccountId, AccountId);

fn is_native_token(token_id: &str) -> bool {
    token_id.is_empty() || token_id.eq_ignore_ascii_case("near")
}

/// Return the proposal id if these `act_proposal` args represent a `VoteApprove`.
fn approve_id_from_act_proposal_args(args: &Value) -> Option<u64> {
    if args.get("action").and_then(Value::as_str) == Some("VoteApprove") {
        args.get("id").and_then(Value::as_u64)
    } else {
        None
    }
}

/// Collect the proposal ids being approved (`VoteApprove`) in this delegate action.
pub fn vote_approve_proposal_ids(signed_delegate_action: &SignedDelegateAction) -> Vec<u64> {
    let mut ids = Vec::new();
    for action in &signed_delegate_action.delegate_action.actions {
        if let Action::FunctionCall(function_call) = action.deref()
            && function_call.method_name == "act_proposal"
            && let Ok(args) = serde_json::from_slice::<Value>(&function_call.args)
            && let Some(id) = approve_id_from_act_proposal_args(&args)
        {
            ids.push(id);
        }
    }
    ids
}

/// A bulk payment list whose recipients must be registered on `token`.
struct BulkList {
    token: AccountId,
    list_id: String,
}

/// Result of classifying a proposal kind: directly-known targets plus any bulk
/// lists whose recipients still need to be resolved over the network.
#[derive(Default)]
struct ClassifiedTargets {
    direct: Vec<Target>,
    bulk_lists: Vec<BulkList>,
}

/// Fetch a proposal by id and derive its storage-deposit targets. Failures to
/// read the proposal are logged and yield no targets (the vote still proceeds).
pub async fn derive_targets_for_proposal(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    proposal_id: u64,
) -> Vec<Target> {
    let proposal = match fetch_proposal(&state.network, treasury_id, proposal_id).await {
        Ok(proposal) => proposal,
        Err(e) => {
            log::warn!(
                "storage_deposit: failed to fetch proposal {} for {}: {}",
                proposal_id,
                treasury_id,
                e
            );
            return Vec::new();
        }
    };

    let ClassifiedTargets {
        mut direct,
        bulk_lists,
    } = classify_kind(&proposal.kind, &state.bulk_payment_contract_id);

    // Expand each bulk list's recipients via the on-chain list.
    for BulkList { token, list_id } in bulk_lists {
        match fetch_batch_payment_list(&state.network, &list_id, &state.bulk_payment_contract_id)
            .await
        {
            Ok(list) => {
                for payment in list.payments {
                    // Non-NEAR (cross-chain) recipients can't be NEP-141 registered.
                    if let Ok(recipient) = payment.recipient.parse::<AccountId>() {
                        direct.push((recipient, token.clone()));
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    "storage_deposit: failed to fetch bulk list {}: {}",
                    list_id,
                    e
                );
            }
        }
    }

    direct
}

fn decode_action_args(action: &Value) -> Option<Value> {
    let args_b64 = action.get("args")?.as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(args_b64)
        .ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()
}

/// Classify a proposal's on-chain `kind` into storage-deposit targets, without
/// any network access. Bulk recipient lists are returned for later expansion.
///
/// Only these shapes register anything (everything else → none):
/// - `Transfer { token_id, receiver_id }` with a non-native token.
/// - `FunctionCall` actions `ft_transfer` / `ft_transfer_call` (with a bulk
///   special case that registers the bulk contract and expands recipients).
/// - `FunctionCall` action `mt_transfer_call` to the bulk contract when the
///   intents `token_id` is a `nep141:` asset.
fn classify_kind(kind: &Value, bulk_contract: &AccountId) -> ClassifiedTargets {
    let mut out = ClassifiedTargets::default();

    // Sputnik native `Transfer` kind (the main direct-FT-payment path).
    if let Some(transfer) = kind.get("Transfer") {
        let token_id = transfer
            .get("token_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let receiver_id = transfer
            .get("receiver_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !is_native_token(token_id)
            && let (Ok(account), Ok(token)) =
                (receiver_id.parse::<AccountId>(), token_id.parse::<AccountId>())
        {
            out.direct.push((account, token));
        }
        return out;
    }

    let Some(func_call) = kind.get("FunctionCall") else {
        return out;
    };
    let call_receiver = func_call
        .get("receiver_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let Some(actions) = func_call.get("actions").and_then(Value::as_array) else {
        return out;
    };

    for action in actions {
        let method = action
            .get("method_name")
            .and_then(Value::as_str)
            .unwrap_or("");
        match method {
            // `ft_transfer` on a token contract → register the recipient on it.
            "ft_transfer" => {
                if let Some(args) = decode_action_args(action)
                    && let Some(recv) = args.get("receiver_id").and_then(Value::as_str)
                    && let (Ok(account), Ok(token)) =
                        (recv.parse::<AccountId>(), call_receiver.parse::<AccountId>())
                {
                    out.direct.push((account, token));
                }
            }
            // `ft_transfer_call` on a token contract. To the bulk contract →
            // register the bulk contract + every NEAR recipient; otherwise →
            // register the call's receiver.
            "ft_transfer_call" => {
                let Some(args) = decode_action_args(action) else {
                    continue;
                };
                let Ok(token) = call_receiver.parse::<AccountId>() else {
                    continue;
                };
                let arg_receiver = args
                    .get("receiver_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if arg_receiver == bulk_contract.as_str() {
                    out.direct.push((bulk_contract.clone(), token.clone()));
                    if let Some(list_id) = args.get("msg").and_then(Value::as_str) {
                        out.bulk_lists.push(BulkList {
                            token,
                            list_id: list_id.to_string(),
                        });
                    }
                } else if let Ok(account) = arg_receiver.parse::<AccountId>() {
                    out.direct.push((account, token));
                }
            }
            // Intents bulk payment: `mt_transfer_call` to the bulk contract on
            // `intents.near`, where the underlying token is a `nep141:` asset.
            "mt_transfer_call" => {
                let Some(args) = decode_action_args(action) else {
                    continue;
                };
                let arg_receiver = args
                    .get("receiver_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if arg_receiver != bulk_contract.as_str() {
                    continue;
                }
                let token_id_field = args.get("token_id").and_then(Value::as_str).unwrap_or("");
                let Some(contract) = extract_intents_contract(token_id_field) else {
                    continue;
                };
                let Ok(token) = contract.parse::<AccountId>() else {
                    continue;
                };
                out.direct.push((bulk_contract.clone(), token.clone()));
                if let Some(list_id) = args.get("msg").and_then(Value::as_str) {
                    out.bulk_lists.push(BulkList {
                        token,
                        list_id: list_id.to_string(),
                    });
                }
            }
            _ => {}
        }
    }

    out
}

/// Dedupe targets and enforce the per-approval cap.
fn prepare_targets(targets: Vec<Target>) -> Result<Vec<Target>, String> {
    let mut seen = HashSet::new();
    let deduped: Vec<Target> = targets
        .into_iter()
        .filter(|(account, token)| seen.insert((account.to_string(), token.to_string())))
        .collect();

    if deduped.len() > MAX_STORAGE_DEPOSITS {
        return Err(format!(
            "Too many storage_deposit registrations required ({} > {})",
            deduped.len(),
            MAX_STORAGE_DEPOSITS
        ));
    }
    Ok(deduped)
}

/// Perform the required registrations concurrently, skipping already-registered
/// accounts. Returns the number of `storage_deposit` calls actually sent (for
/// `paid_near` accounting). Errors if a required registration fails.
pub async fn execute_storage_deposits(
    state: &Arc<AppState>,
    targets: Vec<Target>,
) -> Result<u32, String> {
    let deduped = prepare_targets(targets)?;
    if deduped.is_empty() {
        return Ok(0);
    }

    let futures = deduped.into_iter().map(|(account, token)| {
        let state = state.clone();
        async move { register_one(&state, &account, &token).await }
    });
    let results = futures::future::join_all(futures).await;

    let mut count: u32 = 0;
    for result in results {
        match result {
            Ok(true) => count += 1,
            Ok(false) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(count)
}

/// Register a single account on a token contract. Returns `Ok(true)` when a
/// `storage_deposit` was actually sent, `Ok(false)` when already registered.
async fn register_one(
    state: &Arc<AppState>,
    account_id: &AccountId,
    token_id: &AccountId,
) -> Result<bool, String> {
    match check_storage_deposit(state, account_id.clone(), token_id.clone()).await {
        Ok(true) => return Ok(false),
        Ok(false) => {}
        Err(e) => {
            // Couldn't verify — attempt anyway; storage_deposit refunds if
            // the account turns out to be already registered.
            log::warn!(
                "storage_deposit: registration check failed for {} on {}: {}",
                account_id,
                token_id,
                e
            );
        }
    }

    let args = serde_json::to_vec(&serde_json::json!({
        "account_id": account_id,
        "registration_only": true,
    }))
    .map_err(|e| e.to_string())?;

    Transaction::construct(state.signer_id.clone(), token_id.clone())
        .add_action(Action::FunctionCall(Box::new(FunctionCallAction {
            method_name: "storage_deposit".to_string(),
            args,
            gas: STORAGE_DEPOSIT_GAS,
            deposit: STORAGE_DEPOSIT_AMOUNT,
        })))
        .with_signer(state.signer.clone())
        .send_to(&state.network)
        .await
        .map_err(|e| {
            format!(
                "Failed to send storage_deposit for {} on {}: {}",
                account_id, token_id, e
            )
        })?
        .into_result()
        .map_err(|e| {
            format!(
                "storage_deposit failed for {} on {}: {}",
                account_id, token_id, e
            )
        })?;

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bulk() -> AccountId {
        "bulkpayment.near".parse().unwrap()
    }

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    /// Build a FunctionCall action with base64-encoded JSON args.
    fn fc_action(method: &str, args: serde_json::Value) -> serde_json::Value {
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_vec(&args).unwrap());
        json!({ "method_name": method, "args": encoded })
    }

    fn function_call_kind(receiver: &str, actions: Vec<serde_json::Value>) -> serde_json::Value {
        json!({ "FunctionCall": { "receiver_id": receiver, "actions": actions } })
    }

    #[test]
    fn transfer_ft_registers_recipient() {
        let kind = json!({ "Transfer": { "token_id": "usdc.near", "receiver_id": "alice.near" } });
        let out = classify_kind(&kind, &bulk());
        assert_eq!(out.direct, vec![(acc("alice.near"), acc("usdc.near"))]);
        assert!(out.bulk_lists.is_empty());
    }

    #[test]
    fn transfer_native_registers_nothing() {
        let kind = json!({ "Transfer": { "token_id": "", "receiver_id": "alice.near" } });
        let out = classify_kind(&kind, &bulk());
        assert!(out.direct.is_empty());

        let kind = json!({ "Transfer": { "token_id": "near", "receiver_id": "alice.near" } });
        assert!(classify_kind(&kind, &bulk()).direct.is_empty());
    }

    #[test]
    fn ft_transfer_registers_receiver_on_token() {
        let kind = function_call_kind(
            "usdc.near",
            vec![fc_action("ft_transfer", json!({ "receiver_id": "deposit.near", "amount": "5" }))],
        );
        let out = classify_kind(&kind, &bulk());
        assert_eq!(out.direct, vec![(acc("deposit.near"), acc("usdc.near"))]);
        assert!(out.bulk_lists.is_empty());
    }

    #[test]
    fn near_deposit_plus_ft_transfer_only_registers_transfer_receiver() {
        // Native NEAR via intents/exchange: near_deposit is ignored, ft_transfer covers the deposit address.
        let kind = function_call_kind(
            "wrap.near",
            vec![
                fc_action("near_deposit", json!({})),
                fc_action("ft_transfer", json!({ "receiver_id": "1click.near", "amount": "5" })),
            ],
        );
        let out = classify_kind(&kind, &bulk());
        assert_eq!(out.direct, vec![(acc("1click.near"), acc("wrap.near"))]);
    }

    #[test]
    fn ft_transfer_call_non_bulk_registers_receiver() {
        let kind = function_call_kind(
            "usdc.near",
            vec![fc_action(
                "ft_transfer_call",
                json!({ "receiver_id": "somecontract.near", "amount": "5", "msg": "x" }),
            )],
        );
        let out = classify_kind(&kind, &bulk());
        assert_eq!(out.direct, vec![(acc("somecontract.near"), acc("usdc.near"))]);
        assert!(out.bulk_lists.is_empty());
    }

    #[test]
    fn ft_transfer_call_bulk_registers_contract_and_queues_list() {
        let kind = function_call_kind(
            "usdc.near",
            vec![fc_action(
                "ft_transfer_call",
                json!({ "receiver_id": "bulkpayment.near", "amount": "5", "msg": "list-7" }),
            )],
        );
        let out = classify_kind(&kind, &bulk());
        assert_eq!(out.direct, vec![(bulk(), acc("usdc.near"))]);
        assert_eq!(out.bulk_lists.len(), 1);
        assert_eq!(out.bulk_lists[0].token, acc("usdc.near"));
        assert_eq!(out.bulk_lists[0].list_id, "list-7");
    }

    #[test]
    fn mt_transfer_call_bulk_nep141_strips_prefix() {
        let kind = function_call_kind(
            "intents.near",
            vec![fc_action(
                "mt_transfer_call",
                json!({
                    "receiver_id": "bulkpayment.near",
                    "token_id": "nep141:usdt.tether-token.near",
                    "amount": "5",
                    "msg": "list-9"
                }),
            )],
        );
        let out = classify_kind(&kind, &bulk());
        assert_eq!(out.direct, vec![(bulk(), acc("usdt.tether-token.near"))]);
        assert_eq!(out.bulk_lists.len(), 1);
        assert_eq!(out.bulk_lists[0].token, acc("usdt.tether-token.near"));
        assert_eq!(out.bulk_lists[0].list_id, "list-9");
    }

    #[test]
    fn mt_transfer_non_bulk_registers_nothing() {
        // Plain intents transfer/exchange: no NEP-141 storage_deposit.
        let kind = function_call_kind(
            "intents.near",
            vec![fc_action(
                "mt_transfer",
                json!({ "receiver_id": "1click.near", "token_id": "nep141:usdc.near", "amount": "5" }),
            )],
        );
        let out = classify_kind(&kind, &bulk());
        assert!(out.direct.is_empty());
        assert!(out.bulk_lists.is_empty());
    }

    #[test]
    fn unrelated_methods_register_nothing() {
        let kind = function_call_kind(
            "wrap.near",
            vec![fc_action("near_withdraw", json!({ "amount": "5" }))],
        );
        let out = classify_kind(&kind, &bulk());
        assert!(out.direct.is_empty());

        // approve_list (NEAR bulk) — no FT registration.
        let kind = function_call_kind(
            "bulkpayment.near",
            vec![fc_action("approve_list", json!({ "list_id": "list-1" }))],
        );
        assert!(classify_kind(&kind, &bulk()).direct.is_empty());
    }

    #[test]
    fn approve_id_parsing() {
        assert_eq!(
            approve_id_from_act_proposal_args(&json!({ "id": 12, "action": "VoteApprove" })),
            Some(12)
        );
        assert_eq!(
            approve_id_from_act_proposal_args(&json!({ "id": 12, "action": "VoteReject" })),
            None
        );
        assert_eq!(
            approve_id_from_act_proposal_args(&json!({ "action": "VoteApprove" })),
            None
        );
    }

    #[test]
    fn prepare_targets_dedupes() {
        let targets = vec![
            (acc("alice.near"), acc("usdc.near")),
            (acc("alice.near"), acc("usdc.near")),
            (acc("bob.near"), acc("usdc.near")),
        ];
        let prepared = prepare_targets(targets).unwrap();
        assert_eq!(prepared.len(), 2);
    }

    #[test]
    fn prepare_targets_enforces_cap() {
        let targets: Vec<Target> = (0..(MAX_STORAGE_DEPOSITS + 1))
            .map(|i| (acc(&format!("a{i}.near")), acc("usdc.near")))
            .collect();
        assert!(prepare_targets(targets).is_err());
    }
}
