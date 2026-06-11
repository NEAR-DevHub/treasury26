//! The Sputnik DAO proposal operations the relay is willing to sponsor, and the
//! parser that recovers them from a relayed delegate action.
//!
//! Two wire shapes carry the same intent and flatten to the same
//! `Vec<ProposalRequest>`:
//!
//! 1. **Direct NEP-366 meta-transaction** — the delegate action's inner
//!    `FunctionCall` actions call `add_proposal`/`act_proposal` on the
//!    `*.sputnik-dao.near` treasury directly.
//! 2. **`w_execute_signed` on a WalletContract** — the same calls live inside the
//!    wallet request; see [`super::wallet`].
//!
//! Anything that is not an `add_proposal`/`act_proposal` targeting the treasury is
//! rejected: the relay only sponsors DAO proposals. (Storage registrations are
//! derived and paid by the backend separately; they are never relayed as actions.)

use std::ops::Deref;

use near_api::{
    AccountId, NearToken,
    types::{Action, transaction::delegate_action::NonDelegateAction},
};
use serde::Deserialize;
use serde_json::Value;

use super::confidential::extract_v1_signer_hash_from_kind;

/// A Sputnik DAO proposal operation the relay can sponsor.
#[derive(Debug, Clone, PartialEq)]
pub enum ProposalRequest {
    /// `add_proposal { proposal }`.
    Add(ProposalInput),
    /// `act_proposal { id, action, proposal? }`.
    Act(ActProposal),
}

/// The `proposal` argument of `add_proposal`. `kind` is kept as raw JSON because
/// the relay does not authorize on it — DAO permissions are enforced on-chain and
/// via [`super::access::verify_relay_access`].
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

/// The result of flattening a relayed delegate action.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedRelay {
    pub proposals: Vec<ProposalRequest>,
    /// Total NEAR attached across the sponsored proposal calls (proposal bonds).
    pub attached_deposit: NearToken,
}

impl ProposalRequest {
    /// The proposal id when this is an approving vote (`VoteApprove`).
    fn vote_approve_id(&self) -> Option<u64> {
        match self {
            ProposalRequest::Act(act) if act.action == "VoteApprove" => Some(act.id),
            _ => None,
        }
    }

    /// The confidential `payload_v2.Eddsa` hash, when this operation references a
    /// `v1.signer` proposal kind.
    fn confidential_payload_hash(&self) -> Option<String> {
        match self {
            ProposalRequest::Act(act) => {
                act.kind.as_ref().and_then(extract_v1_signer_hash_from_kind)
            }
            ProposalRequest::Add(_) => None,
        }
    }
}

/// Whether this relay adds a proposal. Only `add_proposal` grows the DAO contract's
/// storage, so only then does the relayer top up its balance.
pub fn contains_add_proposal(proposals: &[ProposalRequest]) -> bool {
    proposals
        .iter()
        .any(|proposal| matches!(proposal, ProposalRequest::Add(_)))
}

/// Proposal ids being approved (`VoteApprove`) in this relay, in order.
pub fn vote_approve_proposal_ids(proposals: &[ProposalRequest]) -> Vec<u64> {
    proposals
        .iter()
        .filter_map(ProposalRequest::vote_approve_id)
        .collect()
}

/// All confidential `v1.signer` payload hashes referenced by this relay, in order.
/// A single relay can carry several (e.g. multiple confidential votes).
pub fn confidential_payload_hashes(proposals: &[ProposalRequest]) -> Vec<String> {
    proposals
        .iter()
        .filter_map(ProposalRequest::confidential_payload_hash)
        .collect()
}

