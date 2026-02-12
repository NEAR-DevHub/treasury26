use std::sync::Arc;

use axum::{Json, extract::State};
use base64::{Engine, prelude::BASE64_STANDARD};
use near_api::{AccountId, Contract, NearToken, Tokens};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::{AppState, constants::TREASURY_FACTORY_CONTRACT_ID, services::register_new_dao};

pub const TREASURY_CREATE_DEPOSIT_IN_MICRONEAR: u128 = 5418190;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTreasuryRequest {
    pub name: String,
    pub account_id: AccountId,
    pub payment_threshold: u8,
    pub governors: Vec<AccountId>,
    pub financiers: Vec<AccountId>,
    pub requestors: Vec<AccountId>,
}

#[derive(Serialize, Deserialize)]
pub struct CreateTreasuryResponse {
    pub treasury: AccountId,
}

fn prepare_args(payload: CreateTreasuryRequest) -> Result<serde_json::Value, serde_json::Error> {
    let one_required_vote = serde_json::json!({
      "weight_kind": "RoleWeight",
      "quorum": "0",
      "threshold": "1",
    });

    let payment_threshold = serde_json::json!({
      "weight_kind": "RoleWeight",
      "quorum": "0",
      "threshold": payload.payment_threshold.to_string(),
    });

    let config = serde_json::json!({
      "config": {
        "name": payload.name,
        "purpose": "managing digital assets",
        "metadata": "",
      },
      "policy": {
        "roles": [
          {
            "kind": {
              "Group": payload.requestors,
            },
            "name": "Requestor",
            "permissions": [
              "call:AddProposal",
              "transfer:AddProposal",
              "call:VoteRemove",
              "transfer:VoteRemove"
            ],
            "vote_policy": {
              "transfer": one_required_vote.clone(),
              "call": one_required_vote.clone()
            }
          },
          {
            "kind": {
              "Group": payload.governors,
            },
            "name": "Admin",
            "permissions": [
              "config:*",
              "policy:*",
              "add_member_to_role:*",
              "remove_member_from_role:*",
              "upgrade_self:*",
              "upgrade_remote:*",
              "set_vote_token:*",
              "add_bounty:*",
              "bounty_done:*",
              "factory_info_update:*",
              "policy_add_or_update_role:*",
              "policy_remove_role:*",
              "policy_update_default_vote_policy:*",
              "policy_update_parameters:*",
            ],
            "vote_policy": {
              "config": one_required_vote.clone(),
              "policy": one_required_vote.clone(),
              "add_member_to_role": one_required_vote.clone(),
              "remove_member_from_role": one_required_vote.clone(),
              "upgrade_self": one_required_vote.clone(),
              "upgrade_remote": one_required_vote.clone(),
              "set_vote_token": one_required_vote.clone(),
              "add_bounty": one_required_vote.clone(),
              "bounty_done": one_required_vote.clone(),
              "factory_info_update": one_required_vote.clone(),
              "policy_add_or_update_role": one_required_vote.clone(),
              "policy_remove_role": one_required_vote.clone(),
              "policy_update_default_vote_policy": one_required_vote.clone(),
              "policy_update_parameters": one_required_vote.clone(),
            },
          },
          {
            "kind": {
              "Group": payload.financiers,
            },
            "name": "Approver",
            "permissions": [
              "call:VoteReject",
              "call:VoteApprove",
              "call:RemoveProposal",
              "call:Finalize",
              "transfer:VoteReject",
              "transfer:VoteApprove",
              "transfer:RemoveProposal",
              "transfer:Finalize",
            ],
            "vote_policy": {
              "transfer": payment_threshold.clone(),
              "call": payment_threshold.clone(),
            },
          },
        ],
        "default_vote_policy": {
          "weight_kind": "RoleWeight",
          "quorum": "0",
          "threshold": [1, 2],
        },
        "proposal_bond": NearToken::from_millinear(0),
        "proposal_period": "604800000000000",
        "bounty_bond": NearToken::from_millinear(0),
        "bounty_forgiveness_period": "604800000000000",
      },
    });

    let bytes = BASE64_STANDARD.encode(serde_json::to_vec(&config)?);

    let name = payload
        .account_id
        .as_str()
        .strip_suffix(".sputnik-dao.near")
        .unwrap_or(payload.account_id.as_str());
    Ok(serde_json::json!({
      "name": name,
      "args": bytes,
    }))
}

pub async fn create_treasury(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateTreasuryRequest>,
) -> Result<Json<CreateTreasuryResponse>, (StatusCode, String)> {
    let treasury = payload.account_id.clone();

    if state.env_vars.disable_treasury_creation {
        let message = format!("Treasury creation disabled. Treasury: {treasury} is not created.");
        if let Err(e) = state.telegram_client.send_message(&message).await {
            log::warn!("Failed to send Telegram notification: {}", e);
        }
        return Err((StatusCode::SERVICE_UNAVAILABLE, message));
    }

    let args = prepare_args(payload).map_err(|e| {
        eprintln!("Error preparing args: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    })?;

    Contract(TREASURY_FACTORY_CONTRACT_ID.into())
        .call_function("create", args)
        .transaction()
        .max_gas()
        .deposit(NearToken::from_micronear(
            TREASURY_CREATE_DEPOSIT_IN_MICRONEAR,
        ))
        .with_signer(state.signer_id.clone(), state.signer.clone())
        .send_to(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error creating treasury: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        })?
        .into_result()
        .map_err(|e| {
            eprintln!("Error creating treasury: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        })?;

    // Register new DAO in local cache for immediate visibility
    if let Err(e) = register_new_dao(&state.db_pool, treasury.as_str()).await {
        log::warn!("Failed to register new DAO in cache: {}", e);
        // Don't fail the request - the DAO will be picked up by the sync service
    }

    // Fetch balance after treasury creation to track the cost
    let balance_after = Tokens::account(state.signer_id.clone())
        .near_balance()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching near balance: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        })?;

    // Send success notification (non-blocking - don't fail request if notification fails)
    let message = format!(
        "Treasury created: {treasury}\nBalance after: {}",
        balance_after.total
    );
    if let Err(e) = state.telegram_client.send_message(&message).await {
        log::warn!("Failed to send Telegram notification: {}", e);
    }

    Ok(Json(CreateTreasuryResponse { treasury }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_create_treasury() {
        let token = NearToken::from_micronear(TREASURY_CREATE_DEPOSIT_IN_MICRONEAR)
            .saturating_add(NearToken::from_yoctonear(40000000000000000000));
        println!("{}", token.as_micronear());
        println!("{}", token.as_yoctonear());

        assert!(false);
    }
}
