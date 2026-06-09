use std::collections::HashSet;
use std::sync::Arc;

use axum::response::sse::{Event, KeepAlive, Sse};
use axum::{Json, extract::State};
use base64::{Engine, prelude::BASE64_STANDARD};
use bigdecimal::BigDecimal;
use futures::stream::Stream;
use near_api::{AccountId, Contract, NearToken, Tokens};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::{
    AppState,
    constants::TREASURY_FACTORY_CONTRACT_ID,
    services::{
        mark_testing_if_needed, register_new_dao_and_wait, register_or_refresh_monitored_account,
        should_mark_testing,
    },
};

use super::confidential_setup;

pub const TREASURY_CREATE_DEPOSIT: NearToken = NearToken::from_millinear(90);
pub const REGISTERING_DAO_TIMEOUT_IN_SECS: u64 = 10;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTreasuryRequest {
    pub name: String,
    pub account_id: AccountId,
    pub payment_threshold: u8,
    pub governance_threshold: u8,
    pub governors: Vec<AccountId>,
    pub financiers: Vec<AccountId>,
    pub requestors: Vec<AccountId>,
    #[serde(default)]
    pub is_confidential: bool,
}

#[derive(Serialize, Deserialize)]
pub struct CreateTreasuryResponse {
    pub treasury: AccountId,
}

