//! WalletContract `w_execute_signed` support.
//!
//! Some wallets cannot sign a NEP-366 delegate action directly. Instead they sign
//! a `RequestMessage` and the client relays a delegate action whose sole action is
//! `w_execute_signed(msg, proof)` on the user's wallet contract. The DAO proposal
//! calls we sponsor live inside `msg.request.out`, a `PromiseDAG` of `PromiseSingle`s
//! (see `contracts/wallet`).
//!
//! This module recognizes that shape and flattens the inner promises into the same
//! [`DaoCall`]s the direct path produces; `msg.request.ops` (wallet-internal
//! operations) must be empty for a sponsorable request.

use std::ops::Deref;

use base64::Engine as _;
use near_api::{
    AccountId, NearToken,
    types::{Action, transaction::delegate_action::SignedDelegateAction},
};
use serde::Deserialize;
use serde_json::Value;

use super::proposal::DaoCall;

/// True when the relay is a WalletContract action: every top-level action of the
/// delegate action is a `w_execute_signed` function call.
pub(crate) fn is_wallet_contract_action(signed_delegate_action: &SignedDelegateAction) -> bool {
    signed_delegate_action
        .delegate_action
        .actions
        .iter()
        .map(Deref::deref)
        .all(|action| {
            matches!(
                action,
                Action::FunctionCall(fc) if fc.method_name == "w_execute_signed"
            )
        })
}

/// Flatten the `w_execute_signed` delegate action into its sponsored DAO calls.
pub(crate) fn collect_calls(
    actions: &[impl Deref<Target = Action>],
) -> Result<Vec<DaoCall>, String> {
    let mut calls = Vec::new();
    for action in actions {
        let Action::FunctionCall(fc) = action.deref() else {
            return Err("w_execute_signed relay contains a non-FunctionCall action".to_owned());
        };
        if fc.method_name != "w_execute_signed" {
            return Err(format!(
                "Unexpected method '{}' in w_execute_signed relay",
                fc.method_name
            ));
        }
        // The sponsor replays this call verbatim as predecessor, so any deposit on
        // the outer `w_execute_signed` call is paid by the sponsor. It is never
        // legitimately needed (the sponsored deposits live inside the wallet
        // promises), so reject it rather than silently spend unaccounted NEAR.
        if fc.deposit > NearToken::from_near(0) {
            return Err(format!(
                "w_execute_signed call must not attach a deposit, got {}",
                fc.deposit
            ));
        }
        collect_w_execute_args(&fc.args, &mut calls)?;
    }
    Ok(calls)
}

/// Parse one `{ msg, proof }` argument and append its sponsored DAO calls.
fn collect_w_execute_args(args: &[u8], collected_calls: &mut Vec<DaoCall>) -> Result<(), String> {
    let parsed: WExecuteSignedArgs = serde_json::from_slice(args)
        .map_err(|e| format!("Invalid w_execute_signed args: {}", e))?;
    if !parsed.msg.request.ops.is_empty() {
        return Err(
            "w_execute_signed request carries wallet ops, which are not sponsorable".to_owned(),
        );
    }
    collect_dag(&parsed.msg.request.out, collected_calls)
}

fn collect_dag(dag: &PromiseDag, collected_calls: &mut Vec<DaoCall>) -> Result<(), String> {
    for nested in &dag.after {
        collect_dag(nested, collected_calls)?;
    }
    for promise in &dag.then {
        for action in &promise.actions {
            let PromiseAction::FunctionCall {
                function_name,
                args,
                deposit,
            } = action
            else {
                return Err(
                    "w_execute_signed promise contains a non-function-call action".to_owned(),
                );
            };
            collected_calls.push(DaoCall {
                receiver_id: promise.receiver_id.clone(),
                method_name: function_name.clone(),
                args: decode_base64(args)?,
                deposit: parse_yocto_deposit(deposit)?,
            });
        }
    }
    Ok(())
}

fn decode_base64(encoded: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Invalid base64 in w_execute_signed action args: {}", e))
}

/// Wallet `FunctionCallAction.deposit` is a decimal yoctoNEAR string (omitted when zero).
fn parse_yocto_deposit(deposit: &Option<String>) -> Result<NearToken, String> {
    match deposit {
        None => Ok(NearToken::from_near(0)),
        Some(raw) => raw
            .parse::<u128>()
            .map(NearToken::from_yoctonear)
            .map_err(|e| format!("Invalid deposit '{}' in w_execute_signed action: {}", raw, e)),
    }
}

// ─── Serde views over the wallet request ────────────────────────────────────────
//
// Only the fields needed to recover the sponsored DAO calls are modelled; the rest
// of `RequestMessage` (chain id, nonce, timeout, …) and `proof` are ignored.

#[derive(Deserialize)]
struct WExecuteSignedArgs {
    msg: RequestMessage,
}

