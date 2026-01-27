use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct PayoutBatchRequest {
    pub list_id: String,
}

#[derive(Debug, Serialize)]
pub struct PayoutBatchResponse {
    pub success: bool,
    pub total_batches_processed: u32,
    pub total_payments_processed: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Execute payout_batch for an approved bulk payment list
///
/// This calls the contract's payout_batch method repeatedly until all payments are processed.
/// The contract processes as many payments as gas allows per call (dynamic based on token type).
pub async fn payout_batch(
    State(state): State<Arc<AppState>>,
    Json(request): Json<PayoutBatchRequest>,
) -> Result<Json<PayoutBatchResponse>, (StatusCode, Json<PayoutBatchResponse>)> {
    log::info!(
        "Starting payout_batch processing for list_id={}",
        request.list_id
    );

    let mut total_batches = 0u32;
    let mut remaining = u64::MAX;
    let mut initial_remaining: Option<u64> = None;
    const MAX_BATCHES: u32 = 100; // Safety limit

    while remaining > 0 && total_batches < MAX_BATCHES {
        total_batches += 1;

        log::info!(
            "Executing payout_batch #{} for list_id={}",
            total_batches,
            request.list_id
        );

        let result = near_api::Contract(state.bulk_payment_contract_id.clone())
            .call_function(
                "payout_batch",
                serde_json::json!({
                    "list_id": request.list_id,
                }),
            )
            .transaction()
            .max_gas()
            .deposit(near_api::types::NearToken::from_yoctonear(0))
            .with_signer(state.signer_id.clone(), state.signer.clone())
            .send_to(&state.network)
            .await;

        match result {
            Ok(execution_result) => match execution_result.into_result() {
                Ok(remaining_result) => {
                    // The contract returns the number of remaining pending payments as u64
                    remaining = remaining_result.json::<u64>().unwrap_or(0);

                    if initial_remaining.is_none() {
                        // First call, store the initial count to calculate total processed
                        initial_remaining = Some(remaining);
                    }

                    log::info!(
                        "Batch #{} completed for list_id={}, {} payments remaining",
                        total_batches,
                        request.list_id,
                        remaining
                    );

                    if remaining > 0 {
                        // Small delay between batches to avoid overwhelming the network
                        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                    }
                }
                Err(e) => {
                    log::error!(
                        "payout_batch execution failed on batch #{}: {:?}",
                        total_batches,
                        e
                    );
                    return Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(PayoutBatchResponse {
                            success: false,
                            total_batches_processed: total_batches - 1,
                            total_payments_processed: 0,
                            error: Some(format!(
                                "Contract execution failed on batch {}: {}",
                                total_batches, e
                            )),
                        }),
                    ));
                }
            },
            Err(e) => {
                log::error!(
                    "Failed to call payout_batch on batch #{}: {:?}",
                    total_batches,
                    e
                );
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(PayoutBatchResponse {
                        success: false,
                        total_batches_processed: total_batches - 1,
                        total_payments_processed: 0,
                        error: Some(format!(
                            "Failed to execute payout batch #{}: {}",
                            total_batches, e
                        )),
                    }),
                ));
            }
        }
    }

    if remaining > 0 {
        log::warn!(
            "Reached max batches ({}) for list_id={}, {} payments still remaining",
            MAX_BATCHES,
            request.list_id,
            remaining
        );
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(PayoutBatchResponse {
                success: false,
                total_batches_processed: total_batches,
                total_payments_processed: initial_remaining.unwrap_or(0) - remaining,
                error: Some(format!(
                    "Failed to complete all payments after {} batches. {} payments remaining.",
                    MAX_BATCHES, remaining
                )),
            }),
        ));
    }

    let total_payments = initial_remaining.unwrap_or(0);
    log::info!(
        "Successfully completed all {} payments for list_id={} in {} batches",
        total_payments,
        request.list_id,
        total_batches
    );

    Ok(Json(PayoutBatchResponse {
        success: true,
        total_batches_processed: total_batches,
        total_payments_processed: total_payments,
        error: None,
    }))
}
