use std::sync::Arc;

use axum::{Json, extract::State, http::StatusCode};
use near_account_id::AccountType;
use near_api::{
    Account, AccountId, NearToken, PublicKey, Tokens, Transaction,
    types::transaction::actions::{
        Action, DeterministicAccountStateInit, DeterministicStateInitAction,
    },
};
use serde::{Deserialize, Serialize};

use crate::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserRequest {
    pub account_id: AccountId,
    /// Required for `NamedAccount` creation. Ignored for implicit and
    /// deterministic accounts.
    #[serde(default)]
    pub public_key: Option<PublicKey>,
    /// State-init payload for `NearDeterministicAccount` creation (NEP-616).
    /// Required when `account_id` is a deterministic (`0s...`) account.
    /// Versioned global-contract code reference plus the initial trie state.
    /// Reuses the near-api wire format: `{ "V1": { "code": ..., "data": ... } }`
    /// where `data` is a base64-keyed/base64-valued map.
    #[serde(default)]
    pub state_init: Option<DeterministicAccountStateInit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserResponse {
    pub account_id: AccountId,
    pub created: bool,
}

pub async fn create_user_account(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateUserRequest>,
) -> Result<Json<CreateUserResponse>, (StatusCode, String)> {
    let account_id = payload.account_id.clone();

    // Only allow creation for accounts that do not exist yet.
    match Account(account_id.clone())
        .view()
        .fetch_from(&state.network)
        .await
    {
        Ok(_) => {
            return Err((
                StatusCode::CONFLICT,
                format!("Account {} already exists", account_id),
            ));
        }
        Err(e) => {
            if !e.to_string().contains("UnknownAccount") {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to check account existence: {}", e),
                ));
            }
        }
    }

    match account_id.get_account_type() {
        AccountType::NamedAccount => {
            let public_key = payload.public_key.ok_or((
                StatusCode::BAD_REQUEST,
                "Missing public key for named account creation".to_string(),
            ))?;
            Account::create_account(account_id.clone())
                // Account creation requires Transfer action, but it allows 0 deposit.
                .fund_myself(state.signer_id.clone(), NearToken::from_yoctonear(0))
                .with_public_key(public_key)
                .with_signer(state.signer.clone())
                .send_to(&state.network)
                .await
                .map_err(|e| {
                    eprintln!("Error creating user account {}: {}", account_id, e);
                    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
                })?
                .into_result()
                .map_err(|e| {
                    eprintln!("Error creating user account {}: {}", account_id, e);
                    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
                })?;
        }
        AccountType::NearImplicitAccount => {
            Tokens::account(state.signer_id.clone())
                .send_to(account_id.clone())
                // Account creation requires Transfer action, but it allows 0 deposit.
                .near(NearToken::from_yoctonear(0))
                .with_signer(state.signer.clone())
                .send_to(&state.network)
                .await
                .map_err(|e| {
                    eprintln!(
                        "Error sending near to implicit account {}: {}",
                        account_id, e
                    );
                    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
                })?
                .into_result()
                .map_err(|e| {
                    eprintln!(
                        "Error sending near to implicit account {}: {}",
                        account_id, e
                    );
                    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
                })?;
        }
        AccountType::NearDeterministicAccount => {
            let state_init = payload.state_init.ok_or((
                StatusCode::BAD_REQUEST,
                "Missing state-init args for deterministic account creation".to_string(),
            ))?;

            let action = Action::DeterministicStateInit(Box::new(DeterministicStateInitAction {
                state_init,
                deposit: NearToken::from_near(0),
            }));

            // The deterministic account id (`0s...`) is the transaction receiver;
            // the protocol verifies it matches the hash of the state-init.
            Transaction::construct(state.signer_id.clone(), account_id.clone())
                .add_action(action)
                .with_signer(state.signer.clone())
                .send_to(&state.network)
                .await
                .map_err(|e| {
                    eprintln!("Error creating deterministic account {}: {}", account_id, e);
                    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
                })?
                .into_result()
                .map_err(|e| {
                    eprintln!("Error creating deterministic account {}: {}", account_id, e);
                    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
                })?;
        }
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                format!(
                    "Unsupported account type: {:?}",
                    account_id.get_account_type()
                ),
            ));
        }
    }

    let details = format!("Ledger user account created: {account_id}",);
    if let Err(e) = state.telegram_client.send_message(&details).await {
        log::warn!("Failed to send Telegram notification: {}", e);
    }

    Ok(Json(CreateUserResponse {
        account_id,
        created: true,
    }))
}
