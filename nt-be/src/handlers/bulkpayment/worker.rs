use crate::app_state::AppState;
use near_api::Contract;
use serde::Deserialize;
use sqlx::PgPool;
use std::sync::Arc;

/// Response type for view_list contract call
#[derive(Debug, Deserialize)]
struct PaymentListView {
    status: PaymentListStatus,
    payments: Vec<PaymentView>,
    #[allow(dead_code)]
    created_at: u64,
}

#[derive(Debug, Deserialize)]
struct PaymentView {
    status: PaymentItemStatus,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum PaymentItemStatus {
    Simple(String),
    Object(serde_json::Value),
}

impl PaymentItemStatus {
    fn is_pending(&self) -> bool {
        match self {
            PaymentItemStatus::Simple(s) => s == "Pending",
            PaymentItemStatus::Object(v) => v.get("Pending").is_some(),
        }
    }
}

impl PaymentListView {
    fn has_pending_payments(&self) -> bool {
        self.payments.iter().any(|p| p.status.is_pending())
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
#[allow(non_snake_case)]
enum PaymentListStatus {
    Simple(String),
    Enum {
        Pending: Option<()>,
        Approved: Option<()>,
        #[allow(dead_code)]
        Rejected: Option<()>,
    },
}

impl PaymentListStatus {
    fn is_approved(&self) -> bool {
        matches!(
            self,
            PaymentListStatus::Simple(s) if s == "Approved"
        ) || matches!(
            self,
            PaymentListStatus::Enum {
                Approved: Some(_),
                ..
            }
        )
    }

    fn is_pending(&self) -> bool {
        matches!(
            self,
            PaymentListStatus::Simple(s) if s == "Pending"
        ) || matches!(
            self,
            PaymentListStatus::Enum {
                Pending: Some(_),
                ..
            }
        )
    }
}

/// Add a list_id to the pending payment lists table for the worker to process.
/// Uses ON CONFLICT DO NOTHING for idempotency.
pub async fn add_pending_list(pool: &PgPool, list_id: &str) -> Result<(), sqlx::Error> {
    tracing::info!("Adding list {} to payout worker queue", list_id);
    sqlx::query!(
        "INSERT INTO pending_payment_lists (list_id) VALUES ($1) ON CONFLICT DO NOTHING",
        list_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Mark a list as completed in the pending payment lists table.
async fn complete_pending_list(pool: &PgPool, list_id: &str) {
    if let Err(e) = sqlx::query!(
        "UPDATE pending_payment_lists SET completed_at = NOW() WHERE list_id = $1",
        list_id
    )
    .execute(pool)
    .await
    {
        tracing::error!(
            "Failed to mark list {} as completed in pending_payment_lists: {}",
            list_id,
            e
        );
    }
}

/// Query the bulk payment contract for pending payment lists and process them
///
/// This function reads pending list IDs from the database, checks their on-chain
/// status, and calls payout_batch for approved lists. Lists are removed from the
/// database when completed, rejected, or not found on-chain.
///
/// Also drives the confidential bulk-payment state machine (per-DAO sub
/// activate → ping → submit) on the same tick.
///
/// Returns the number of batches processed.
pub async fn query_and_process_pending_lists(
    state: &Arc<AppState>,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    // Drive confidential bulk-payments alongside the public list payouts.
    super::confidential_processor::process_confidential_bulk_payments(state).await;

    // Get pending list IDs from the database
    let rows = sqlx::query!("SELECT list_id FROM pending_payment_lists WHERE completed_at IS NULL")
        .fetch_all(&state.db_pool)
        .await?;

    let list_ids: Vec<String> = rows.into_iter().map(|r| r.list_id).collect();

    if list_ids.is_empty() {
        return Ok(0);
    }

    tracing::info!(
        "Worker checking {} pending lists: {:?}",
        list_ids.len(),
        list_ids
    );

    let mut processed_count = 0;

    for list_id in &list_ids {
        // First check list status via view call before attempting payout
        tracing::info!("Checking status of list {}", list_id);

        let view_result = Contract(state.bulk_payment_contract_id.clone())
            .call_function(
                "view_list",
                serde_json::json!({
                    "list_id": list_id
                }),
            )
            .read_only::<PaymentListView>()
            .fetch_from(&state.network)
            .await;

        match view_result {
            Ok(response) => {
                let list = response.data;
                if list.status.is_pending() {
                    tracing::debug!("List {} is still pending approval, skipping", list_id);
                    continue;
                }
                if !list.status.is_approved() {
                    // List is rejected or in an unknown state — remove from queue
                    tracing::info!(
                        "List {} is not approved (rejected or unknown status), removing from queue",
                        list_id
                    );
                    complete_pending_list(&state.db_pool, list_id).await;
                    continue;
                }
                if !list.has_pending_payments() {
                    tracing::info!(
                        "List {} has no pending payments (all paid), removing from queue",
                        list_id
                    );
                    complete_pending_list(&state.db_pool, list_id).await;
                    continue;
                }
            }
            Err(e) => {
                let err_str = e.to_string();
                if err_str.contains("not found") {
                    tracing::info!("List {} not found on-chain, removing from queue", list_id);
                    complete_pending_list(&state.db_pool, list_id).await;
                } else {
                    tracing::error!("Failed to view list {}: {}", list_id, err_str);
                }
                continue;
            }
        }

        // List is approved — proceed with payout
        tracing::info!("Processing payout batch for approved list {}", list_id);

        let call_result = Contract(state.bulk_payment_contract_id.clone())
            .call_function(
                "payout_batch",
                serde_json::json!({
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
                tracing::info!("Successfully processed batch for list {}", list_id);
            }
            Err(e) => {
                let err_str = e.to_string();
                tracing::error!("Failed to process batch for list {}: {}", list_id, err_str);

                // Remove list from tracking if it's not found or completed
                if err_str.contains("not found") || err_str.contains("No pending payments") {
                    tracing::info!("Removing list {} from worker queue", list_id);
                    complete_pending_list(&state.db_pool, list_id).await;
                }
            }
        }
    }

    Ok(processed_count)
}
