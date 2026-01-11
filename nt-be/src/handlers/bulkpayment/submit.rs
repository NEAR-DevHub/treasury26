use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::{AppState, constants::BATCH_PAYMENT_ACCOUNT_ID};

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
    // Get the last 100 proposals from the DAO
    let proposals: Vec<Proposal> = near_api::Contract(dao_contract_id.parse().unwrap())
        .call_function(
            "get_proposals",
            serde_json::json!({
                "from_index": 0,
                "limit": 100
            }),
        )
        .read_only::<Vec<Proposal>>()
        .fetch_from(&state.network)
        .await
        .map_err(|e| {
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
            // Check if it targets the bulk payment contract
            if function_call.receiver_id != BATCH_PAYMENT_ACCOUNT_ID.to_string() {
                continue;
            }

            // Check each action for approve_list with matching list_id
            for action in &function_call.actions {
                if action.method_name != "approve_list" {
                    continue;
                }

                // Decode the base64 args
                if let Ok(decoded) =
                    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &action.args)
                {
                    if let Ok(args) = serde_json::from_slice::<serde_json::Value>(&decoded) {
                        if let Some(proposal_list_id) = args.get("list_id").and_then(|v| v.as_str())
                        {
                            if proposal_list_id == list_id {
                                return Ok(true);
                            }
                        }
                    }
                }
            }
        }

        // Also check the description for the list_id (fallback)
        if proposal.description.contains(list_id) {
            return Ok(true);
        }
    }

    Ok(false)
}

/// Submit a payment list to the bulk payment contract
///
/// This endpoint verifies:
/// 1. The list_id matches the SHA-256 hash of the payload
/// 2. A pending DAO proposal exists with this list_id
///
/// Then submits the list to the contract.
pub async fn submit_list(
    State(state): State<Arc<AppState>>,
    Json(request): Json<SubmitListRequest>,
) -> Result<Json<SubmitListResponse>, (StatusCode, Json<SubmitListResponse>)> {
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

    let result = near_api::Contract(BATCH_PAYMENT_ACCOUNT_ID.into())
        .call_function(
            "submit_list",
            serde_json::json!({
                "list_id": request.list_id,
                "token_id": request.token_id,
                "payments": payments,
                "submitter_id": request.submitter_id,
            }),
        )
        .transaction()
        .with_signer_account(state.signer_id.clone())
        .with_signer((*state.signer).clone())
        .send_to(&state.network)
        .await;

    match result {
        Ok(_) => Ok(Json(SubmitListResponse {
            success: true,
            list_id: Some(request.list_id),
            error: None,
        })),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(SubmitListResponse {
                success: false,
                list_id: None,
                error: Some(format!("Failed to submit list: {}", e)),
            }),
        )),
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
