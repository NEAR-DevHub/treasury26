//! The relayer's signing identity and the sponsor-signed transactions it sends.
//!
//! Every method centralizes retry policy by idempotency class, so retry-safety is a
//! property of the method you call rather than something each call site re-decides:
//!
//! - [`Sponsor::call_idempotent`], [`Sponsor::relay_meta_tx`], [`Sponsor::replay_actions`]
//!   are safe to retry — registrations refund, and meta / `w_execute_signed`
//!   transactions carry on-chain nonces that reject a replay that already landed.
//! - [`Sponsor::transfer_once`] is a bare value transfer with no replay protection,
//!   so it is never retried after broadcast.

pub mod policy;
pub mod retry;

use std::{fmt::Display, future::Future, sync::Arc};

use near_api::{
    AccountId, NearGas, NearToken, NetworkConfig, Signer, Tokens, Transaction,
    types::{
        Action,
        transaction::{actions::FunctionCallAction, delegate_action::SignedDelegateAction},
    },
};

use crate::AppState;

use self::retry::{RetryPolicy, retry};

/// The debug string of a transaction's execution outcome, mined later for MPC
/// signatures by `confidential`.
pub type OutcomeDebug = String;

#[derive(Clone)]
pub struct Sponsor {
    signer_id: AccountId,
    signer: Arc<Signer>,
    network: NetworkConfig,
}

impl Sponsor {
    pub fn from_state(state: &AppState) -> Self {
        Self {
            signer_id: state.signer_id.clone(),
            signer: state.signer.clone(),
            network: state.network.clone(),
        }
    }

    /// Send an idempotent function call (e.g. `storage_deposit` with
    /// `registration_only`), retrying transient send failures.
    pub async fn call_idempotent(
        &self,
        receiver: &AccountId,
        method_name: &str,
        args: Vec<u8>,
        gas: NearGas,
        deposit: NearToken,
    ) -> Result<(), String> {
        let outcome = self
            .send_retried("function call", || async {
                Transaction::construct(self.signer_id.clone(), receiver.clone())
                    .add_action(Action::FunctionCall(Box::new(FunctionCallAction {
                        method_name: method_name.to_owned(),
                        args: args.clone(),
                        gas,
                        deposit,
                    })))
                    .with_signer(self.signer.clone())
                    .send_to(&self.network)
                    .await
            })
            .await?;
        outcome
            .into_result()
            .map_err(|e| format!("execution failed: {}", e))?;
        Ok(())
    }

    /// Relay a NEP-366 meta-transaction: wrap the signed delegate action and send it
    /// to its `sender_id`. Safe to retry — the delegate nonce rejects a double-land.
    pub async fn relay_meta_tx(
        &self,
        signed: SignedDelegateAction,
    ) -> Result<OutcomeDebug, String> {
        let outer_receiver = signed.delegate_action.sender_id.clone();
        let outcome = self
            .send_retried("relay meta-tx", || async {
                Transaction::construct(self.signer_id.clone(), outer_receiver.clone())
                    .add_action(Action::Delegate(Box::new(signed.clone())))
                    .with_signer(self.signer.clone())
                    .send_to(&self.network)
                    .await
            })
            .await
            .map_err(|e| format!("Failed to relay: {}", e))?;
        let debug = format!("{:?}", outcome);
        outcome
            .into_result()
            .map_err(|e| format!("Execution failed: {}", e))?;
        Ok(debug)
    }

    /// Replay the sponsor's prepared actions directly to the user's wallet contract.
    /// Safe to retry — the wallet request nonce rejects a double-land.
    pub async fn replay_actions(
        &self,
        receiver: &AccountId,
        actions: Vec<Action>,
    ) -> Result<OutcomeDebug, String> {
        let outcome = self
            .send_retried("replay w_execute_signed", || async {
                let mut transaction =
                    Transaction::construct(self.signer_id.clone(), receiver.clone());
                for action in &actions {
                    transaction = transaction.add_action(action.clone());
                }
                transaction
                    .with_signer(self.signer.clone())
                    .send_to(&self.network)
                    .await
            })
            .await
            .map_err(|e| format!("Failed to relay: {}", e))?;
        let debug = format!("{:?}", outcome);
        outcome
            .into_result()
            .map_err(|e| format!("Execution failed: {}", e))?;
        Ok(debug)
    }

    /// Transfer NEAR to `receiver`. NOT retried after broadcast: a bare transfer has
    /// no replay protection, so a re-send that already landed would double-pay.
    pub async fn transfer_once(
        &self,
        receiver: &AccountId,
        amount: NearToken,
    ) -> Result<(), String> {
        Tokens::account(self.signer_id.clone())
            .send_to(receiver.clone())
            .near(amount)
            .with_signer(self.signer.clone())
            .send_to(&self.network)
            .await
            .map_err(|e| e.to_string())?
            .into_result()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Retry a send-producing future under the RPC policy, stringifying the error.
    async fn send_retried<O, E, Fut>(
        &self,
        label: &str,
        send: impl FnMut() -> Fut,
    ) -> Result<O, String>
    where
        Fut: Future<Output = Result<O, E>>,
        E: Display,
    {
        retry(RetryPolicy::rpc(), label, send)
            .await
            .map_err(|e| e.to_string())
    }
}