/// Build the sputnik-dao policy JSON for the given members and thresholds.
pub fn build_policy(
    requestors: &[AccountId],
    governors: &[AccountId],
    financiers: &[AccountId],
    governance_threshold: u8,
    payment_threshold: u8,
) -> serde_json::Value {
    let one_required_vote = serde_json::json!({
      "weight_kind": "RoleWeight",
      "quorum": "0",
      "threshold": "1",
    });

    let governance_threshold_json = serde_json::json!({
      "weight_kind": "RoleWeight",
      "quorum": "0",
      "threshold": governance_threshold.to_string(),
    });

    let payment_threshold_json = serde_json::json!({
      "weight_kind": "RoleWeight",
      "quorum": "0",
      "threshold": payment_threshold.to_string(),
    });

    serde_json::json!({
      "roles": [
        {
          "kind": {
            "Group": requestors,
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
            "Group": governors,
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
            "config": governance_threshold_json.clone(),
            "policy": governance_threshold_json.clone(),
            "add_member_to_role": governance_threshold_json.clone(),
            "remove_member_from_role": governance_threshold_json.clone(),
            "upgrade_self": governance_threshold_json.clone(),
            "upgrade_remote": governance_threshold_json.clone(),
            "set_vote_token": governance_threshold_json.clone(),
            "add_bounty": governance_threshold_json.clone(),
            "bounty_done": governance_threshold_json.clone(),
            "factory_info_update": governance_threshold_json.clone(),
            "policy_add_or_update_role": governance_threshold_json.clone(),
            "policy_remove_role": governance_threshold_json.clone(),
            "policy_update_default_vote_policy": governance_threshold_json.clone(),
            "policy_update_parameters": governance_threshold_json.clone(),
          },
        },
        {
          "kind": {
            "Group": financiers,
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
            "transfer": payment_threshold_json.clone(),
            "call": payment_threshold_json.clone(),
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
    })
}

fn collect_payload_members(payload: &CreateTreasuryRequest) -> HashSet<String> {
    payload
        .requestors
        .iter()
        .chain(payload.governors.iter())
        .chain(payload.financiers.iter())
        .map(|account_id| account_id.as_str().to_string())
        .collect()
}

fn build_treasury_created_message(
    treasury: &AccountId,
    is_confidential: bool,
    is_testing: bool,
    balance_after: &str,
) -> String {
    let conf_label = if is_confidential {
        " (confidential)"
    } else {
        ""
    };
    let testing_label = if is_testing { " [TESTING]" } else { "" };
    format!(
        "Treasury created{conf_label}{testing_label}: {treasury}\nBalance after: {}",
        balance_after
    )
}

fn prepare_args(
    payload: &CreateTreasuryRequest,
    policy: &serde_json::Value,
) -> Result<serde_json::Value, serde_json::Error> {
    let config = serde_json::json!({
      "config": {
        "name": payload.name,
        "purpose": "managing digital assets",
        "metadata": "",
      },
      "policy": policy,
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

#[derive(Serialize, Clone)]
pub struct ProgressEvent {
    pub step: &'static str,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub treasury: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Send a progress update through the channel.
pub async fn send_progress(
    tx: &mpsc::Sender<ProgressEvent>,
    step: &'static str,
    status: &'static str,
) {
    let _ = tx
        .send(ProgressEvent {
            step,
            status,
            treasury: None,
            message: None,
        })
        .await;
}

pub async fn create_treasury_stream(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateTreasuryRequest>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let (tx, mut rx) = mpsc::channel::<ProgressEvent>(32);

    tokio::spawn(async move {
        if let Err(evt) = run_creation(state, payload, tx.clone()).await {
            let _ = tx.send(evt).await;
        }
    });

    let stream = async_stream::stream! {
        while let Some(evt) = rx.recv().await {
            let is_terminal = evt.step == "done" || evt.step == "error";
            if let Ok(json) = serde_json::to_string(&evt) {
                yield Ok(Event::default().data(json));
            }
            if is_terminal {
                break;
            }
        }
    };

    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn run_creation(
    state: Arc<AppState>,
    payload: CreateTreasuryRequest,
    tx: mpsc::Sender<ProgressEvent>,
) -> Result<(), ProgressEvent> {
    let treasury = payload.account_id.clone();
    let is_confidential = payload.is_confidential;

    if state.env_vars.disable_treasury_creation {
        let message = format!("Treasury creation disabled. Treasury: {treasury} is not created.");
        if let Err(e) = state.telegram_client.send_message(&message).await {
            log::warn!("Failed to send Telegram notification: {}", e);
        }
        return Err(ProgressEvent {
            step: "error",
            status: "error",
            treasury: None,
            message: Some(message),
        });
    }

    // ── Step 1: Create DAO ─────────────────────────────────────────────
    send_progress(&tx, "creating_dao", "in_progress").await;

    let user_policy = build_policy(
        &payload.requestors,
        &payload.governors,
        &payload.financiers,
        payload.governance_threshold,
        payload.payment_threshold,
    );

    let creation_policy = if is_confidential {
        let sponsor = vec![state.signer_id.clone()];
        build_policy(&sponsor, &sponsor, &sponsor, 1, 1)
    } else {
        user_policy.clone()
    };

    let args = prepare_args(&payload, &creation_policy).map_err(|e| {
        eprintln!("Error preparing args: {}", e);
        ProgressEvent {
            step: "error",
            status: "error",
            treasury: None,
            message: Some(e.to_string()),
        }
    })?;

    Contract(TREASURY_FACTORY_CONTRACT_ID.into())
        .call_function("create", args)
        .transaction()
        .max_gas()
        .deposit(TREASURY_CREATE_DEPOSIT)
        .with_signer(state.signer_id.clone(), state.signer.clone())
        .send_to(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error creating treasury: {}", e);
            ProgressEvent {
                step: "error",
                status: "error",
                treasury: None,
                message: Some(format!("Failed to create treasury: {e}")),
            }
        })?
        .into_result()
        .map_err(|e| {
            eprintln!("Error creating treasury: {}", e);
            ProgressEvent {
                step: "error",
                status: "error",
                treasury: None,
                message: Some(format!("Failed to create treasury: {e}")),
            }
        })?;

    send_progress(&tx, "creating_dao", "completed").await;

    if let Err(e) =
        register_or_refresh_monitored_account(&state.db_pool, &treasury, is_confidential).await
    {
        log::warn!("Failed to add treasury to monitored accounts: {:?}", e);
    }

    let creation_cost: BigDecimal = TREASURY_CREATE_DEPOSIT.as_yoctonear().into();
    if let Err(e) = sqlx::query!(
        r#"
        UPDATE monitored_accounts
        SET paid_near = paid_near + $2,
            created_by_trezu_at = NOW(),
            updated_at = NOW()
        WHERE account_id = $1
        "#,
        treasury.as_str(),
        creation_cost,
    )
    .execute(&state.db_pool)
    .await
    {
        log::warn!(
            "Failed to update paid_near for {}: {}",
            treasury.as_str(),
            e
        );
    }

    // ── Confidential setup ─────────────────────────────────────────────
    if is_confidential {
        confidential_setup::setup_confidential_treasury(&state, &treasury, user_policy, Some(&tx))
            .await
            .map_err(|(_, msg)| ProgressEvent {
                step: "error",
                status: "error",
                treasury: None,
                message: Some(msg),
            })?;
    }

    let payload_members = collect_payload_members(&payload);
    let should_mark = should_mark_testing(
        treasury.as_str(),
        &payload_members,
        &state.env_vars.testing_sputnik_dao_ids,
        &state.env_vars.testing_near_account_ids,
    );
    let is_testing =
        match mark_testing_if_needed(&state.db_pool, treasury.as_str(), should_mark).await {
            Ok(value) => value,
            Err(e) => {
                log::warn!(
                    "Failed to update testing flag for treasury {}: {}",
                    treasury.as_str(),
                    e
                );
                should_mark
            }
        };

    // ── Finalize ───────────────────────────────────────────────────────
    send_progress(&tx, "finalizing", "in_progress").await;

    match register_new_dao_and_wait(
        &state.db_pool,
        treasury.as_str(),
        std::time::Duration::from_secs(REGISTERING_DAO_TIMEOUT_IN_SECS),
    )
    .await
    {
        Ok(true) => {}
        Ok(false) => log::warn!("DAO {} registered but sync timed out", treasury),
        Err(e) => log::warn!("Failed to register new DAO in cache: {}", e),
    }

    let balance_after = Tokens::account(state.signer_id.clone())
        .near_balance()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            eprintln!("Error fetching near balance: {}", e);
            ProgressEvent {
                step: "error",
                status: "error",
                treasury: None,
                message: Some(format!("Failed to fetch balance: {e}")),
            }
        })?;

    let message = build_treasury_created_message(
        &treasury,
        is_confidential,
        is_testing,
        &balance_after.total.to_string(),
    );
    if let Err(e) = state.telegram_client.send_message(&message).await {
        log::warn!("Failed to send Telegram notification: {}", e);
    }

    send_progress(&tx, "finalizing", "completed").await;

    // ── Done ───────────────────────────────────────────────────────────
    let _ = tx
        .send(ProgressEvent {
            step: "done",
            status: "completed",
            treasury: Some(treasury.to_string()),
            message: None,
        })
        .await;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_payload_members_deduplicates_roles() {
        let payload = CreateTreasuryRequest {
            name: "Treasury".to_string(),
            account_id: "team.sputnik-dao.near".parse().expect("valid account"),
            payment_threshold: 1,
            governance_threshold: 1,
            governors: vec![
                "alice.near".parse().expect("valid account"),
                "bob.near".parse().expect("valid account"),
            ],
            financiers: vec!["alice.near".parse().expect("valid account")],
            requestors: vec!["carol.near".parse().expect("valid account")],
            is_confidential: true,
        };

        let members = collect_payload_members(&payload);
        assert_eq!(members.len(), 3, "duplicate member should be deduplicated");
        assert!(members.contains("alice.near"));
        assert!(members.contains("bob.near"));
        assert!(members.contains("carol.near"));
    }

    #[test]
    fn build_treasury_created_message_includes_testing_flag() {
        let treasury: AccountId = "team.sputnik-dao.near".parse().expect("valid account");
        let message = build_treasury_created_message(&treasury, true, true, "10 NEAR");

        assert!(
            message.contains("Treasury created (confidential) [TESTING]: team.sputnik-dao.near"),
            "confidential and testing labels should be present"
        );
        assert!(
            message.contains("Balance after: 10 NEAR"),
            "balance should remain part of the notification"
        );
    }

    #[test]
    fn build_treasury_created_message_hides_testing_label_for_normal_treasury() {
        let treasury: AccountId = "team.sputnik-dao.near".parse().expect("valid account");
        let message = build_treasury_created_message(&treasury, false, false, "10 NEAR");

        assert!(
            message.contains("Treasury created: team.sputnik-dao.near"),
            "base message should be unchanged for non-testing treasuries"
        );
        assert!(
            !message.contains("[TESTING]"),
            "non-testing message should not include testing label"
        );
    }
}