/// Parse a relayed delegate action into the proposal operations to sponsor,
/// rejecting anything that is not an `add_proposal`/`act_proposal` targeting
/// `treasury_id`.
///
/// `action_receiver_id` is the delegate action's receiver — the contract the inner
/// actions call in the direct shape. For `w_execute_signed` the receiver is read
/// from each inner promise instead, so this argument is ignored there.
pub fn parse_sponsored_proposals(
    treasury_id: &AccountId,
    is_wallet_contract_action: bool,
    action_receiver_id: &AccountId,
    actions: &[NonDelegateAction],
) -> Result<ParsedRelay, String> {
    let calls = if is_wallet_contract_action {
        super::wallet::collect_calls(actions)?
    } else {
        collect_direct_calls(action_receiver_id, actions)?
    };
    validate_calls(treasury_id, calls)
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

/// Validate the normalized calls and map them to proposal operations.
fn validate_calls(treasury_id: &AccountId, calls: Vec<DaoCall>) -> Result<ParsedRelay, String> {
    if calls.is_empty() {
        return Err("Delegate action contains no sponsorable proposal calls".to_owned());
    }

    let mut proposals = Vec::with_capacity(calls.len());
    let mut attached_deposit = NearToken::from_near(0);
    for call in calls {
        if &call.receiver_id != treasury_id {
            return Err(format!(
                "Proposal call targets '{}', but only the treasury '{}' may be sponsored",
                call.receiver_id, treasury_id
            ));
        }
        attached_deposit = attached_deposit.saturating_add(call.deposit);
        proposals.push(parse_call(&call)?);
    }

    Ok(ParsedRelay {
        proposals,
        attached_deposit,
    })
}

fn parse_call(call: &DaoCall) -> Result<ProposalRequest, String> {
    match call.method_name.as_str() {
        "add_proposal" => {
            let args: AddProposalArgs = serde_json::from_slice(&call.args)
                .map_err(|e| format!("Invalid add_proposal args: {}", e))?;
            Ok(ProposalRequest::Add(args.proposal))
        }
        "act_proposal" => {
            let args: ActProposalArgs = serde_json::from_slice(&call.args)
                .map_err(|e| format!("Invalid act_proposal args: {}", e))?;
            Ok(ProposalRequest::Act(ActProposal {
                id: args.id,
                action: args.action,
                kind: args.proposal,
            }))
        }
        other => Err(format!(
            "Unsupported relayed method '{}' (only add_proposal/act_proposal are sponsored)",
            other
        )),
    }
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

    #[test]
    fn validates_add_proposal_and_sums_deposit() {
        let kind = json!({ "Transfer": { "token_id": "", "receiver_id": "bob.near", "amount": "1" } });
        let parsed = validate_calls(
            &acc("dao.sputnik-dao.near"),
            vec![add_call("dao.sputnik-dao.near", kind, 100)],
        )
        .unwrap();
        assert_eq!(parsed.proposals.len(), 1);
        assert!(matches!(parsed.proposals[0], ProposalRequest::Add(_)));
        assert_eq!(parsed.attached_deposit, NearToken::from_yoctonear(100));
    }

    #[test]
    fn extracts_vote_approve_ids() {
        let calls = vec![
            act_call("dao.sputnik-dao.near", 7, "VoteApprove", None),
            act_call("dao.sputnik-dao.near", 8, "VoteReject", None),
            act_call("dao.sputnik-dao.near", 9, "VoteApprove", None),
        ];
        let parsed = validate_calls(&acc("dao.sputnik-dao.near"), calls).unwrap();
        assert_eq!(vote_approve_proposal_ids(&parsed.proposals), vec![7, 9]);
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
            act_call("dao.sputnik-dao.near", 1, "VoteApprove", Some(v1_kind("aaaa"))),
            act_call("dao.sputnik-dao.near", 2, "VoteApprove", Some(v1_kind("bbbb"))),
        ];
        let parsed = validate_calls(&acc("dao.sputnik-dao.near"), calls).unwrap();
        assert_eq!(
            confidential_payload_hashes(&parsed.proposals),
            vec!["aaaa".to_owned(), "bbbb".to_owned()]
        );
    }

    #[test]
    fn rejects_non_proposal_method() {
        let call = DaoCall {
            receiver_id: acc("dao.sputnik-dao.near"),
            method_name: "storage_deposit".to_owned(),
            args: b"{}".to_vec(),
            deposit: NearToken::from_near(0),
        };
        let err = validate_calls(&acc("dao.sputnik-dao.near"), vec![call]).unwrap_err();
        assert!(err.contains("Unsupported relayed method"), "{err}");
    }

    #[test]
    fn rejects_call_to_other_receiver() {
        let kind = json!({ "Transfer": { "token_id": "", "receiver_id": "bob.near", "amount": "1" } });
        let err = validate_calls(
            &acc("dao.sputnik-dao.near"),
            vec![add_call("evil.near", kind, 0)],
        )
        .unwrap_err();
        assert!(err.contains("only the treasury"), "{err}");
    }
}
