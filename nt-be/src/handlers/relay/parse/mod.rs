//! The relay request — its wire types, the typed view over a Sputnik DAO proposal
//! `kind`, and the parser that recovers the sponsored operation from a delegate
//! action.
//!
//! Two wire shapes carry the same intent:
//!
//! 1. **Direct NEP-366 meta-transaction** — the delegate action's inner
//!    `FunctionCall` actions call `add_proposal`/`act_proposal` on the
//!    `*.sputnik-dao.near` treasury directly.
//! 2. **`w_execute_signed` on a WalletContract** — the same calls live inside the
//!    wallet request; see [`wallet_contract`].
//!
//! A single relay is homogeneous: all `add_proposal` or all `act_proposal`. Mixing
//! the two is rejected, and anything that is not an `add_proposal`/`act_proposal`
//! targeting the treasury is rejected too. (NEP-141 storage registrations are
//! derived and paid by the backend separately; they are never relayed as actions.)

mod wallet_contract;

use std::ops::Deref;

use axum::{Json, http::StatusCode};
use near_api::{
    AccountId, NearToken,
    types::{
        Action,
        json::{Base64VecU8, U128},
        transaction::delegate_action::{NonDelegateAction, SignedDelegateAction},
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::handlers::relay::confidential::extract_v1_signer_hash_from_kind;

// ─── Request / response DTOs ─────────────────────────────────────────────────────

/// Error returned by relay handlers: an HTTP status plus a JSON body.
pub type RelayError = (StatusCode, Json<RelayResponse>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayRequest {
    pub treasury_id: AccountId,
    /// Estimated bytes of DAO-contract storage a new `add_proposal` occupies. The
    /// relayer tops up the DAO's balance to cover it. Unrelated to NEP-141
    /// `storage_deposit` registrations.
    pub storage_bytes: U128,
    /// Base64-encoded borsh-serialized SignedDelegateAction.
    pub signed_delegate_action: Base64VecU8,
    /// Optional proposal type hint for metrics. Only set on the actual proposal call,
    /// NOT on helper calls like storage_deposit.
    /// "swap" → swap_proposals, "payment" → payment_proposals, "vote" → votes_casted,
    /// "confidential_transfer" and others → other_proposals_submitted.
    /// Absent/null → no metric recorded.
    #[serde(default)]
    pub proposal_type: Option<String>,
    /// True when a payment proposal recipient was selected from address book.
    /// Only set on the actual proposal call.
    #[serde(default)]
    pub address_book_payment: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Build an error response from a status and message.
pub fn error_response(status: StatusCode, msg: impl Into<String>) -> RelayError {
    (
        status,
        Json(RelayResponse {
            success: false,
            error: Some(msg.into()),
        }),
    )
}

/// The success body (`{ "success": true }`).
pub fn success_response() -> Json<RelayResponse> {
    Json(RelayResponse {
        success: true,
        error: None,
    })
}

// ─── Sputnik DAO proposal `kind` (typed, lenient) ────────────────────────────────
//
// A `kind` is externally tagged (`{"Transfer": {...}}` / `{"FunctionCall": {...}}`)
// and may use shapes we don't model (governance kinds) or sentinels we can't parse
// (native NEAR `token_id: ""`). Parsing is lenient: an unknown or invalid kind yields
// an empty `ProposalKind`, never an error — so a proposal is never rejected for a
// kind we don't introspect, and native-NEAR transfers simply imply no registration.

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ProposalKind {
    #[serde(rename = "Transfer")]
    pub(crate) transfer: Option<TransferKind>,
    #[serde(rename = "FunctionCall")]
    pub(crate) function_call: Option<FunctionCallKind>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TransferKind {
    // Native NEAR uses the sentinel token_id "", which is not a valid AccountId;
    // such transfers fail to deserialize and yield no registration (correct —
    // native NEAR needs none).
    pub(crate) token_id: AccountId,
    pub(crate) receiver_id: AccountId,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FunctionCallKind {
    pub(crate) receiver_id: AccountId,
    #[serde(default)]
    pub(crate) actions: Vec<ProposalFunctionCall>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ProposalFunctionCall {
    pub(crate) method_name: String,
    /// Base64-encoded JSON args.
    #[serde(default)]
    pub(crate) args: String,
}

impl ProposalKind {
    /// Parse a raw `kind` value leniently: unknown or invalid kinds yield an empty
    /// `ProposalKind` rather than an error.
    pub(crate) fn from_value(kind: &Value) -> Self {
        serde_json::from_value(kind.clone()).unwrap_or_default()
    }
}

// ─── Parsed relay operation ──────────────────────────────────────────────────────

/// The sponsored operation of a single relay. Homogeneous by construction.
#[derive(Debug, Clone, PartialEq)]
pub enum RelayOperation {
    /// One or more `add_proposal` calls.
    AddProposals(Vec<ProposalInput>),
    /// One or more `act_proposal` (vote) calls.
    Votes(Vec<ActProposal>),
}

/// The on-chain transaction the sponsor will submit — and, by construction, all that
/// survives parsing of the raw delegate action. There is no way to reach back to the
/// pre-validation form.
#[derive(Debug)]
pub enum RelaySubmission {
    /// WalletContract `w_execute_signed`: the sponsor replays these prepared actions
    /// (deposits already set to the bounded bond) to the user's wallet contract.
    WalletContract(WalletReplay),
    /// NEP-366 meta-transaction: the sponsor wraps and relays the original signed
    /// delegate action.
    MetaTransaction(SignedDelegateAction),
}

/// The sponsor-prepared replay of a `w_execute_signed` relay.
#[derive(Debug)]
pub struct WalletReplay {
    /// The user's wallet contract (the delegate action's receiver).
    pub wallet_account: AccountId,
    /// Outer `w_execute_signed` actions, with each deposit overridden to the
    /// sponsored inner bond (see [`wallet_contract::build_sponsored_actions`]).
    pub actions: Vec<Action>,
}

/// The result of parsing a relayed delegate action.
#[derive(Debug)]
pub struct ParsedRelay {
    pub treasury_id: AccountId,
    pub submission: RelaySubmission,
    pub operation: RelayOperation,
    /// Total NEAR attached across the sponsored calls (proposal bonds).
    pub attached_deposit: NearToken,
}

/// The `proposal` argument of `add_proposal`. `kind` is kept as raw JSON because the
/// relay does not authorize on it — DAO permissions are enforced on-chain and via
/// the permission checks in [`super::access`].
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ProposalInput {
    #[serde(default)]
    pub description: String,
    pub kind: Value,
}

/// The arguments of `act_proposal`.
#[derive(Debug, Clone, PartialEq)]
pub struct ActProposal {
    pub id: u64,
    pub action: String,
    /// Client-provided proposal `kind` echoed in the `act_proposal` args. Used only
    /// to surface confidential payload hashes, never for authorization.
    pub kind: Option<Value>,
}

impl RelayOperation {
    /// Whether this relay adds proposals. Only `add_proposal` grows the DAO
    /// contract's storage, so only then does the relayer top up its balance.
    pub fn is_add_proposals(&self) -> bool {
        matches!(self, RelayOperation::AddProposals(_))
    }

    /// Proposal ids being approved (`VoteApprove`), in order. Empty for add relays.
    pub fn vote_approve_ids(&self) -> Vec<u64> {
        match self {
            RelayOperation::Votes(votes) => votes
                .iter()
                .filter(|vote| vote.action == "VoteApprove")
                .map(|vote| vote.id)
                .collect(),
            RelayOperation::AddProposals(_) => Vec::new(),
        }
    }

    /// Confidential `v1.signer` payload hashes referenced by the votes, in order. A
    /// single relay can carry several (e.g. multiple confidential votes). Empty for
    /// add relays.
    pub fn confidential_payload_hashes(&self) -> Vec<String> {
        match self {
            RelayOperation::Votes(votes) => votes
                .iter()
                .filter_map(|vote| {
                    vote.kind
                        .as_ref()
                        .and_then(extract_v1_signer_hash_from_kind)
                })
                .collect(),
            RelayOperation::AddProposals(_) => Vec::new(),
        }
    }

    /// Like [`confidential_payload_hashes`](Self::confidential_payload_hashes) but
    /// pairs each hash with the on-chain proposal id being voted on. The proposal
    /// id lets the auto-submit path link and arm bulk-payment headers once the
    /// vote lands. Empty for add relays.
    pub fn confidential_payloads_with_ids(&self) -> Vec<(String, u64)> {
        match self {
            RelayOperation::Votes(votes) => votes
                .iter()
                .filter_map(|vote| {
                    vote.kind
                        .as_ref()
                        .and_then(extract_v1_signer_hash_from_kind)
                        .map(|hash| (hash, vote.id))
                })
                .collect(),
            RelayOperation::AddProposals(_) => Vec::new(),
        }
    }
}

/// Consume the treasury id and a relayed delegate action into the operation to
/// sponsor and the on-chain submission ([`RelaySubmission`]), rejecting anything that
/// is not a homogeneous set of `add_proposal`/`act_proposal` calls targeting the
/// treasury.
///
/// Consuming the inputs means the caller cannot reach back to the raw,
/// pre-validation form: a `w_execute_signed` relay keeps only its sponsor-prepared
/// replay actions, while a meta-transaction keeps the original action to wrap.
pub fn parse_sponsored_proposals(
    treasury_id: AccountId,
    signed_delegate_action: SignedDelegateAction,
) -> Result<ParsedRelay, String> {
    let delegate_action = &signed_delegate_action.delegate_action;
    let (submission, calls) = if is_wallet_contract_shape(&delegate_action.actions) {
        let calls = wallet_contract::collect_calls(&delegate_action.actions)?;
        let replay = WalletReplay {
            actions: wallet_contract::build_sponsored_actions(&delegate_action.actions)?,
            wallet_account: delegate_action.receiver_id.clone(),
        };
        (RelaySubmission::WalletContract(replay), calls)
    } else {
        let calls = collect_direct_calls(&delegate_action.receiver_id, &delegate_action.actions)?;
        (
            RelaySubmission::MetaTransaction(signed_delegate_action),
            calls,
        )
    };
    let (operation, attached_deposit) = validate_calls(&treasury_id, calls)?;
    Ok(ParsedRelay {
        treasury_id,
        submission,
        operation,
        attached_deposit,
    })
}

/// A relay is WalletContract-shaped when its actions call `w_execute_signed`. We peek
/// the first action to route; [`wallet_contract::collect_calls`] then validates
/// every action (via `as_w_execute_call`), rejecting a mixed delegate action.
fn is_wallet_contract_shape(actions: &[NonDelegateAction]) -> bool {
    matches!(
        actions.first().map(Deref::deref),
        Some(Action::FunctionCall(fc)) if fc.method_name == "w_execute_signed"
    )
}

/// A single contract call extracted from either wire shape, normalized so the two
/// flows validate identically.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DaoCall {
    pub(crate) receiver_id: AccountId,
    pub(crate) method_name: String,
    /// Raw JSON argument bytes.
    pub(crate) args: Vec<u8>,
    pub(crate) deposit: NearToken,
}

/// Direct meta-transaction: every inner action must be a `FunctionCall`. They all
/// share the delegate action's single `receiver_id`, which [`validate_calls`] then
/// pins to the treasury.
fn collect_direct_calls(
    receiver_id: &AccountId,
    actions: &[NonDelegateAction],
) -> Result<Vec<DaoCall>, String> {
    actions
        .iter()
        .map(|action| match action.deref() {
            Action::FunctionCall(fc) => Ok(DaoCall {
                receiver_id: receiver_id.clone(),
                method_name: fc.method_name.clone(),
                args: fc.args.clone(),
                deposit: fc.deposit,
            }),
            _ => Err("Delegate action contains a non-FunctionCall action".to_owned()),
        })
        .collect()
}

/// Validate the normalized calls: each must target the treasury and be an
/// `add_proposal`/`act_proposal`, and the relay must be homogeneous (all of one
/// kind). Returns the sponsored operation plus the total attached deposit.
fn validate_calls(
    treasury_id: &AccountId,
    calls: Vec<DaoCall>,
) -> Result<(RelayOperation, NearToken), String> {
    if calls.is_empty() {
        return Err("Delegate action contains no sponsorable proposal calls".to_owned());
    }

    let mut add_proposals = Vec::new();
    let mut votes = Vec::new();
    let mut attached_deposit = NearToken::from_near(0);
    for call in calls {
        if &call.receiver_id != treasury_id {
            return Err(format!(
                "Proposal call targets '{}', but only the treasury '{}' may be sponsored",
                call.receiver_id, treasury_id
            ));
        }
        attached_deposit = attached_deposit.saturating_add(call.deposit);
        match call.method_name.as_str() {
            "add_proposal" => add_proposals.push(parse_add_proposal(&call)?),
            "act_proposal" => votes.push(parse_act_proposal(&call)?),
            other => {
                return Err(format!(
                    "Unsupported relayed method '{}' (only add_proposal/act_proposal are sponsored)",
                    other
                ));
            }
        }
    }

    let operation = match (add_proposals.is_empty(), votes.is_empty()) {
        (false, true) => RelayOperation::AddProposals(add_proposals),
        (true, false) => RelayOperation::Votes(votes),
        // Both non-empty: a mix. (Both empty is impossible — calls is non-empty and
        // every call is one kind or the other.)
        _ => {
            return Err(
                "A relay must contain only add_proposal or only act_proposal calls, not a mix"
                    .to_owned(),
            );
        }
    };

    Ok((operation, attached_deposit))
}

fn parse_add_proposal(call: &DaoCall) -> Result<ProposalInput, String> {
    let args: AddProposalArgs = serde_json::from_slice(&call.args)
        .map_err(|e| format!("Invalid add_proposal args: {}", e))?;
    Ok(args.proposal)
}

fn parse_act_proposal(call: &DaoCall) -> Result<ActProposal, String> {
    let args: ActProposalArgs = serde_json::from_slice(&call.args)
        .map_err(|e| format!("Invalid act_proposal args: {}", e))?;
    Ok(ActProposal {
        id: args.id,
        action: args.action,
        kind: args.proposal,
    })
}

#[derive(Deserialize)]
struct AddProposalArgs {
    proposal: ProposalInput,
}

#[derive(Deserialize)]
struct ActProposalArgs {
    id: u64,
    action: String,
    #[serde(default)]
    proposal: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TREASURY: &str = "dao.sputnik-dao.near";

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn b64(value: &Value) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(value).unwrap())
    }

    fn add_call(treasury: &str, kind: Value, deposit_yocto: u128) -> DaoCall {
        DaoCall {
            receiver_id: acc(treasury),
            method_name: "add_proposal".to_owned(),
            args: serde_json::to_vec(&json!({
                "proposal": { "description": "d", "kind": kind }
            }))
            .unwrap(),
            deposit: NearToken::from_yoctonear(deposit_yocto),
        }
    }

    fn act_call(treasury: &str, id: u64, action: &str, kind: Option<Value>) -> DaoCall {
        let mut args = json!({ "id": id, "action": action });
        if let Some(kind) = kind {
            args["proposal"] = kind;
        }
        DaoCall {
            receiver_id: acc(treasury),
            method_name: "act_proposal".to_owned(),
            args: serde_json::to_vec(&args).unwrap(),
            deposit: NearToken::from_near(0),
        }
    }

    fn transfer_kind() -> Value {
        json!({ "Transfer": { "token_id": "", "receiver_id": "bob.near", "amount": "1" } })
    }

    #[test]
    fn validates_add_proposals_and_sums_deposit() {
        let (operation, attached_deposit) = validate_calls(
            &acc(TREASURY),
            vec![add_call(TREASURY, transfer_kind(), 100)],
        )
        .unwrap();
        match operation {
            RelayOperation::AddProposals(ref inputs) => assert_eq!(inputs.len(), 1),
            other => panic!("expected AddProposals, got {other:?}"),
        }
        assert_eq!(attached_deposit, NearToken::from_yoctonear(100));
    }

    #[test]
    fn extracts_vote_approve_ids() {
        let calls = vec![
            act_call(TREASURY, 7, "VoteApprove", None),
            act_call(TREASURY, 8, "VoteReject", None),
            act_call(TREASURY, 9, "VoteApprove", None),
        ];
        let (operation, _) = validate_calls(&acc(TREASURY), calls).unwrap();
        assert_eq!(operation.vote_approve_ids(), vec![7, 9]);
    }

    #[test]
    fn extracts_multiple_confidential_hashes() {
        let v1_kind = |hash: &str| {
            json!({
                "FunctionCall": {
                    "receiver_id": "v1.signer",
                    "actions": [{
                        "method_name": "sign",
                        "args": b64(&json!({ "request": { "payload_v2": { "Eddsa": hash } } })),
                    }]
                }
            })
        };
        let calls = vec![
            act_call(TREASURY, 1, "VoteApprove", Some(v1_kind("aaaa"))),
            act_call(TREASURY, 2, "VoteApprove", Some(v1_kind("bbbb"))),
        ];
        let (operation, _) = validate_calls(&acc(TREASURY), calls).unwrap();
        assert_eq!(
            operation.confidential_payload_hashes(),
            vec!["aaaa".to_owned(), "bbbb".to_owned()]
        );
    }

    #[test]
    fn rejects_mixed_add_and_act() {
        let calls = vec![
            add_call(TREASURY, transfer_kind(), 0),
            act_call(TREASURY, 1, "VoteApprove", None),
        ];
        let err = validate_calls(&acc(TREASURY), calls).unwrap_err();
        assert!(
            err.contains("only add_proposal or only act_proposal"),
            "{err}"
        );
    }

    #[test]
    fn rejects_non_proposal_method() {
        let call = DaoCall {
            receiver_id: acc(TREASURY),
            method_name: "storage_deposit".to_owned(),
            args: b"{}".to_vec(),
            deposit: NearToken::from_near(0),
        };
        let err = validate_calls(&acc(TREASURY), vec![call]).unwrap_err();
        assert!(err.contains("Unsupported relayed method"), "{err}");
    }

    #[test]
    fn rejects_call_to_other_receiver() {
        let err = validate_calls(
            &acc(TREASURY),
            vec![add_call("evil.near", transfer_kind(), 0)],
        )
        .unwrap_err();
        assert!(err.contains("only the treasury"), "{err}");
    }
}
