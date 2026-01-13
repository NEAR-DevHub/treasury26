use crate::app_state::AppState;
use near_api::Contract;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;

lazy_static::lazy_static! {
    /// Shared state for tracking pending payment lists
    /// This is used to avoid querying the contract for every poll
    static ref PENDING_LISTS: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
}

/// Add a list_id to the set of pending lists to be processed by the worker
pub async fn add_pending_list(list_id: String) {
    log::info!("Adding list {} to payout worker queue", list_id);
    let mut pending = PENDING_LISTS.lock().await;
    pending.insert(list_id);
    log::info!("Payout worker queue now has {} lists", pending.len());
}

/// Query the bulk payment contract for pending payment lists and process them
///
/// This function checks known pending lists on-chain and calls payout_batch
/// to process pending payments.
///
/// Returns the number of batches processed.
pub async fn query_and_process_pending_lists(
    state: &Arc<AppState>,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    // Get a copy of pending list IDs
    let list_ids: Vec<String> = {
        let pending = PENDING_LISTS.lock().await;
        pending.iter().cloned().collect()
    };

    if list_ids.is_empty() {
        return Ok(0);
    }

    log::info!(
        "Worker checking {} pending lists: {:?}",
        list_ids.len(),
        list_ids
    );

    let mut processed_count = 0;
    let mut completed_lists = Vec::new();

    for list_id in &list_ids {
        // Call payout_batch to process up to 100 payments
        // The contract will handle the logic of checking if the list is ready
        log::info!("Processing payout batch for list {}", list_id);

        let call_result = Contract(state.bulk_payment_contract_id.clone())
            .call_function(
                "payout_batch",
                serde_json::json!({
                    "caller_id": state.bulk_payment_contract_id.to_string(),
                    "list_id": list_id
                }),
            )
            .transaction()
            .with_signer(state.signer_id.clone(), state.signer.clone())
            .send_to(&state.network)
            .await;

        match call_result {
            Ok(_) => {
                processed_count += 1;
                log::info!("Successfully processed batch for list {}", list_id);
            }
            Err(e) => {
                let err_str = e.to_string();
                log::error!("Failed to process batch for list {}: {}", list_id, err_str);

                // Remove list from tracking if it's not found, completed, or rejected
                if err_str.contains("not found")
                    || err_str.contains("No pending payments")
                    || err_str.contains("not approved")
                {
                    log::info!("Removing list {} from worker queue", list_id);
                    completed_lists.push(list_id.clone());
                }
            }
        }
    }

    // Remove completed lists from tracking
    if !completed_lists.is_empty() {
        let mut pending = PENDING_LISTS.lock().await;
        for list_id in completed_lists {
            pending.remove(&list_id);
        }
    }

    Ok(processed_count)
}
