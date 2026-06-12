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
use std::time::Duration;

use base64::Engine as _;
use near_api::{
    AccountId, NearGas, NearToken, Transaction,
    types::{
        Action,
        transaction::{actions::FunctionCallAction, delegate_action::SignedDelegateAction},
    },
};
use serde::Deserialize;
use serde::de::DeserializeOwned;

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
pub(crate) const STORAGE_DEPOSIT_AMOUNT: NearToken = NearToken::from_micronear(1250);
const STORAGE_DEPOSIT_GAS: NearGas = NearGas::from_tgas(30);
/// Upper bound on registrations performed for a single approval. Bulk payment
/// lists are capped well under this on the contract side; this is a backstop.
const MAX_STORAGE_DEPOSITS: usize = 200;
/// How many times to retry a single `storage_deposit` send before failing the
/// approval, to ride out transient RPC/network errors.
const MAX_REGISTER_ATTEMPTS: usize = 3;
const REGISTER_RETRY_DELAY: Duration = Duration::from_millis(500);

/// A single account that must be registered on a token contract.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct Registration {
    account_id: AccountId,
    token_id: AccountId,
}

// ─── Typed views over the on-chain proposal kind / action args ──────────────────

/// Sputnik proposal `kind`. Only the variants that can imply a NEP-141
/// registration are modelled; everything else deserializes to `None` fields.
#[derive(Debug, Default, Deserialize)]
struct ProposalKind {
    #[serde(rename = "Transfer")]
    transfer: Option<TransferKind>,
    #[serde(rename = "FunctionCall")]
    function_call: Option<FunctionCallKind>,
}

#[derive(Debug, Deserialize)]
struct TransferKind {
    // Native NEAR uses the sentinel token_id "", which is not a valid
    // AccountId; such transfers fail to deserialize and yield no registration
    // (correct — native NEAR needs none).
    token_id: AccountId,
    receiver_id: AccountId,
}

#[derive(Debug, Deserialize)]
struct FunctionCallKind {
    receiver_id: AccountId,
    #[serde(default)]
    actions: Vec<ProposalFunctionCall>,
}

#[derive(Debug, Deserialize)]
struct ProposalFunctionCall {
    method_name: String,
    /// Base64-encoded JSON args.
    #[serde(default)]
    args: String,
}

#[derive(Debug, Deserialize)]
struct FtTransferArgs {
    receiver_id: AccountId,
}

#[derive(Debug, Deserialize)]
struct FtTransferCallArgs {
    receiver_id: AccountId,
    #[serde(default)]
    msg: String,
}

#[derive(Debug, Deserialize)]
struct MtTransferCallArgs {
    receiver_id: AccountId,
    /// Intents asset id, e.g. `nep141:usdc.near` — not a bare AccountId.
    token_id: String,
    #[serde(default)]
    msg: String,
}

#[derive(Debug, Deserialize)]
struct ActProposalArgs {
    id: u64,
    action: String,
}

fn is_native_token(token_id: &str) -> bool {
    token_id.is_empty() || token_id.eq_ignore_ascii_case("near")
}

/// Decode base64-encoded JSON action args into a typed struct.
fn decode_args<T: DeserializeOwned>(encoded: &str) -> Option<T> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Return the proposal id if these `act_proposal` args represent a `VoteApprove`.
fn approve_proposal_id(args: &ActProposalArgs) -> Option<u64> {
    (args.action == "VoteApprove").then_some(args.id)
}

