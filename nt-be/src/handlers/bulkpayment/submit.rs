use axum::{Json, extract::State, http::StatusCode};
use near_api::{
    AccountId, NearGas, NearToken, Transaction,
    types::{Action, tokens::STORAGE_COST_PER_BYTE, transaction::actions::FunctionCallAction},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::handlers::subscription::plans::get_account_plan_info;
use crate::{AppState, auth::AuthUser};

const MAX_RECIPIENTS_PER_BULK_PAYMENT: usize = 25;
const BYTES_PER_RECORD: u128 = 216;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentInput {
    pub recipient: String,
    pub amount: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitListRequest {
    pub list_id: String,
    pub timestamp: u64,
    pub submitter_id: String,
    pub dao_contract_id: AccountId,
    pub token_id: String,
    pub payments: Vec<PaymentInput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitListResponse {
    pub success: bool,
    pub list_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Compute the SHA-256 hash of the payment list for verification
/// Includes timestamp to allow the same payment list to be submitted multiple times
fn compute_list_hash(
    submitter_id: &str,
    token_id: &str,
    payments: &[PaymentInput],
    timestamp: u64,
) -> String {
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
        "timestamp": timestamp,
        "token_id": token_id,
    });

    let canonical_str = serde_json::to_string(&canonical).unwrap();
    let mut hasher = Sha256::new();
    hasher.update(canonical_str.as_bytes());
    hex::encode(hasher.finalize())
}

fn calculate_storage_cost(num_records: u128) -> NearToken {
    STORAGE_COST_PER_BYTE
        .saturating_mul(BYTES_PER_RECORD)
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
/// 2. The authenticated user is a policy member of the DAO
///
/// Then submits the list to the contract.
pub async fn submit_list(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
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
    let computed_hash = compute_list_hash(
        &request.submitter_id,
        &request.token_id,
        &request.payments,
        request.timestamp,
    );

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

    // Step 2: Ensure the caller can submit proposals by DAO policy
    if let Err((status, msg)) = auth_user
        .verify_can_add_proposal(&state, &request.dao_contract_id)
        .await
    {
        return Err((
            status,
            Json(SubmitListResponse {
                success: false,
                list_id: None,
                error: Some(msg),
            }),
        ));
    }

    // Step 3: Check if treasury has available batch payment credits
    let account_plan = get_account_plan_info(&state.db_pool, request.dao_contract_id.as_str())
        .await
        .map_err(|e| {
            log::error!(
                "Failed to fetch account plan info for {}: {}",
                request.dao_contract_id,
                e
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(SubmitListResponse {
                    success: false,
                    list_id: None,
                    error: Some(format!("Failed to check subscription status: {}", e)),
                }),
            )
        })?;

    // Check if account exists and has credits
    match account_plan {
        Some(plan) => {
            if plan.batch_payment_credits <= 0 {
                return Err((
                    StatusCode::PAYMENT_REQUIRED,
                    Json(SubmitListResponse {
                        success: false,
                        list_id: None,
                        error: Some(format!(
                            "Insufficient batch payment credits. Your treasury has {} credits remaining. Please upgrade your plan or wait for the monthly reset.",
                            plan.batch_payment_credits
                        )),
                    }),
                ));
            }
            log::info!(
                "Treasury {} has {} batch payment credits available",
                request.dao_contract_id,
                plan.batch_payment_credits
            );
        }
        None => {
            log::warn!(
                "Treasury {} not found in monitored accounts. Proceeding without credit check.",
                request.dao_contract_id
            );
        }
    }

    // Step 4: Submit the list to the contract
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
                    // Step 5: Decrement credits using shared subscription function
                    log::info!(
                        "Bulk payment submitted successfully for treasury {}. Decrementing credits...",
                        request.dao_contract_id
                    );

                    let db_result = sqlx::query_as::<_, (i32,)>(
                        r#"
                UPDATE monitored_accounts
                SET batch_payment_credits = GREATEST(batch_payment_credits - 1, 0),
                    updated_at = NOW()
                WHERE account_id = $1
                RETURNING batch_payment_credits
                "#,
                    )
                    .bind(request.dao_contract_id.as_str())
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
                    if let Err(e) =
                        super::worker::add_pending_list(&state.db_pool, &request.list_id).await
                    {
                        log::error!(
                            "Failed to add list {} to payout worker queue: {}",
                            request.list_id,
                            e
                        );
                        // Don't fail the request - contract submission already succeeded
                    }

                    crate::services::platform_metrics::record_event(
                        &state.db_pool,
                        request.dao_contract_id.as_str(),
                        crate::services::platform_metrics::PlatformMetric::BatchPaymentsUsed,
                    )
                    .await;

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

        let timestamp = 1234567890;
        let hash1 = compute_list_hash("testdao.sputnik-dao.near", "native", &payments, timestamp);

        // Same inputs should produce the same hash
        let hash2 = compute_list_hash("testdao.sputnik-dao.near", "native", &payments, timestamp);
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
        let hash3 = compute_list_hash(
            "testdao.sputnik-dao.near",
            "native",
            &payments_reversed,
            timestamp,
        );
        assert_eq!(hash1, hash3);

        // Different timestamp should produce different hash
        let hash4 = compute_list_hash("testdao.sputnik-dao.near", "native", &payments, 9876543210);
        assert_ne!(hash1, hash4);

        // Hash should be 64 characters (SHA-256 hex)
        assert_eq!(hash1.len(), 64);
    }
}
