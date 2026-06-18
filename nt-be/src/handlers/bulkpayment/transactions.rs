use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use near_api::NetworkConfig;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{
    AppState,
    handlers::balance_changes::transfer_hints::tx_resolver::resolve_receipt_to_transaction,
    handlers::balance_changes::utils::with_transport_retry,
    utils::cache::{CacheKey, CacheTier},
    utils::jsonrpc::create_rpc_client,
};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentTransaction {
    pub recipient: String,
    pub amount: String,
    pub block_height: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListStatusResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list: Option<ListStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListStatus {
    pub list_id: String,
    pub status: String,
    pub total_payments: u32,
    pub processed_payments: u32,
    pub pending_payments: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionsResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transactions: Option<Vec<PaymentTransaction>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionHashResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_height: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Contract response types (snake_case: deserialized from NEAR contract)
#[derive(Debug, Deserialize, Serialize)]
struct PaymentListResponse {
    token_id: String,
    submitter: String,
    status: PaymentListStatus,
    payments: Vec<ContractPaymentRecord>,
    #[allow(dead_code)]
    created_at: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
#[allow(non_snake_case)]
enum PaymentListStatus {
    Simple(String),
    Enum {
        Pending: Option<()>,
        Approved: Option<()>,
        Rejected: Option<()>,
    },
}

impl PaymentListStatus {
    fn as_str(&self) -> &str {
        match self {
            PaymentListStatus::Simple(s) => s.as_str(),
            PaymentListStatus::Enum {
                Pending: Some(_), ..
            } => "Pending",
            PaymentListStatus::Enum {
                Approved: Some(_), ..
            } => "Approved",
            PaymentListStatus::Enum {
                Rejected: Some(_), ..
            } => "Rejected",
            PaymentListStatus::Enum { .. } => "Unknown",
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct ContractPaymentRecord {
    recipient: String,
    amount: String,
    status: ContractPaymentStatus,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
#[allow(non_snake_case)]
enum ContractPaymentStatus {
    Pending(String),
    Paid { Paid: PaidStatus },
}

#[derive(Debug, Deserialize, Serialize)]
struct PaidStatus {
    block_height: u64,
}

impl ContractPaymentStatus {
    fn is_paid(&self) -> bool {
        matches!(self, ContractPaymentStatus::Paid { .. })
    }

    fn block_height(&self) -> Option<u64> {
        match self {
            ContractPaymentStatus::Paid { Paid: status } => Some(status.block_height),
            _ => None,
        }
    }
}

/// Get the status of a payment list
pub async fn get_list_status(
    State(state): State<Arc<AppState>>,
    Path(list_id): Path<String>,
) -> Result<Json<ListStatusResponse>, (StatusCode, Json<ListStatusResponse>)> {
    let cache_key = CacheKey::new("bulk-payment-status").with(&list_id).build();

    let result = state
        .cache
        .clone()
        .cached_contract_call(CacheTier::ShortTerm, cache_key, async {
            near_api::Contract(state.bulk_payment_contract_id.clone())
                .call_function(
                    "view_list",
                    serde_json::json!({
                        "list_id": list_id,
                    }),
                )
                .read_only::<PaymentListResponse>()
                .fetch_from(&state.network)
                .await
                .map(|r| r.data)
        })
        .await;

    match result {
        Ok(list) => {
            let total = list.payments.len() as u32;
            let processed = list.payments.iter().filter(|p| p.status.is_paid()).count() as u32;
            let pending = total - processed;

            Ok(Json(ListStatusResponse {
                success: true,
                list: Some(ListStatus {
                    list_id,
                    status: list.status.as_str().to_string(),
                    total_payments: total,
                    processed_payments: processed,
                    pending_payments: pending,
                }),
                error: None,
            }))
        }
        Err((status, msg)) => Err((
            status,
            Json(ListStatusResponse {
                success: false,
                list: None,
                error: Some(msg),
            }),
        )),
    }
}

/// Get all payment transactions for a list
pub async fn get_transactions(
    State(state): State<Arc<AppState>>,
    Path(list_id): Path<String>,
) -> Result<Json<TransactionsResponse>, (StatusCode, Json<TransactionsResponse>)> {
    let cache_key = CacheKey::new("bulk-payment-transactions")
        .with(&list_id)
        .build();

    let result = state
        .cache
        .clone()
        .cached_contract_call(CacheTier::LongTerm, cache_key, async {
            near_api::Contract(state.bulk_payment_contract_id.clone())
                .call_function(
                    "get_payment_transactions",
                    serde_json::json!({
                        "list_id": list_id,
                    }),
                )
                .read_only::<Vec<PaymentTransaction>>()
                .fetch_from(&state.network)
                .await
                .map(|r| r.data)
        })
        .await;

    match result {
        Ok(transactions) => Ok(Json(TransactionsResponse {
            success: true,
            transactions: Some(transactions),
            error: None,
        })),
        Err((status, msg)) => Err((
            status,
            Json(TransactionsResponse {
                success: false,
                transactions: None,
                error: Some(msg),
            }),
        )),
    }
}

/// Look up the transaction hash for a specific payment recipient
pub async fn get_transaction_hash(
    State(state): State<Arc<AppState>>,
    Path((list_id, recipient)): Path<(String, String)>,
) -> Result<Json<TransactionHashResponse>, (StatusCode, Json<TransactionHashResponse>)> {
    // First get the list to find the block height
    let list_cache_key = CacheKey::new("bulk-payment-list").with(&list_id).build();

    let list_result = state
        .cache
        .clone()
        .cached_contract_call(CacheTier::LongTerm, list_cache_key, async {
            near_api::Contract(state.bulk_payment_contract_id.clone())
                .call_function(
                    "view_list",
                    serde_json::json!({
                        "list_id": list_id,
                    }),
                )
                .read_only::<PaymentListResponse>()
                .fetch_from(&state.network)
                .await
                .map(|r| r.data)
        })
        .await;

    let list = match list_result {
        Ok(l) => l,
        Err((status, msg)) => {
            return Err((
                status,
                Json(TransactionHashResponse {
                    success: false,
                    transaction_hash: None,
                    block_height: None,
                    error: Some(msg),
                }),
            ));
        }
    };

    // Find the payment for this recipient
    let payment = list.payments.iter().find(|p| p.recipient == recipient);

    let payment = match payment {
        Some(p) => p,
        None => {
            return Err((
                StatusCode::NOT_FOUND,
                Json(TransactionHashResponse {
                    success: false,
                    transaction_hash: None,
                    block_height: None,
                    error: Some(format!(
                        "Recipient {} not found in list {}",
                        recipient, list_id
                    )),
                }),
            ));
        }
    };

    let block_height = match payment.status.block_height() {
        Some(h) => h,
        None => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(TransactionHashResponse {
                    success: false,
                    transaction_hash: None,
                    block_height: None,
                    error: Some(format!(
                        "Payment to {} has not been processed yet",
                        recipient
                    )),
                }),
            ));
        }
    };

    // Look up the transaction hash by querying the block
    let contract_id = state.bulk_payment_contract_id.to_string();
    match lookup_transaction_hash(&state.archival_network, block_height, &contract_id).await {
        Ok(tx_hash) => Ok(Json(TransactionHashResponse {
            success: true,
            transaction_hash: Some(tx_hash),
            block_height: Some(block_height),
            error: None,
        })),
        Err(e) => {
            tracing::error!(
                "Failed to lookup transaction hash for recipient {} in block {}: {}",
                recipient,
                block_height,
                e
            );
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(TransactionHashResponse {
                    success: false,
                    transaction_hash: None,
                    block_height: Some(block_height),
                    error: Some(format!("Failed to lookup transaction hash: {}", e)),
                }),
            ))
        }
    }
}

/// Look up the transaction hash by finding receipt processing on the contract
/// at the given block height, then resolving back to the originating transaction.
///
/// The block_height from the contract is where the receipt executed, which may
/// differ from the block where the transaction was included.
async fn lookup_transaction_hash(
    network: &NetworkConfig,
    block_height: u64,
    contract_id: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    use near_jsonrpc_client::methods;
    use near_primitives::types::{BlockId, BlockReference};
    use near_primitives::views::StateChangeCauseView;

    let client = create_rpc_client(network)?;
    let parsed_contract: near_primitives::types::AccountId = contract_id.parse()?;

    // Find receipt IDs from account changes on the contract at this block
    let changes_response = with_transport_retry("lookup_tx_hash_changes", || {
        let req = methods::EXPERIMENTAL_changes::RpcStateChangesInBlockByTypeRequest {
            block_reference: BlockReference::BlockId(BlockId::Height(block_height)),
            state_changes_request:
                near_primitives::views::StateChangesRequestView::AccountChanges {
                    account_ids: vec![parsed_contract.clone()],
                },
        };
        client.call(req)
    })
    .await?;

    // Check for TransactionProcessing first — if the transaction was sent
    // directly to the contract, the tx hash is immediately available.
    for change in &changes_response.changes {
        if let StateChangeCauseView::TransactionProcessing { tx_hash } = &change.cause {
            return Ok(tx_hash.to_string());
        }
    }

    // Otherwise collect receipt IDs from ReceiptProcessing causes and resolve
    // back to the originating transaction (the tx was in a preceding block).
    let mut receipt_ids = Vec::new();
    for change in &changes_response.changes {
        if let StateChangeCauseView::ReceiptProcessing { receipt_hash } = &change.cause {
            let hash_str = receipt_hash.to_string();
            if !receipt_ids.contains(&hash_str) {
                receipt_ids.push(hash_str);
            }
        }
    }

    for receipt_id in &receipt_ids {
        match resolve_receipt_to_transaction(network, receipt_id, block_height).await {
            Ok(result) => return Ok(result.transaction_hash),
            Err(e) => {
                tracing::debug!(
                    "Failed to resolve receipt {} to transaction: {}",
                    receipt_id,
                    e
                );
                continue;
            }
        }
    }

    Err(format!(
        "No transaction found for {} at block {}",
        contract_id, block_height
    )
    .into())
}

#[cfg(test)]
mod tests {
    use crate::utils::test_utils::init_test_state;
    use axum::extract::{Path, State};
    use std::sync::Arc;

    /// Direct transaction: olskik.near sent payout_batch directly to bulkpayment.near
    /// at block 182925042. Tests the TransactionProcessing fast path.
    #[tokio::test(flavor = "multi_thread")]
    async fn test_get_transaction_hash_direct_tx() {
        let state = init_test_state().await;

        let result = super::get_transaction_hash(
            State(Arc::new(state)),
            Path((
                "d4feb004373547a3e07fb3a54e1ca2b54afbbad789d8e311440f829c51d8b989".to_string(),
                "olskik.near".to_string(),
            )),
        )
        .await
        .expect("Should resolve transaction hash");

        assert!(result.success);
        assert_eq!(
            result.transaction_hash.as_deref(),
            Some("8phBuLVXNqiADhTPuTXFNpbKXhNnGeHPC8xoViAX5nVw"),
        );
    }

    /// Cross-block transaction: megha19.near called payout_batch, but the receipt
    /// executed in a later block (186247356). Tests the ReceiptProcessing → resolve path.
    #[tokio::test(flavor = "multi_thread")]
    async fn test_get_transaction_hash_receipt_in_later_block() {
        let state = init_test_state().await;

        let result = super::get_transaction_hash(
            State(Arc::new(state)),
            Path((
                "b2e7a99a6b2e78a41c707a0a59400e91695b3c491c22e1b0365d8b0c4e64b996".to_string(),
                "megha19.near".to_string(),
            )),
        )
        .await
        .expect("Should resolve transaction hash via receipt resolution");

        assert!(result.success);
        assert_eq!(
            result.transaction_hash.as_deref(),
            Some("6GA6TzTPaGSkbbowgVuL3SH7KKaYcz79ZWetdCLjBgMc"),
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_get_transaction_hash_megdev() {
        let state = init_test_state().await;

        let result = super::get_transaction_hash(
            State(Arc::new(state)),
            Path((
                "0db7b48145f57efac4e8da1327062685597daf4bb144c0366518f9f1feaac184".to_string(),
                "megdev.near".to_string(),
            )),
        )
        .await
        .expect("Should resolve transaction hash");

        assert!(result.success);
        assert_eq!(
            result.transaction_hash.as_deref(),
            Some("6LbWKVUNxQvSFVe1JuRgRiXxFbNmutcZjgqqoDoDBWGL"),
        );
    }
}
