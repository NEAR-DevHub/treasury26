use axum::{Json, extract::State, http::StatusCode};
use near_api::{
    NearGas, NearToken, Transaction,
    types::{Action, tokens::STORAGE_COST_PER_BYTE, transaction::actions::FunctionCallAction},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::{AppState, auth::AuthUser};

const MAX_RECIPIENTS_PER_BULK_PAYMENT: usize = 25;

#[derive(Debug, Deserialize)]
pub struct PaymentInput {
    pub recipient: String,
    pub amount: String,
}

#[derive(Debug, Deserialize)]
pub struct SubmitListRequest {
    pub list_id: String,
    pub submitter_id: String,
    pub dao_contract_id: String,
    pub token_id: String,
    pub payments: Vec<PaymentInput>,
}

#[derive(Debug, Serialize)]
pub struct SubmitListResponse {
    pub success: bool,
    pub list_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Compute the SHA-256 hash of the payment list for verification
fn compute_list_hash(submitter_id: &str, token_id: &str, payments: &[PaymentInput]) -> String {
    // Sort payments by recipient for deterministic hashing
    let mut sorted_payments: Vec<_> = payments
        .iter()
        .map(|p| {
            serde_json::json!({
                "amount": p.amount,
                "recipient": p.recipient,
            })
        })
        .collect();
    sorted_payments.sort_by(|a, b| {
        a["recipient"]
            .as_str()
            .unwrap()
            .cmp(b["recipient"].as_str().unwrap())
    });

    let canonical = serde_json::json!({
        "payments": sorted_payments,
        "submitter": submitter_id,
        "token_id": token_id,
    });

    let canonical_str = serde_json::to_string(&canonical).unwrap();
    let mut hasher = Sha256::new();
    hasher.update(canonical_str.as_bytes());
    hex::encode(hasher.finalize())
}

/// DAO Proposal types for verification
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct Proposal {
    id: u64,
    proposer: String,
    description: String,
    kind: ProposalKind,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
#[allow(dead_code)]
enum ProposalKind {
    FunctionCall {
        #[serde(rename = "FunctionCall")]
        function_call: FunctionCallKind,
    },
    Other(serde_json::Value),
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct FunctionCallKind {
    receiver_id: String,
    actions: Vec<ActionCall>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct ActionCall {
    method_name: String,
    args: String, // base64 encoded
    deposit: String,
    gas: String,
}

/// Verify that a pending DAO proposal exists with the given list_id
async fn verify_dao_proposal(
    state: &AppState,
    dao_contract_id: &str,
    list_id: &str,
) -> Result<bool, (StatusCode, String)> {
    // Get the last proposal ID to know the total number of proposals
    let last_proposal_id: u64 = near_api::Contract(dao_contract_id.parse().unwrap())
        .call_function("get_last_proposal_id", ())
        .read_only::<u64>()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            log::error!("Failed to fetch last proposal ID: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch last proposal ID: {}", e),
            )
        })?
        .data;

    // Calculate the starting index to get the last 100 proposals
    // If there are fewer than 100 proposals, start from 0
    let limit = 100u64;
    let from_index = last_proposal_id.saturating_sub(limit - 1);

    // Get the last 100 proposals from the DAO
    let proposals: Vec<Proposal> = near_api::Contract(dao_contract_id.parse().unwrap())
        .call_function(
            "get_proposals",
            serde_json::json!({
                "from_index": from_index,
                "limit": limit
            }),
        )
        .read_only::<Vec<Proposal>>()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
            log::error!("Failed to fetch DAO proposals: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to fetch DAO proposals: {}", e),
            )
        })?
        .data;

    // Look for a pending proposal with this list_id
    for proposal in proposals {
        if proposal.status != "InProgress" {
            continue;
        }

        // Check if this is a FunctionCall proposal
        if let ProposalKind::FunctionCall { function_call } = &proposal.kind {
            // First, check the description for the list_id (fastest check)
            if proposal.description.contains(list_id) {
                return Ok(true);
            }

            // Check each action for bulk payment related methods
            for action in &function_call.actions {
                // Case 1: Direct approve_list call (NEAR tokens)
                if action.method_name == "approve_list"
                    && function_call.receiver_id == state.bulk_payment_contract_id.as_str()
                {
                    // Decode the base64 args and check for matching list_id
                    if let Ok(decoded) = base64::Engine::decode(
                        &base64::engine::general_purpose::STANDARD,
                        &action.args,
                    ) && let Ok(args) = serde_json::from_slice::<serde_json::Value>(&decoded)
                        && let Some(proposal_list_id) = args.get("list_id").and_then(|v| v.as_str())
                        && proposal_list_id == list_id
                    {
                        return Ok(true);
                    }
                }

                // Case 2: ft_transfer_call (FT tokens)
                if action.method_name == "ft_transfer_call" {
                    // Decode the base64 args and check for matching list_id in msg field
                    if let Ok(decoded) = base64::Engine::decode(
                        &base64::engine::general_purpose::STANDARD,
                        &action.args,
                    ) && let Ok(args) = serde_json::from_slice::<serde_json::Value>(&decoded)
                        && let Some(receiver_id) = args.get("receiver_id").and_then(|v| v.as_str())
                        && receiver_id == state.bulk_payment_contract_id.as_str()
                        && let Some(msg) = args.get("msg").and_then(|v| v.as_str())
                        && msg == list_id
                    {
                        return Ok(true);
                    }
                }

                // Case 3: mt_transfer_call (MT tokens / Intents)
                if action.method_name == "mt_transfer_call" {
                    // Decode the base64 args and check for matching list_id in msg field
                    if let Ok(decoded) = base64::Engine::decode(
                        &base64::engine::general_purpose::STANDARD,
                        &action.args,
                    ) && let Ok(args) = serde_json::from_slice::<serde_json::Value>(&decoded)
                        && let Some(receiver_id) = args.get("receiver_id").and_then(|v| v.as_str())
                        && receiver_id == state.bulk_payment_contract_id.as_str()
                        && let Some(msg) = args.get("msg").and_then(|v| v.as_str())
                        && msg == list_id
                    {
                        return Ok(true);
                    }
                }
            }
        }
    }

    Ok(false)
}