#[derive(Deserialize)]
struct RequestMessage {
    request: Request,
}

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    ops: Vec<Value>,
    #[serde(default)]
    out: PromiseDag,
}

#[derive(Deserialize, Default)]
struct PromiseDag {
    #[serde(default)]
    after: Vec<PromiseDag>,
    #[serde(default)]
    then: Vec<PromiseSingle>,
}

#[derive(Deserialize)]
struct PromiseSingle {
    receiver_id: AccountId,
    #[serde(default)]
    actions: Vec<PromiseAction>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum PromiseAction {
    FunctionCall {
        function_name: String,
        #[serde(default)]
        args: String,
        #[serde(default)]
        deposit: Option<String>,
    },
    /// Transfer / state_init / anything else — not sponsorable.
    #[serde(other)]
    Other,
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_api::{NearGas, types::transaction::actions::FunctionCallAction};
    use serde_json::json;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    /// Decode just the `out` promises of a `{ msg: { request } }` payload.
    fn collect(args: &Value) -> Result<Vec<DaoCall>, String> {
        let mut out = Vec::new();
        collect_w_execute_args(&serde_json::to_vec(args).unwrap(), &mut out)?;
        Ok(out)
    }

    /// A wrapper that `Deref`s to `Action`, so `collect_calls` can be exercised
    /// without building a `NonDelegateAction`.
    struct ActionRef(Action);
    impl std::ops::Deref for ActionRef {
        type Target = Action;
        fn deref(&self) -> &Action {
            &self.0
        }
    }

    /// A top-level `w_execute_signed` FunctionCall with the given outer deposit.
    fn w_execute_action(args: &Value, deposit: NearToken) -> ActionRef {
        ActionRef(Action::FunctionCall(Box::new(FunctionCallAction {
            method_name: "w_execute_signed".to_owned(),
            args: serde_json::to_vec(args).unwrap(),
            gas: NearGas::from_tgas(30),
            deposit,
        })))
    }

    #[test]
    fn rejects_nonzero_outer_deposit() {
        // The outer deposit is sponsor-paid; a non-zero one must be rejected before
        // the inner args are even parsed.
        let action = w_execute_action(&json!({}), NearToken::from_yoctonear(1));
        let err = collect_calls(&[action]).unwrap_err();
        assert!(err.contains("must not attach a deposit"), "{err}");
    }

    #[test]
    fn accepts_zero_outer_deposit() {
        let args = json!({
            "msg": { "request": { "out": { "then": [{
                "receiver_id": "dao.sputnik-dao.near",
                // base64("{}") — collect_calls only base64-decodes the inner args.
                "actions": [{ "action": "function_call", "function_name": "add_proposal", "args": "e30=", "deposit": "0" }]
            }] } } }
        });
        let action = w_execute_action(&args, NearToken::from_near(0));
        let calls = collect_calls(&[action]).unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].method_name, "add_proposal");
        assert_eq!(calls[0].deposit, NearToken::from_near(0));
    }

    #[test]
    fn flattens_golden_payload() {
        // Inner add_proposal args (base64-decodes to a Transfer proposal).
        let inner = "eyJwcm9wb3NhbCI6eyJkZXNjcmlwdGlvbiI6IiIsImtpbmQiOnsiVHJhbnNmZXIiOnsidG9rZW5faWQiOiIiLCJyZWNlaXZlcl9pZCI6Im1lZ2hhMTkubmVhciIsImFtb3VudCI6IjEwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJtc2ciOm51bGx9fX19";
        let args = json!({
            "msg": { "request": { "ops": [], "out": { "after": [], "then": [{
                "receiver_id": "testing-astradao.sputnik-dao.near",
                "actions": [{
                    "action": "function_call",
                    "function_name": "add_proposal",
                    "args": inner,
                    "deposit": "0"
                }]
            }] } } },
            "proof": "ignored"
        });
        let calls = collect(&args).unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].receiver_id, acc("testing-astradao.sputnik-dao.near"));
        assert_eq!(calls[0].method_name, "add_proposal");
        assert_eq!(calls[0].deposit, NearToken::from_near(0));
    }

    #[test]
    fn rejects_wallet_ops() {
        let args = json!({
            "msg": { "request": { "ops": [{ "op": "set_signature_mode", "enable": true }], "out": {} } }
        });
        assert!(collect(&args).unwrap_err().contains("wallet ops"));
    }

    #[test]
    fn rejects_non_function_call_promise() {
        let args = json!({
            "msg": { "request": { "out": { "then": [{
                "receiver_id": "dao.sputnik-dao.near",
                "actions": [{ "action": "transfer", "amount": "1" }]
            }] } } }
        });
        assert!(collect(&args).unwrap_err().contains("non-function-call"));
    }
}
