use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use near_api::{Chain, NetworkConfig, Reference};
use near_jsonrpc_client::methods;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{
    AppState,
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
            log::error!(
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

/// Look up the transaction hash by querying the block and finding the transaction
/// to the bulk payment contract.
async fn lookup_transaction_hash(
    network: &NetworkConfig,
    block_height: u64,
    contract_id: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    // Query the block first
    let block = Chain::block()
        .at(Reference::AtBlock(block_height))
        .fetch_from(network)
        .await?;

    let client = create_rpc_client(network)?;

    // Search each chunk for transactions to the bulk payment contract
    for chunk_header in &block.chunks {
        let chunk_hash_str = chunk_header.chunk_hash.to_string();

        // Query the chunk using near-jsonrpc-client
        let chunk_request = methods::chunk::RpcChunkRequest {
            chunk_reference: methods::chunk::ChunkReference::ChunkHash {
                chunk_id: chunk_hash_str.parse()?,
            },
        };

        let chunk_response = match client.call(chunk_request).await {
            Ok(chunk) => chunk,
            Err(e) => {
                log::warn!("Failed to fetch chunk {}: {}", chunk_hash_str, e);
                continue;
            }
        };

        // Look for transactions to the bulk payment contract
        for tx in &chunk_response.transactions {
            if tx.receiver_id.as_str() == contract_id {
                return Ok(tx.hash.to_string());
            }
        }
    }

    Err(format!(
        "No transaction to {} found in block {}",
        contract_id, block_height
    )
    .into())
}