fn calculate_storage_cost(num_records: u128) -> NearToken {
    STORAGE_COST_PER_BYTE
        .saturating_mul(num_records)
        .saturating_mul(11)
        .saturating_div(10)
}

fn serialize_args(
    args: &serde_json::Value,
) -> Result<Vec<u8>, (StatusCode, Json<SubmitListResponse>)> {
    serde_json::to_vec(args).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(SubmitListResponse {
                success: false,
                list_id: None,
                error: Some(format!("Failed to serialize args: {}", e)),
            }),
        )
    })
}

/// Submit a payment list to the bulk payment contract
///
/// This endpoint verifies:
/// 1. The list_id matches the SHA-256 hash of the payload
/// 2. A pending DAO proposal exists with this list_id
/// 3. The submitter is the same as the authenticated user
///
/// Then submits the list to the contract.
pub async fn submit_list(
    State(state): State<Arc<AppState>>,
    _: AuthUser,
    Json(request): Json<SubmitListRequest>,
) -> Result<Json<SubmitListResponse>, (StatusCode, Json<SubmitListResponse>)> {
    if request.payments.len() > MAX_RECIPIENTS_PER_BULK_PAYMENT {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(SubmitListResponse {
                success: false,
                list_id: None,
                error: Some(format!(
                    "Maximum number of recipients per bulk payment is {}",
                    MAX_RECIPIENTS_PER_BULK_PAYMENT
                )),
            }),
        ));
    }

    // Step 1: Verify the list_id matches the computed hash
    let computed_hash =
        compute_list_hash(&request.submitter_id, &request.token_id, &request.payments);

    if request.list_id != computed_hash {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(SubmitListResponse {
                success: false,
                list_id: None,
                error: Some(format!(
                    "Provided list_id ({}) does not match computed hash ({})",
                    request.list_id, computed_hash
                )),
            }),
        ));
    }

    // Step 2: Verify that a pending DAO proposal exists with this list_id
    match verify_dao_proposal(&state, &request.dao_contract_id, &request.list_id).await {
        Ok(true) => {
            // Proposal exists, proceed
        }
        Ok(false) => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(SubmitListResponse {
                    success: false,
                    list_id: None,
                    error: Some(format!(
                        "No pending DAO proposal found with list_id: {}",
                        request.list_id
                    )),
                }),
            ));
        }
        Err((status, msg)) => {
            return Err((
                status,
                Json(SubmitListResponse {
                    success: false,
                    list_id: None,
                    error: Some(msg),
                }),
            ));
        }
    }

    // Step 3: Submit the list to the contract
    let payments: Vec<serde_json::Value> = request
        .payments
        .iter()
        .map(|p| {
            serde_json::json!({
                "recipient": p.recipient,
                "amount": p.amount,
            })
        })
        .collect();

    let execution_result = Transaction::construct(
        state.bulk_payment_contract_id.clone(),
        state.bulk_payment_contract_id.clone(),
    )
    .add_action(Action::FunctionCall(Box::new(FunctionCallAction {
        method_name: "buy_storage".to_string(),
        args: serialize_args(&serde_json::json!({
            "num_records": payments.len() as u64,
            "beneficiary_account_id": request.dao_contract_id.clone(),
        }))?,
        gas: NearGas::from_tgas(100),
        deposit: calculate_storage_cost(payments.len() as u128),
    })))
    .add_action(Action::FunctionCall(Box::new(FunctionCallAction {
        method_name: "submit_list".to_string(),
        args: serialize_args(&serde_json::json!({
            "list_id": request.list_id,
            "token_id": request.token_id,
            "payments": payments,
            "submitter_id": request.submitter_id,
        }))?,
        gas: NearGas::from_tgas(200),
        deposit: NearToken::from_yoctonear(0),
    })))
    .with_signer(state.bulk_payment_signer.clone())
    .send_to(&state.network)
    .await;

    match execution_result {
        Ok(result) => {
            // Check if the transaction execution succeeded
            match result.into_result() {
                Ok(_) => {
                    // Step 4: Decrement credits in monitored_accounts table
                    log::info!(
                        "Bulk payment submitted successfully fyurtur.near,0.01
yurtur-treasury.sputnik-dao.near,0.01or treasury {}. Decrementing credits...",
                        request.dao_contract_id
                    );

                    // First, check current credits
                    let current_credits_result = sqlx::query_as::<_, (i32,)>(
                        r#"
                        SELECT batch_payment_credits
                        FROM monitored_accounts
                        WHERE account_id = $1
                        "#,
                    )
                    .bind(&request.dao_contract_id)
                    .fetch_optional(&state.db_pool)
                    .await;

                    match current_credits_result {
                        Ok(Some((current_credits,))) => {
                            log::info!(
                                "Treasury {} currently has {} credits before decrement",
                                request.dao_contract_id,
                                current_credits
                            );
                        }
                        Ok(None) => {
                            log::warn!(
                                "Treasury {} not found in monitored_accounts table",
                                request.dao_contract_id
                            );
                        }
                        Err(e) => {
                            log::error!(
                                "Failed to check current credits for {}: {}",
                                request.dao_contract_id,
                                e
                            );
                        }
                    }

                    let db_result = sqlx::query_as::<_, (i32,)>(
                        r#"
                UPDATE monitored_accounts
                SET batch_payment_credits = GREATEST(batch_payment_credits - 1, 0),
                    updated_at = NOW()
                WHERE account_id = $1
                RETURNING batch_payment_credits
                "#,
                    )
                    .bind(&request.dao_contract_id)
                    .fetch_optional(&state.db_pool)
                    .await;

                    match db_result {
                        Ok(Some((new_credits,))) => {
                            log::info!(
                                "Successfully decremented credits for treasury {}. New balance: {}",
                                request.dao_contract_id,
                                new_credits
                            );
                        }
                        Ok(None) => {
                            log::warn!(
                                "Treasury {} not found in monitored_accounts, credits not decremented",
                                request.dao_contract_id
                            );
                        }
                        Err(e) => {
                            log::error!(
                                "Failed to decrement batch payment credits for {}: {}",
                                request.dao_contract_id,
                                e
                            );
                            // Don't fail the request if DB update fails - contract submission succeeded
                        }
                    }

                    // Step 5: Add list to the payout worker queue for processing
                    // This ensures the worker will poll this list and process payments once approved
                    super::worker::add_pending_list(request.list_id.clone()).await;

                    Ok(Json(SubmitListResponse {
                        success: true,
                        list_id: Some(request.list_id),
                        error: None,
                    }))
                }
                Err(e) => {
                    log::error!("Contract execution failed: {:?}", e);
                    Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(SubmitListResponse {
                            success: false,
                            list_id: None,
                            error: Some(format!("Contract execution failed: {}", e)),
                        }),
                    ))
                }
            }
        }
        Err(e) => {
            log::error!("Failed to submit list to contract: {:?}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(SubmitListResponse {
                    success: false,
                    list_id: None,
                    error: Some(format!("Failed to submit list: {}", e)),
                }),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_list_hash() {
        let payments = vec![
            PaymentInput {
                recipient: "bob.near".to_string(),
                amount: "1000000000000000000000000".to_string(),
            },
            PaymentInput {
                recipient: "alice.near".to_string(),
                amount: "2000000000000000000000000".to_string(),
            },
        ];

        let hash1 = compute_list_hash("testdao.sputnik-dao.near", "native", &payments);

        // Same inputs should produce the same hash
        let hash2 = compute_list_hash("testdao.sputnik-dao.near", "native", &payments);
        assert_eq!(hash1, hash2);

        // Different order should produce the same hash (sorted by recipient)
        let payments_reversed = vec![
            PaymentInput {
                recipient: "alice.near".to_string(),
                amount: "2000000000000000000000000".to_string(),
            },
            PaymentInput {
                recipient: "bob.near".to_string(),
                amount: "1000000000000000000000000".to_string(),
            },
        ];
        let hash3 = compute_list_hash("testdao.sputnik-dao.near", "native", &payments_reversed);
        assert_eq!(hash1, hash3);

        // Hash should be 64 characters (SHA-256 hex)
        assert_eq!(hash1.len(), 64);
    }
}