/// Collect the proposal ids being approved (`VoteApprove`) in this delegate action.
pub(crate) fn vote_approve_proposal_ids(signed_delegate_action: &SignedDelegateAction) -> Vec<u64> {
    let mut ids = Vec::new();
    for action in &signed_delegate_action.delegate_action.actions {
        if let Action::FunctionCall(function_call) = action.deref()
            && function_call.method_name == "act_proposal"
            && let Ok(args) = serde_json::from_slice::<ActProposalArgs>(&function_call.args)
            && let Some(id) = approve_proposal_id(&args)
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
/// Targets are deduplicated via the `HashSet` as they are collected.
#[derive(Default)]
struct ClassifiedTargets {
    direct: HashSet<Registration>,
    bulk_lists: Vec<BulkList>,
}

/// Fetch a proposal by id and derive its storage-deposit targets. Failures to
/// read the proposal are logged and yield no targets (the vote still proceeds).
pub(crate) async fn derive_targets_for_proposal(
    state: &Arc<AppState>,
    treasury_id: &AccountId,
    proposal_id: u64,
) -> HashSet<Registration> {
    let proposal = match fetch_proposal(&state.network, treasury_id, proposal_id).await {
        Ok(proposal) => proposal,
        Err(e) => {
            log::warn!(
                "storage_deposit: failed to fetch proposal {} for {}: {}",
                proposal_id,
                treasury_id,
                e
            );
            return HashSet::new();
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
                    if let Ok(account_id) = payment.recipient.parse::<AccountId>() {
                        direct.insert(Registration {
                            account_id,
                            token_id: token.clone(),
                        });
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

/// Classify a proposal's on-chain `kind` into storage-deposit targets, without
/// any network access. Bulk recipient lists are returned for later expansion.
///
/// Only these shapes register anything (everything else → none):
/// - `Transfer { token_id, receiver_id }` with a non-native token.
/// - `FunctionCall` actions `ft_transfer` / `ft_transfer_call` (with a bulk
///   special case that registers the bulk contract and expands recipients).
/// - `FunctionCall` action `mt_transfer_call` to the bulk contract when the
///   intents `token_id` is a `nep141:` asset.
fn classify_kind(kind: &serde_json::Value, bulk_contract: &AccountId) -> ClassifiedTargets {
    let mut out = ClassifiedTargets::default();

    let Ok(kind) = serde_json::from_value::<ProposalKind>(kind.clone()) else {
        return out;
    };

    // Sputnik native `Transfer` kind (the main direct-FT-payment path).
    if let Some(transfer) = kind.transfer {
        if !is_native_token(transfer.token_id.as_str()) {
            out.direct.insert(Registration {
                account_id: transfer.receiver_id,
                token_id: transfer.token_id,
            });
        }
        return out;
    }

    let Some(func_call) = kind.function_call else {
        return out;
    };

    for action in &func_call.actions {
        match action.method_name.as_str() {
            // `ft_transfer` on a token contract → register the recipient on it.
            "ft_transfer" => {
                if let Some(args) = decode_args::<FtTransferArgs>(&action.args) {
                    out.direct.insert(Registration {
                        account_id: args.receiver_id,
                        token_id: func_call.receiver_id.clone(),
                    });
                }
            }
            // `ft_transfer_call` on a token contract. To the bulk contract →
            // register the bulk contract + every NEAR recipient; otherwise →
            // register the call's receiver.
            "ft_transfer_call" => {
                let Some(args) = decode_args::<FtTransferCallArgs>(&action.args) else {
                    continue;
                };
                let token_id = func_call.receiver_id.clone();
                if args.receiver_id == *bulk_contract {
                    out.push_bulk(bulk_contract, token_id, args.msg);
                } else {
                    out.direct.insert(Registration {
                        account_id: args.receiver_id,
                        token_id,
                    });
                }
            }
            // Intents bulk payment: `mt_transfer_call` to the bulk contract on
            // `intents.near`, where the underlying token is a `nep141:` asset.
            "mt_transfer_call" => {
                let Some(args) = decode_args::<MtTransferCallArgs>(&action.args) else {
                    continue;
                };
                if args.receiver_id != *bulk_contract {
                    continue;
                }
                let Some(contract) = extract_intents_contract(&args.token_id) else {
                    continue;
                };
                let Ok(token_id) = contract.parse::<AccountId>() else {
                    continue;
                };
                out.push_bulk(bulk_contract, token_id, args.msg);
            }
            _ => {}
        }
    }

    out
}

impl ClassifiedTargets {
    /// Register the bulk payment contract on `token` and queue its recipient
    /// list (identified by `list_id`) for expansion.
    fn push_bulk(&mut self, bulk_contract: &AccountId, token: AccountId, list_id: String) {
        self.direct.insert(Registration {
            account_id: bulk_contract.clone(),
            token_id: token.clone(),
        });
        if !list_id.is_empty() {
            self.bulk_lists.push(BulkList { token, list_id });
        }
    }
}

/// Perform the required registrations concurrently, skipping already-registered
/// accounts. The targets are already deduplicated (collected into a `HashSet`).
/// Returns the number of `storage_deposit` calls actually sent (for `paid_near`
/// accounting). Errors if the per-approval cap is exceeded or a required
/// registration fails.
pub(crate) async fn execute_storage_deposits(
    state: &Arc<AppState>,
    targets: HashSet<Registration>,
) -> Result<u32, String> {
    if targets.is_empty() {
        return Ok(0);
    }
    if targets.len() > MAX_STORAGE_DEPOSITS {
        return Err(format!(
            "Too many storage_deposit registrations required ({} > {})",
            targets.len(),
            MAX_STORAGE_DEPOSITS
        ));
    }

    let futures = targets.into_iter().map(|registration| {
        let state = state.clone();
        async move { register_one(&state, &registration).await }
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
/// Retries transient send failures up to `MAX_REGISTER_ATTEMPTS` times.
async fn register_one(state: &Arc<AppState>, registration: &Registration) -> Result<bool, String> {
    let Registration {
        account_id,
        token_id,
    } = registration;

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

    let mut last_error = String::new();
    for attempt in 1..=MAX_REGISTER_ATTEMPTS {
        match send_storage_deposit(state, token_id, args.clone()).await {
            // storage_deposit is idempotent (registration_only refunds), so a
            // retry after a partially-applied send is safe.
            Ok(()) => return Ok(true),
            Err(e) => {
                last_error = e;
                log::warn!(
                    "storage_deposit attempt {}/{} failed for {} on {}: {}",
                    attempt,
                    MAX_REGISTER_ATTEMPTS,
                    account_id,
                    token_id,
                    last_error
                );
                if attempt < MAX_REGISTER_ATTEMPTS {
                    tokio::time::sleep(REGISTER_RETRY_DELAY).await;
                }
            }
        }
    }

    Err(format!(
        "storage_deposit failed for {} on {} after {} attempts: {}",
        account_id, token_id, MAX_REGISTER_ATTEMPTS, last_error
    ))
}

/// Send a single sponsor-signed `storage_deposit` transaction.
async fn send_storage_deposit(
    state: &Arc<AppState>,
    token_id: &AccountId,
    args: Vec<u8>,
) -> Result<(), String> {
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
        .map_err(|e| format!("send failed: {}", e))?
        .into_result()
        .map_err(|e| format!("execution failed: {}", e))?;
    Ok(())
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

    fn reg(account: &str, token: &str) -> Registration {
        Registration {
            account_id: acc(account),
            token_id: acc(token),
        }
    }

    fn regs(items: &[(&str, &str)]) -> HashSet<Registration> {
        items.iter().map(|(a, t)| reg(a, t)).collect()
    }

    /// Build a FunctionCall action with base64-encoded JSON args.
    fn fc_action(method: &str, args: serde_json::Value) -> serde_json::Value {
        let encoded =
            base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&args).unwrap());
        json!({ "method_name": method, "args": encoded })
    }

    fn function_call_kind(receiver: &str, actions: Vec<serde_json::Value>) -> serde_json::Value {
        json!({ "FunctionCall": { "receiver_id": receiver, "actions": actions } })
    }

    #[test]
    fn transfer_ft_registers_recipient() {
        let kind = json!({ "Transfer": { "token_id": "usdc.near", "receiver_id": "alice.near" } });
        let out = classify_kind(&kind, &bulk());
        assert_eq!(out.direct, regs(&[("alice.near", "usdc.near")]));
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
            vec![fc_action(
                "ft_transfer",
                json!({ "receiver_id": "deposit.near", "amount": "5" }),
            )],
        );
        let out = classify_kind(&kind, &bulk());
        assert_eq!(out.direct, regs(&[("deposit.near", "usdc.near")]));
        assert!(out.bulk_lists.is_empty());
    }

    #[test]
    fn near_deposit_plus_ft_transfer_only_registers_transfer_receiver() {
        // Native NEAR via intents/exchange: near_deposit is ignored, ft_transfer covers the deposit address.
        let kind = function_call_kind(
            "wrap.near",
            vec![
                fc_action("near_deposit", json!({})),
                fc_action(
                    "ft_transfer",
                    json!({ "receiver_id": "1click.near", "amount": "5" }),
                ),
            ],
        );
        let out = classify_kind(&kind, &bulk());
        assert_eq!(out.direct, regs(&[("1click.near", "wrap.near")]));
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
        assert_eq!(out.direct, regs(&[("somecontract.near", "usdc.near")]));
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
        assert_eq!(out.direct, regs(&[("bulkpayment.near", "usdc.near")]));
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
        assert_eq!(
            out.direct,
            regs(&[("bulkpayment.near", "usdt.tether-token.near")])
        );
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
    fn non_payment_kind_registers_nothing() {
        // Unmodelled proposal kinds (e.g. ChangePolicy) must classify cleanly to none.
        let kind = json!({ "ChangePolicy": { "policy": {} } });
        let out = classify_kind(&kind, &bulk());
        assert!(out.direct.is_empty());
        assert!(out.bulk_lists.is_empty());
    }

    #[test]
    fn approve_id_parsing() {
        assert_eq!(
            approve_proposal_id(&ActProposalArgs {
                id: 12,
                action: "VoteApprove".to_string()
            }),
            Some(12)
        );
        assert_eq!(
            approve_proposal_id(&ActProposalArgs {
                id: 12,
                action: "VoteReject".to_string()
            }),
            None
        );
    }

    #[test]
    fn classify_dedupes_repeated_targets() {
        // Two identical ft_transfers collapse to a single registration via the HashSet.
        let transfer = || {
            fc_action(
                "ft_transfer",
                json!({ "receiver_id": "deposit.near", "amount": "5" }),
            )
        };
        let kind = function_call_kind("usdc.near", vec![transfer(), transfer()]);
        let out = classify_kind(&kind, &bulk());
        assert_eq!(out.direct, regs(&[("deposit.near", "usdc.near")]));
    }
}
